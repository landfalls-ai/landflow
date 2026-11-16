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

describe('the first draft is counted', () => {
  it('writes one ai_usage row for a draft, with surface spotlight, purpose answer and the model', async () => {
    queue = [draft([])];
    const response = await (buildRoute.POST as unknown as Route)(post('/api/ai/build', { prompt: 'a flow with a trigger' }));
    expect(response.status).toBe(200);
    expect(rows()).toEqual([{ surface: 'spotlight', purpose: 'answer', provider: 'ollama', model: 'qwen3-coder:30b' }]);
  });

  it('writes two rows when the draft is sent back once', async () => {
    queue = [emptyIf, withSet];
    const response = await (buildRoute.POST as unknown as Route)(post('/api/ai/build', { prompt: 'check something' }));
    expect(response.status).toBe(200);
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
