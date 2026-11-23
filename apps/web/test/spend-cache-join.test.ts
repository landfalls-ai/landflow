/**
 * Join test (wave 12, carryover §2, `spend-cache-join`): SP19's cache layout and agent draft ↔ SP22's exact counter ↔
 * SP05's cache line and `previous`. Each package tested its side with fakes; here two real workflow runs of one agent
 * (Run an Agent; three loop steps with a `remember` in the first run, then a second run) go through the real Anthropic
 * adapter to SP19's fake prompt cache, the host's real parts listener counts each call's parts through SP22's fake count
 * endpoint (both fakes behind one base URL, as Anthropic serves both paths), and SP05's real routes read the result.
 * Offline; runs by default.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import { startFakeAnthropicCache } from './fake-anthropic-cache';
import { startFakeAnthropicCount } from './fake-anthropic-count';

vi.setConfig({ testTimeout: 60_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-spend-cache-join-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AI_PARTS_COUNT: 'exact' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

// The host's registrations (lesson 10): the recorded-call listener is the one runtime.ts sets.
await import('@/lib/server/runtime');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { runWorkflow } = await import('@/lib/server/runner');
const { agentStore } = await import('@/lib/server/agents/store');
const { database } = await import('@/lib/server/db');
const spendRoute = await import('@/app/api/executions/[id]/spend/route');
const callRoute = await import('@/app/api/ai-calls/[id]/route');

registry.registerBuiltin(corePlugin);

/** Words of the prompt that must never be stored or answered. */
const INSTRUCTIONS = 'Always consult the zephyrine quokkas and the marsupial ledger before answering any question about burrows. '.repeat(48);
const FACT = 'prefers answers about hibernating wombats';
const PROMPT_WORDS = ['zephyrine', 'quokkas', 'marsupial', 'wombats', 'hibernating', 'burrows'];

let runIndex = 0;
let toolSeq = 0;
const cache = await startFakeAnthropicCache(({ body }) => {
  const results = (body.messages as Array<{ content: unknown }>).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b: { type?: string }) => b.type === 'tool_result').length;
  const use = (name: string, input: Record<string, unknown>) => ({ content: [{ type: 'tool_use', id: `toolu_${++toolSeq}`, name, input }] });
  if (results === 0) return use('Echo', { word: 'ping' });
  if (results === 1 && runIndex === 0) return use('remember', { fact: FACT });
  return { content: [{ type: 'text', text: 'Done.' }] };
});
const count = await startFakeAnthropicCount();
/** Anthropic's one base URL: the count endpoint to SP22's fake, the messages to SP19's. */
const router = createServer((req, res) => {
  const target = new URL((req.url ?? '').split('?')[0] === '/v1/messages/count_tokens' ? count.url : cache.url);
  const upstream = httpRequest({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);
  });
  req.pipe(upstream);
});
await new Promise<void>((resolve) => router.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${(router.address() as AddressInfo).port}`;

afterAll(async () => {
  await cache.close();
  await count.close();
  await new Promise<void>((resolve) => router.close(() => resolve()));
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const claude = credentials.create({ name: 'Fake Claude', type: 'core.anthropicApi', data: { apiKey: 'sk-ant-test', baseUrl } });
const agent = agentStore.create({
  name: 'Burrow desk',
  instructions: INSTRUCTIONS,
  model: { provider: 'anthropic', model: 'claude-sonnet-4-6', credential: { id: claude.id, name: claude.name } },
  memory: { crossSession: true },
  tools: [{ id: 't_echo', type: 'node', name: 'Echo', description: 'Echo the input word back', nodeType: 'core.noOp', parameters: {} }],
} as never);
agentStore.publish(agent.id);

const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });
const workflow: Workflow = {
  id: 'wf_spend_cache_join',
  name: 'Spend cache join',
  nodes: [node('Start', 'core.manualTrigger'), node('Ask', 'core.messageAgent', { agentId: agent.id, message: 'Where do the quokkas sleep?', conversation: 'new' })],
  connections: [{ id: 'Start-Ask', type: 'main', source: 'Start', target: 'Ask', sourceIndex: 0, targetIndex: 0 }],
} as Workflow;
store.saveWorkflow(workflow);

interface Row {
  id: string;
  iteration: number | null;
  input_tokens: number;
}
interface Parts {
  usage_id: string;
  method: string;
  input_tokens: number;
  parts: string;
  prefix_hash: string;
  part_hashes: string;
}

const get = async (route: { GET: unknown }, id: string) => {
  const response = await (route.GET as (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>)(new Request(`http://landflow.test/${id}`), { params: Promise.resolve({ id }) });
  return { status: response.status, text: await response.clone().text(), body: await response.json() };
};

