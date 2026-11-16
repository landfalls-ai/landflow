/**
 * The gateway's split of a model call (docs/llm-gateway.md, "The gateway's split"; lib/server/llm-gateway/parts-receiver.ts,
 * POST /api/gateway-parts): signature, closed body, one row per request id, `usage_id` filled whichever of the post and
 * the spend import arrives first, and a Landflow split of the same call winning in every order.
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeLiteLlm, type FakeLiteLlm } from './fake-litellm';

const { database } = await import('@/lib/server/db');
const route = await import('@/app/api/gateway-parts/route');
const { importSpend } = await import('@/lib/server/llm-gateway/ingest');
const { saveGatewaySettings, saveIngestStatus } = await import('@/lib/server/llm-gateway/settings');
const { hashParts } = await import('@/lib/server/ai-usage/parts');
const { isPublicPath, PUBLIC_ROUTES } = await import('@/lib/shared/auth-paths');
const { hashKey } = await import('@/lib/server/llm-gateway/client');

const SECRET = 'landflow-dev-parts-only';
const URL_ = 'http://landflow.test/api/gateway-parts';
let seq = 0;
const fresh = (prefix: string) => `${prefix}_${process.pid}_${++seq}`;

const sign = (body: string, t = Math.floor(Date.now() / 1000), secret = SECRET) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const goodBody = (requestId: string, extra: Record<string, unknown> = {}) => ({
  requestId,
  at: '2026-11-20T10:00:00.000Z',
  model: 'qwen3-coder:30b',
  provider: 'ollama_chat',
  method: 'tokenizer',
  inputTokens: 40,
  parts: { instructions: 20, toolDefinitions: 10, userMessage: 6, formatting: 4 },
  prefixHash: 'a1b2c3d4e5f60718',
  promptHash: '0f1e2d3c4b5a6978',
  partHashes: { instructions: '1111222233334444', userMessage: 'aaaabbbbccccdddd' },
  toolNames: ['read_file', 'bash'],
  ...extra,
});
const post = (body: unknown, headers: Record<string, string> | 'signed' = 'signed') => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return route.POST(new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json', ...(headers === 'signed' ? { 'x-landflow-signature': sign(raw) } : headers) }, body: raw }));
};
interface PartsRow {
  id: string;
  usage_id: string | null;
  gateway_request_id: string | null;
  source: string;
  method: string;
  parts: string;
  tool_names: string | null;
}
const byRequest = (requestId: string) => database().all<PartsRow>('SELECT * FROM ai_call_parts WHERE gateway_request_id = ?', requestId);
const byUsage = (usageId: string) => database().all<PartsRow>('SELECT * FROM ai_call_parts WHERE usage_id = ?', usageId);
const usageRows = (requestId: string) => database().all<{ id: string }>('SELECT id FROM ai_usage WHERE gateway_request_id = ?', requestId);

const saved = process.env.LANDFLOW_LLM_GATEWAY_PARTS_SECRET;
beforeAll(() => {
  process.env.LANDFLOW_LLM_GATEWAY_PARTS_SECRET = SECRET;
});
afterAll(() => {
  if (saved === undefined) delete process.env.LANDFLOW_LLM_GATEWAY_PARTS_SECRET;
  else process.env.LANDFLOW_LLM_GATEWAY_PARTS_SECRET = saved;
});

describe('POST /api/gateway-parts', () => {
  it('stores a signed split: 204 and a gateway row with only numbers and hashes', async () => {
    const id = fresh('chatcmpl');
    const response = await post(goodBody(id));
    expect(response.status).toBe(204);
    const [row] = byRequest(id);
    expect(row).toMatchObject({ source: 'gateway', method: 'tokenizer', usage_id: null });
    expect(JSON.parse(row!.parts)).toEqual({ instructions: 20, toolDefinitions: 10, userMessage: 6, formatting: 4 });
    expect(JSON.parse(row!.tool_names!)).toEqual(['read_file', 'bash']);
  });

  it('takes a replay as a no-op: one row', async () => {
    const id = fresh('chatcmpl');
    expect((await post(goodBody(id))).status).toBe(204);
    expect((await post(goodBody(id, { inputTokens: 99 }))).status).toBe(204);
    expect(byRequest(id)).toHaveLength(1);
    expect(database().get<{ input_tokens: number }>('SELECT input_tokens FROM ai_call_parts WHERE gateway_request_id = ?', id)?.input_tokens).toBe(40);
  });

  it('answers 401 for a bad, missing, old or future signature, always with the same body', async () => {
    const raw = JSON.stringify(goodBody(fresh('chatcmpl')));
    const now = Math.floor(Date.now() / 1000);
    const bodies: unknown[] = [];
    for (const header of [sign(raw, now, 'another-secret'), 'garbage', '', sign(raw, now - 301), sign(raw, now + 301), sign(raw + ' ', now)]) {
      const response = await post(raw, header ? { 'x-landflow-signature': header } : {});
      expect(response.status).toBe(401);
      bodies.push(await response.json());
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(byRequest(JSON.parse(raw).requestId)).toHaveLength(0);
    // A signature just inside the window is good.
    expect((await post(raw, { 'x-landflow-signature': sign(raw, now - 290) })).status).toBe(204);
  });

  it('answers 400 for a key outside the contract, text-like values, long strings and bad numbers', async () => {
    const id = fresh('chatcmpl');
    for (const bad of [
      goodBody(id, { prompt: 'what the user typed' }),
      goodBody(id, { parts: { instructions: 5, text: 3 } }),
      goodBody(id, { partHashes: { instructions: 'You are a careful agent.' } }),
      goodBody(id, { prefixHash: 'x'.repeat(201) }),
      goodBody(id, { model: 'm'.repeat(201) }),
      goodBody(id, { toolNames: ['t'.repeat(201)] }),
      goodBody(id, { parts: { instructions: -1 } }),
      goodBody(id, { parts: { instructions: 1.5 } }),
      goodBody(id, { method: 'guess' }),
      goodBody(id, { at: 'not a time' }),
      'not json',
    ]) {
      expect((await post(bad)).status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
    expect(byRequest(id)).toHaveLength(0);
  });

  it('answers 413 over 32 KB, and 404 while the secret is unset', async () => {
    const big = goodBody(fresh('chatcmpl'), { toolNames: Array.from({ length: 200 }, () => 'n'.repeat(190)) });
    expect((await post(big)).status).toBe(413);
    delete process.env.LANDFLOW_LLM_GATEWAY_PARTS_SECRET;
    try {
      expect((await post(goodBody(fresh('chatcmpl')))).status).toBe(404);
    } finally {
      process.env.LANDFLOW_LLM_GATEWAY_PARTS_SECRET = SECRET;
    }
  });

  it('is public by its signature and nothing else changed', () => {
    expect(isPublicPath('/api/gateway-parts')).toBe(true);
    expect(isPublicPath('/api/gateway-parts/extra')).toBe(true);
    expect(isPublicPath('/api/ai-calls')).toBe(false);
    expect(isPublicPath('/api/gateway-partsx')).toBe(false);
    expect(PUBLIC_ROUTES.at(-1)).toBe('/api/gateway-parts');
  });
});

describe('with the spend import', () => {
  let litellm: FakeLiteLlm;
  let ownKey: string;
  const ENV = ['LANDFLOW_LLM_GATEWAY_URL', 'LANDFLOW_LLM_GATEWAY_ADMIN_KEY', 'LANDFLOW_LLM_GATEWAY_KEY', 'LANDFLOW_LLM_GATEWAY_CLUSTER_URL'];
  const previous: Record<string, string | undefined> = {};
  const later = () => Date.now() + 5 * 60_000;
  const call = async (key: string, headers: Record<string, string> = {}) => {
    await fetch(`${litellm.origin}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers }, body: JSON.stringify({ model: 'qwen3-coder:30b', messages: [{ role: 'user', content: 'hello' }] }) });
    return litellm.spendLogs.at(-1)!;
  };
  /** A Landflow split of a call (SP03's row), keyed by its usage row. */
  const landflowSplit = (usageId: string, gatewayRequestId?: string) =>
    database().insertNew('ai_call_parts', { id: fresh('acp'), usage_id: usageId, gateway_request_id: gatewayRequestId ?? null, at: new Date().toISOString(), source: 'landflow', method: 'estimate', input_tokens: 30, parts: JSON.stringify({ history: 30 }) });

  beforeAll(async () => {
    litellm = await startFakeLiteLlm({ costPerCall: 0.002, usage: { input: 30, output: 10 } });
    for (const name of ENV) previous[name] = process.env[name];
    ownKey = litellm.addKey({ key_alias: 'landflow-own-parts' }).key;
    process.env.LANDFLOW_LLM_GATEWAY_URL = litellm.origin;
    process.env.LANDFLOW_LLM_GATEWAY_ADMIN_KEY = litellm.masterKey;
    process.env.LANDFLOW_LLM_GATEWAY_KEY = ownKey;
  });
  afterAll(async () => {
    for (const name of ENV) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await litellm.close();
  });
  beforeEach(() => {
    litellm.spendLogs.length = 0;
    saveGatewaySettings({ ingest: true });
    saveIngestStatus({ enabled: false, imported: 0, skipped: 0, totalImported: 0 });
  });

  it('fills usage_id when the import arrives after the split', async () => {
    const member = litellm.addKey({ key_alias: fresh('member') }).key;
    const spend = await call(member);
    expect((await post(goodBody(spend.request_id))).status).toBe(204);
    expect(byRequest(spend.request_id)[0]!.usage_id).toBeNull();
    await importSpend({ now: later() });
    const [usage] = usageRows(spend.request_id);
    expect(usage).toBeDefined();
    expect(byRequest(spend.request_id)).toHaveLength(1);
    expect(byRequest(spend.request_id)[0]).toMatchObject({ usage_id: usage!.id, source: 'gateway' });
    expect(byUsage(usage!.id)).toHaveLength(1);
  });

  it('fills usage_id when the split arrives after the import', async () => {
    const member = litellm.addKey({ key_alias: fresh('member') }).key;
    const spend = await call(member);
    await importSpend({ now: later() });
    const [usage] = usageRows(spend.request_id);
    expect((await post(goodBody(spend.request_id))).status).toBe(204);
    expect(byRequest(spend.request_id)[0]).toMatchObject({ usage_id: usage!.id, source: 'gateway' });
  });

  it('attaches a waiting split to a row the meter wrote first, which has no split of its own', async () => {
    const member = litellm.addKey({ key_alias: fresh('member') }).key;
    const spend = await call(member);
    const id = fresh('au');
    database().insertNew('ai_usage', { id, at: new Date().toISOString(), day: new Date().toISOString().slice(0, 10), provider: 'litellm', model: 'qwen3-coder:30b', operation: 'chat', input_tokens: 30, output_tokens: 10, cost: 0, source: 'landflow', runtime: 'landflow', gateway_request_id: spend.request_id });
    expect((await post(goodBody(spend.request_id))).status).toBe(204);
    expect(byRequest(spend.request_id)).toHaveLength(1);
    expect(byRequest(spend.request_id)[0]).toMatchObject({ usage_id: id, source: 'gateway' });
    await importSpend({ now: later() });
    expect(byUsage(id)).toHaveLength(1);
  });

  it('keeps a Landflow split that holds the usage row: the gateway post is a no-op', async () => {
    const member = litellm.addKey({ key_alias: fresh('member') }).key;
    const spend = await call(member);
    await importSpend({ now: later() });
    const [usage] = usageRows(spend.request_id);
    landflowSplit(usage!.id);
    expect((await post(goodBody(spend.request_id))).status).toBe(204);
    expect(byRequest(spend.request_id)).toHaveLength(0);
    expect(byUsage(usage!.id)).toEqual([expect.objectContaining({ source: 'landflow' })]);
  });

  it('on the takeover of a Landflow row: drops the waiting gateway split when Landflow has its own, else fills usage_id', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const landflowRow = (callId: string, serverKey: string) => {
      const id = fresh('au');
      database().insertNew('ai_usage', { id, at: new Date().toISOString(), day, provider: 'litellm', model: 'qwen3-coder:30b', operation: 'chat', input_tokens: 30, output_tokens: 10, cost: 0, source: 'landflow', runtime: 'landflow', call_id: callId, gateway_key_hash: hashKey(serverKey) });
      return id;
    };
    // Landflow's split first, then the gateway posts, then the import takes the Landflow row over by its call id.
    const withSplit = await call(ownKey);
    const own = landflowRow(withSplit.litellm_call_id ?? withSplit.request_id, ownKey);
    landflowSplit(own);
    expect((await post(goodBody(withSplit.request_id))).status).toBe(204);
    expect(byRequest(withSplit.request_id)).toHaveLength(1);
    expect(byRequest(withSplit.request_id)[0]!.usage_id).toBeNull();
    await importSpend({ now: later() });
    expect(byRequest(withSplit.request_id)).toHaveLength(0);
    expect(byUsage(own)).toEqual([expect.objectContaining({ source: 'landflow' })]);
    expect(usageRows(withSplit.request_id)).toEqual([{ id: own }]);

    // No Landflow split: the waiting gateway split is attached to the Landflow row.
    const without = await call(ownKey);
    const ownTwo = landflowRow(without.litellm_call_id ?? without.request_id, ownKey);
    expect((await post(goodBody(without.request_id))).status).toBe(204);
    await importSpend({ now: later() });
    expect(usageRows(without.request_id)).toEqual([{ id: ownTwo }]);
    expect(byRequest(without.request_id)[0]).toMatchObject({ usage_id: ownTwo, source: 'gateway' });
    expect(byUsage(ownTwo)).toHaveLength(1);
  });
});

