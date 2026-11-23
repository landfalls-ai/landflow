/**
 * SB19: the first draft is a Spotlight call like any other: it goes through the model adapters, so each call (the draft,
 * and its send-back) writes an `ai_usage` row with surface `spotlight` and purpose `answer`; a `litellm/` build goes to
 * the gateway, not to Ollama; an after-run suggestion counts too.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeModels, type FakeReply } from './fake-ai-services';
import { startFakeLiteLlm } from './fake-litellm';

let queue: Array<string | FakeReply> = [];
const fake = await startFakeModels({
  reply: (provider, body) => {
    if (body?.model !== undefined && provider === 'ollama' && !queue.length) return { text: '{"suggestions":[]}' };
    const next = queue.shift() ?? '{}';
    return typeof next === 'string' ? { text: next } : next;
  },
});
const gateway = await startFakeLiteLlm({ models: ['qwen3-coder:30b'] });
const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-flow-builder-metering-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', OLLAMA_URL: fake.url.replace(/\/v1$/, '') };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { corePlugin } = await import('@/lib/server/nodes');
const { registry } = await import('@/lib/server/plugins/registry');
const { database } = await import('@/lib/server/db');
const { aiUsageMeter } = await import('@/lib/server/ai-usage');
const { forgetSpotlightModels } = await import('@/lib/server/assistant/models-list');
const buildRoute = await import('@/app/api/ai/build/route');
const suggestRoute = await import('@/app/api/assistant/suggest/route');

beforeAll(() => registry.registerBuiltin(corePlugin));
afterAll(async () => {
  await fake.close();
  await gateway.close();
  for (const key of [...Object.keys(ENV), 'LANDFLOW_LLM_GATEWAY_URL', 'LANDFLOW_LLM_GATEWAY_KEY']) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});
beforeEach(() => {
  queue = [];
  fake.requests.length = 0;
  forgetSpotlightModels();
  aiUsageMeter().invalidateCaps();
  database().sqlite.exec('DELETE FROM ai_usage');
  delete process.env.LANDFLOW_LLM_GATEWAY_URL;
  delete process.env.LANDFLOW_LLM_GATEWAY_KEY;
});

const rows = () => database().all<{ surface: string | null; purpose: string | null; model: string; provider: string }>('SELECT surface, purpose, model, provider FROM ai_usage ORDER BY at');
const post = (path: string, body: unknown) => new Request(`http://metering.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
type Route = (request: Request) => Promise<Response>;

const draft = (nodes: Array<Record<string, unknown>>) => JSON.stringify({ name: 'Draft', nodes: [{ key: 'start', type: 'core.manualTrigger', name: 'Start', parameters: {} }, ...nodes], connections: nodes.map((n, i) => ({ from: i ? String(nodes[i - 1].key) : 'start', to: n.key })), testData: [{ q: 'one' }] });
const withSet = draft([{ key: 'set', type: 'core.set', name: 'Set', parameters: { mode: 'manual', fields: { field: [{ name: 'a', value: '1' }] } } }]);
const emptyIf = draft([{ key: 'if', type: 'core.if', name: 'Check', parameters: {} }]);

// Integration (sb3): a draft plans first by default (SB13), then one call per step (SB14): a row for every call.
const plan = (steps: Array<{ key: string; type: string; name: string }>) =>
  JSON.stringify({ name: 'Draft', steps: steps.map((st, i) => ({ ...st, does: st.name, ...(i && { from: steps[i - 1].key }) })), assumptions: [], cannot: [] });
const params = (parameters: Record<string, unknown>, testData?: unknown[]) => JSON.stringify({ parameters, ...(testData && { testData }) });

describe('the first draft is counted', () => {
  it('writes an ai_usage row for each call of a draft (the plan, then each step), with surface spotlight, purpose answer and the model', async () => {
    queue = [plan([{ key: 's1', type: 'core.manualTrigger', name: 'Start' }, { key: 's2', type: 'core.set', name: 'Set' }]), params({}, [{ q: 'one' }]), params({ mode: 'manual', fields: { values: [{ name: 'a', value: '1' }] } })];
    const response = await (buildRoute.POST as unknown as Route)(post('/api/ai/build', { prompt: 'a flow with a trigger that sets a field' }));
    expect(response.status).toBe(200);
    const { draft: built } = (await response.json()) as { draft: { calls: number; stages: Array<{ stage: string }> } };
    const calls = fake.requests.filter((r) => r.path === '/api/chat').length;
    expect(built.stages[0].stage).toBe('plan');
    expect(built.calls).toBe(calls);
    expect(rows()).toEqual(Array.from({ length: calls }, () => ({ surface: 'spotlight', purpose: 'answer', provider: 'ollama', model: 'qwen3-coder:30b' })));
  });

  it('writes a row for a step sent back once too', async () => {
    queue = [plan([{ key: 's1', type: 'core.manualTrigger', name: 'Start' }, { key: 's2', type: 'core.if', name: 'Check' }]), params({}), params({ conditions: { condition: [] }, combinator: 'and' }), params({ conditions: { condition: [{ left: '{{ $json.q }}', operator: 'equals', right: 'one' }] }, combinator: 'and' })];
    const response = await (buildRoute.POST as unknown as Route)(post('/api/ai/build', { prompt: 'check something' }));
    expect(response.status).toBe(200);
    const { draft: built } = (await response.json()) as { draft: { calls: number; stages: Array<{ stage: string }> } };
    expect(built.stages.filter((st) => st.stage === 'send-back')).toHaveLength(1);
    const calls = fake.requests.filter((r) => r.path === '/api/chat').length;
    expect(built.calls).toBe(calls);
    expect(rows().map((r) => `${r.surface}/${r.purpose}`)).toEqual(Array.from({ length: calls }, () => 'spotlight/answer'));
  });

  it('the one-shot draft (`staged: false`) writes one row, and two when it is sent back once', async () => {
    queue = [draft([])];
    expect((await (buildRoute.POST as unknown as Route)(post('/api/ai/build', { prompt: 'a flow with a trigger', staged: false }))).status).toBe(200);
    expect(rows()).toEqual([{ surface: 'spotlight', purpose: 'answer', provider: 'ollama', model: 'qwen3-coder:30b' }]);
    database().sqlite.exec('DELETE FROM ai_usage');
    fake.requests.length = 0;
    queue = [emptyIf, withSet];
    expect((await (buildRoute.POST as unknown as Route)(post('/api/ai/build', { prompt: 'check something', staged: false }))).status).toBe(200);
    expect(fake.requests.filter((r) => r.path === '/api/chat')).toHaveLength(2);
    expect(rows().map((r) => `${r.surface}/${r.purpose}`)).toEqual(['spotlight/answer', 'spotlight/answer']);
  });

  it('sends a litellm/ build to the gateway, not to Ollama', async () => {
    process.env.LANDFLOW_LLM_GATEWAY_URL = gateway.origin;
    process.env.LANDFLOW_LLM_GATEWAY_KEY = 'sk-fake-master';
    // The fake gateway answers with text that is no draft: the build fails, but the call went to the gateway and was counted.
    const response = await (buildRoute.POST as unknown as Route)(post('/api/ai/build', { prompt: 'set a field', model: 'litellm/qwen3-coder:30b' }));
    expect(fake.requests.filter((r) => r.path === '/api/chat')).toHaveLength(0);
    expect(gateway.requests.some((r) => r.path === '/v1/chat/completions')).toBe(true);
    expect(response.status).toBe(502);
    expect(rows().map((r) => `${r.surface}/${r.provider}`)).toContain('spotlight/litellm');
  });
});

describe('an after-run suggestion is counted', () => {
  it('writes one row with surface spotlight', async () => {
    queue = ['{"suggestions":[]}'];
    const workflow = { name: 'W', nodes: [{ id: 'a', name: 'Set', type: 'core.set', typeVersion: 1, position: [0, 0], parameters: {} }], connections: [] };
    const run = { status: 'error', error: { message: 'boom' } };
    const response = await (suggestRoute.POST as unknown as Route)(post('/api/assistant/suggest', { workflow, nodeId: 'a', run }));
    expect(response.status).toBe(200);
    expect(rows().map((r) => `${r.surface}/${r.purpose}`)).toEqual(['spotlight/answer']);
  });
});
