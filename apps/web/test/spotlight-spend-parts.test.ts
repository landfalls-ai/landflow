/**
 * Carried from wave 11 (carryover-w12.md §4, carryover-sb1.md §1): a Spotlight chat call and an Agent architect call on
 * a local model each write their `ai_call_parts` row, as the agent runs do (spend-parts-join.test.ts). The unit form of
 * the live check: a fake Ollama answers, and the listener the host registers (lib/server/runtime.ts) writes the parts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Workflow } from '@landflow/engine';
import { startFakeModels, type FakeReply } from './fake-ai-services';

const queue: FakeReply[] = [];
const fake = await startFakeModels({ reply: (provider) => (provider === 'ollama' ? (queue.shift() ?? { text: 'Done.' }) : {}) });
const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-spotlight-parts-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', OLLAMA_URL: fake.url.replace(/\/v1$/, '') };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

// The host's registrations (lesson 10): the recorded-call listener is the one runtime.ts sets.
await import('@/lib/server/runtime');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { runChat } = await import('@/lib/server/assistant/chat');
const designRoute = await import('@/app/api/agents/design/route');
const { database } = await import('@/lib/server/db');
registry.registerBuiltin(corePlugin);

afterAll(async () => {
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

/** The listener writes after the call returns (setImmediate): wait for it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
type Usage = { id: string; surface: string; input_tokens: number };
const usageOf = (surface: string) => database().all<Usage>('SELECT id, surface, input_tokens FROM ai_usage WHERE surface = ?', surface);
const partsOf = (ids: string[]) => (ids.length ? database().all<{ usage_id: string; input_tokens: number }>(`SELECT usage_id, input_tokens FROM ai_call_parts WHERE usage_id IN (${ids.map(() => '?').join(',')})`, ...ids) : []);

const flow: Workflow = { id: 'wf_parts', name: 'Parts', nodes: [{ id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }], connections: [] };

describe('Spotlight and the Agent architect write a parts row per call', () => {
  it('a Spotlight chat call on Ollama', async () => {
    queue.length = 0;
    queue.push({ text: 'It starts by hand.', usage: { input: 900, output: 6 } });
    await runChat({ messages: [{ role: 'user', content: 'what starts this flow?' }], workflow: flow, model: 'qwen3-coder:30b', types: registry.nodeTypes().filter((t) => t.pluginId === 'core'), onEvent: () => {} });
    await settle();
    const usage = usageOf('spotlight');
    expect(usage.length).toBeGreaterThanOrEqual(1);
    const parts = partsOf(usage.map((u) => u.id));
    for (const row of usage) expect(parts.find((p) => p.usage_id === row.id)?.input_tokens, row.id).toBe(row.input_tokens);
  });

  it('an architect call on Ollama (POST /api/agents/design)', async () => {
    queue.length = 0;
    queue.push({ toolCalls: [{ id: 'c1', name: 'propose_design', arguments: { name: 'Docs Answerer', role: 'Docs answerer', instructions: 'Answer from the docs.' } }], usage: { input: 1200, output: 40 } }, { text: 'Drafted.', usage: { input: 1300, output: 3 } });
    const res = await designRoute.POST(new Request('http://localhost/api/agents/design', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Docs Answerer', description: 'Answers from our docs' }) }));
    expect(res.status).toBe(201);
    await settle();
    const usage = usageOf('architect');
    expect(usage.length).toBeGreaterThanOrEqual(1);
    const parts = partsOf(usage.map((u) => u.id));
    for (const row of usage) expect(parts.find((p) => p.usage_id === row.id)?.input_tokens, row.id).toBe(row.input_tokens);
  });
});