describe('the hashes', () => {
  // The same segments and key the gateway's Python test pins (deploy/llm-gateway/tests/test_custom_callbacks.py).
  const key = createHash('sha256').update(`landflow-parts-hash:${SECRET}`).digest();
  const segments = [
    { where: 'tools', part: 'toolDefinitions', text: '{"name":"read_file","description":"Reads a file — naïve","input_schema":{"type":"object"}}' },
    { where: 'tools', part: 'toolDefinitions', text: '{"name":"bash"}', breakpoint: true },
    { where: 'system', part: 'instructions', text: 'You are a careful agent. ' },
    { where: 'system', part: 'instructions', text: 'Today is 2026-11-16 — café ☕', breakpoint: true },
    // The agent prompt's date stamp: in no part hash and not in promptHash (so the expected hashes are the same without it).
    { where: 'messages', part: 'formatting', text: 'Current date and time: 2026-11-16T10:11:12.345Z' },
    { where: 'messages', part: 'history', text: 'earlier turn' },
    { where: 'messages', part: 'toolResults', text: 'file contents\n' },
    { where: 'messages', part: 'userMessage', text: 'Now fix the bug.' },
  ] as const;

  it('match the vectors the gateway’s callback pins', () => {
    expect(hashParts({ segments: [...segments], images: 1, toolNames: ['read_file', 'bash'] }, key)).toEqual({
      prefixHash: '3ca81d153c6b8cfb',
      promptHash: '783fe2f5271ffa6d',
      partHashes: { instructions: 'a6f5d5f3fca80a8f', toolDefinitions: 'e3c01feeea3ae75d', history: 'eedfdfa8630e1552', toolResults: '430453728465355e', userMessage: 'c93d0ad86faa1754' },
      toolNames: ['read_file', 'bash'],
    });
    const plain = hashParts({ segments: segments.map((s) => ({ ...s, breakpoint: false })) }, key);
    expect(plain.promptHash).toBe('663eb1a8f06db518');
    expect(plain.prefixHash).toBe('3ca81d153c6b8cfb');
  });
});

describe('the deployment files', () => {
  it('ship the same callback to compose and to the k8s example, and name it in both configs', () => {
    const root = join(process.cwd(), '..', '..');
    const read = (path: string) => readFileSync(join(root, path), 'utf8');
    expect(read('deploy/k8s/examples/llm-gateway/custom_callbacks.py')).toBe(read('deploy/llm-gateway/custom_callbacks.py'));
    for (const config of ['deploy/llm-gateway/config.yaml', 'deploy/k8s/examples/llm-gateway/config.yaml']) expect(read(config)).toMatch(/^ {2}callbacks: custom_callbacks\.proxy_handler_instance$/m);
    expect(read('deploy/compose.infra.yml')).toContain('./llm-gateway/custom_callbacks.py:/app/custom_callbacks.py:ro');
  });
});
