/**
 * Join test (wave 11, carryover §2): SP01's meter (`notifyRecorded`) ↔ SP03's listener (`writeParts`, registered by
 * lib/server/runtime.ts). SP03 tested its side with a scripted model standing in for the meter; here a real agent run
 * on the real Anthropic adapter (a fake server answering cache numbers) goes through the real meter, and the listener
 * the host registers writes the parts. Nothing sits between the two sides.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { startFakeModels } from './fake-ai-services';
import { startFakeLiteLlm } from './fake-litellm';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-spend-parts-join-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

// The host's registrations (lesson 10): the recorded-call listener is the one runtime.ts sets, not a test's.
await import('@/lib/server/runtime');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { credentials } = await import('@/lib/server/credentials/vault');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession, runAgent } = await import('@/lib/server/agents/runtime');
const { aiUsageMeter } = await import('@/lib/server/ai-usage');
const { database } = await import('@/lib/server/db');

registry.registerBuiltin(corePlugin);

const toolResults = (messages: Array<{ content?: unknown }> = []) => messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p: { type?: string }) => p.type === 'tool_result').length;

/** Echo twice, then answer: three chat calls, each with prompt-cache numbers. */
const fake = await startFakeModels({
  reply: (provider, body) => {
    if (provider !== 'anthropic') return undefined;
    const done = toolResults(body.messages);
    if (body.tools?.length && done < 2) return { toolCalls: [{ id: `call_${done + 1}`, name: 'Echo', arguments: { word: 'ping' } }], usage: { input: 50 + done * 10, output: 5, cacheRead: 400 * done, cacheWrite: done ? 20 : 400 } };
    return { text: 'Done.', usage: { input: 80, output: 4, cacheRead: 800, cacheWrite: 30 } };
  },
});
const lite = await startFakeLiteLlm({ models: ['claude-join'] });
const virtual = lite.addKey({ key_alias: 'landflow-parts-join' }).key;

const anthropic = credentials.create({ name: 'Fake Claude', type: 'core.anthropicApi', data: { apiKey: 'sk-ant-test', baseUrl: fake.origin } });
const gateway = credentials.create({ name: 'Fake gateway', type: 'core.anthropicApi', data: { apiKey: virtual, baseUrl: lite.origin, gateway: 'litellm' } });
const ref = (c: { id: string; name: string }) => ({ id: c.id, name: c.name });

afterAll(async () => {
  await fake.close();
  await lite.close();
  for (const key of [...Object.keys(ENV), 'LANDFLOW_LLM_GATEWAY_URL']) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

/** The listener writes after the call returns (setImmediate): wait for it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
type PartsRow = Record<string, unknown> & { usage_id: string; input_tokens: number; parts: string; method: string };
const partsOf = (usageIds: string[]) => (usageIds.length ? database().all<PartsRow>(`SELECT * FROM ai_call_parts WHERE usage_id IN (${usageIds.map(() => '?').join(',')})`, ...usageIds) : []);

/** Words of the prompt that must never be stored: the instructions, the memory-free system line's name, the question. */
const INSTRUCTIONS = 'Always consult the zephyrine quokkas before answering.';
const QUESTION = 'Where do marsupial wombats hibernate during winter?';
const promptWords = [INSTRUCTIONS, QUESTION, 'Echo the input word back'].flatMap((t) => t.match(/[A-Za-z]{5,}/g) ?? []).map((w) => w.toLowerCase());

describe('spend-parts-join: the meter tells the parts listener', () => {
  it('an agent run of three calls writes one estimated split per call, keyed by its usage row, with no prompt words', async () => {
    const agent = agentStore.create({
      name: 'Parts desk',
      instructions: INSTRUCTIONS,
      model: { provider: 'anthropic', model: 'claude-join', credential: ref(anthropic) },
      tools: [{ id: 't_echo', type: 'node', name: 'Echo', description: 'Echo the input word back', nodeType: 'core.noOp', parameters: {} }],
    } as never);
    const session = newSession(agent, { source: 'test', userId: 'usr_parts_join', version: 'draft' });
    const result = await runAgent({ agent, session, message: QUESTION });
    expect(result.reason).toBe('completed');
    await settle();

    const usage = database().all<Record<string, unknown> & { id: string; input_tokens: number; cache_read_tokens: number; iteration: number }>("SELECT * FROM ai_usage WHERE session_id = ? AND operation = 'chat' ORDER BY iteration", session.id);
    expect(usage.map((u) => u.iteration)).toEqual([1, 2, 3]);
    // The adapter's cache numbers reached the meter (the whole prompt is input; cache reads are part of it).
    expect(usage.map((u) => u.cache_read_tokens)).toEqual([0, 400, 800]);

    const parts = partsOf(usage.map((u) => u.id));
    expect(parts).toHaveLength(3);
    for (const row of usage) {
      const split = parts.find((p) => p.usage_id === row.id)!;
      expect(split, row.id).toBeDefined();
      expect(split.method).toBe('estimate');
      expect(split.input_tokens).toBe(row.input_tokens);
      const counts = JSON.parse(split.parts) as Record<string, number>;
      expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(row.input_tokens);
    }
    // No word of the prompt in any column of the parts rows, nor of the usage rows.
    const stored = [...parts, ...usage].flatMap((r) => Object.values(r).map((v) => String(v ?? ''))).join(' ').toLowerCase();
    for (const word of promptWords) expect(stored, word).not.toContain(word);
  });

  it('a call that takes over an imported gateway row gets its parts too, keyed by the imported row', async () => {
    process.env.LANDFLOW_LLM_GATEWAY_URL = lite.origin;
    // The spend import ran between the gateway logging the call and Landflow recording it: the row is already there.
    const imported: string[] = [];
    const push = lite.spendLogs.push.bind(lite.spendLogs);
    lite.spendLogs.push = (...logs) => {
      for (const log of logs) {
        const id = `au_imported_${imported.length + 1}`;
        imported.push(id);
        database().insertNew('ai_usage', { id, at: new Date().toISOString(), day: aiUsageMeter().today(), source: 'litellm', runtime: 'litellm', provider: 'litellm', model: 'claude-join', operation: 'chat', input_tokens: 12, output_tokens: 8, cost: 0.001, gateway_request_id: log.request_id });
      }
      return push(...logs);
    };
    try {
      const agent = agentStore.create({ name: 'Gateway desk', instructions: INSTRUCTIONS, model: { provider: 'anthropic', model: 'claude-join', credential: ref(gateway) } } as never);
      const session = newSession(agent, { source: 'test', userId: 'usr_parts_join', version: 'draft' });
      expect((await runAgent({ agent, session, message: QUESTION })).reason).toBe('completed');
      await settle();
    } finally {
      lite.spendLogs.push = push;
    }
    expect(imported).toHaveLength(1);
    const [row] = database().all<{ id: string; session_id: string | null; gateway_request_id: string; input_tokens: number }>('SELECT id, session_id, gateway_request_id, input_tokens FROM ai_usage WHERE id = ?', imported[0]!);
    // Taken over, not duplicated.
    expect(row?.session_id).toBeTruthy();
    expect(database().all('SELECT id FROM ai_usage WHERE gateway_request_id = ?', row!.gateway_request_id)).toHaveLength(1);
    const [split] = partsOf([row!.id]);
    expect(split).toMatchObject({ usage_id: row!.id, gateway_request_id: row!.gateway_request_id, method: 'estimate', input_tokens: row!.input_tokens });
    const stored = Object.values(split!).map((v) => String(v ?? '')).join(' ').toLowerCase();
    for (const word of promptWords) expect(stored, word).not.toContain(word);
  });
});