/** Runs the flow and waits for the listener to write a split for each of its chat calls. */
async function run() {
  const record = await runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start' });
  expect(record.error?.message ?? record.status).toBe('success');
  const rows = database().all<Row>("SELECT id, iteration, input_tokens FROM ai_usage WHERE execution_id = ? AND operation = 'chat' ORDER BY iteration", record.executionId);
  const parts = () => database().all<Parts>(`SELECT * FROM ai_call_parts WHERE usage_id IN (${rows.map(() => '?').join(',')})`, ...rows.map((r) => r.id));
  for (let i = 0; i < 300 && parts().length < rows.length; i++) await new Promise((r) => setTimeout(r, 20));
  const byUsage = new Map(parts().map((p) => [p.usage_id, p]));
  return { executionId: record.executionId, rows, parts: rows.map((r) => byUsage.get(r.id)!) };
}

describe('spend-cache-join: the cache layout, the exact count and the cache line', () => {
  it('two runs: three cache points at most, counted splits, one prefix, memory moves and the instructions do not, a hit rate and no miss', async () => {
    runIndex = 0;
    const first = await run();
    runIndex = 1;
    const second = await run();
    expect(first.rows.map((r) => r.iteration)).toEqual([1, 2, 3]);
    expect(second.rows.map((r) => r.iteration)).toEqual([1, 2]);
    expect(cache.calls).toHaveLength(5);

    // SP19: never more than three cache points; the cache is read from the second call on.
    expect(Math.max(...cache.calls.map((c) => c.breakpoints))).toBeLessThanOrEqual(3);
    expect(cache.calls.slice(1).every((c) => c.cacheRead > 0)).toBe(true);
    // SP22: every split counted by the provider (the count endpoint was asked), its parts plus formatting the input.
    expect(count.requests.length).toBeGreaterThan(0);
    const all = [...first.parts, ...second.parts];
    const allRows = [...first.rows, ...second.rows];
    expect(all.every(Boolean)).toBe(true);
    all.forEach((p, i) => {
      expect(p.method, `call ${i}`).toBe('provider');
      const parts = JSON.parse(p.parts) as Record<string, number>;
      expect(Object.values(parts).reduce((a, b) => a + b, 0), `call ${i}`).toBe(p.input_tokens);
      expect(p.input_tokens).toBe(allRows[i]!.input_tokens);
      expect(parts.instructions, `call ${i}`).toBeGreaterThan(0);
    });
    // SP19 ↔ SP22: one stable prefix across the iterations and the two runs; the remember moves the memory, not the instructions.
    expect(new Set(all.map((p) => p.prefix_hash)).size).toBe(1);
    const hashes = (p: Parts) => JSON.parse(p.part_hashes) as Record<string, string>;
    expect(hashes(second.parts[0]!).memory).not.toBe(hashes(first.parts[0]!).memory);
    expect(hashes(second.parts[0]!).instructions).toBe(hashes(first.parts[0]!).instructions);

    // SP05: the run's cache line and the second iteration's view.
    for (const { executionId } of [first, second]) {
      const spend = await get(spendRoute, executionId);
      expect(spend.status).toBe(200);
      expect(spend.body.cache.hitRate).toBeGreaterThan(0);
      expect(spend.body.cache.missCalls).toBe(0);
      expect(spend.body.composition.method).toBe('provider');
      for (const word of PROMPT_WORDS) expect(spend.text.toLowerCase()).not.toContain(word);
    }
    const view = await get(callRoute, first.rows[1]!.id);
    expect(view.status).toBe(200);
    expect(view.body.previous).toMatchObject({ usageId: first.rows[0]!.id, samePrefix: true });
    expect(view.body.parts).toMatchObject({ source: 'landflow', method: 'provider' });
    for (const word of PROMPT_WORDS) expect(view.text.toLowerCase()).not.toContain(word);

    // No prompt word in any stored row.
    const stored = JSON.stringify([database().all('SELECT * FROM ai_usage WHERE execution_id IN (?, ?)', first.executionId, second.executionId), all]).toLowerCase();
    for (const word of PROMPT_WORDS) expect(stored).not.toContain(word);
  });
});
