/**
 * Join test (wave 12, carryover §2, `spend-gateway-join`): SP21's callback (in the pinned LiteLLM image), its route and
 * the spend import ↔ SP05's `GET /api/ai-calls/:id` ↔ SP22's `writeParts`. Each package tested its side with fakes; here
 * the bytes the real Python callback would post for an Anthropic-shaped call (a fixed `t`, the development secret from
 * deploy/.env.example) go to the real `POST /api/gateway-parts`, the real import pairs the split with the gateway's spend
 * row, and the real call view shows it. Then a Landflow split of the same call wins in each of the three orders the
 * writers can arrive in, with one row left and no failed write.
 *
 * The callback needs Docker: skipped unless LANDFLOW_INTEGRATION names `gateway-image`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeLiteLlm, type FakeLiteLlm } from './fake-litellm';
import { PY_HEADER, gatewayImageEnabled, runInGatewayImage } from './gateway-image';

vi.setConfig({ testTimeout: 240_000 });

const { database } = await import('@/lib/server/db');
const route = await import('@/app/api/gateway-parts/route');
const callRoute = await import('@/app/api/ai-calls/[id]/route');
const { importSpend } = await import('@/lib/server/llm-gateway/ingest');
const { saveGatewaySettings, saveIngestStatus } = await import('@/lib/server/llm-gateway/settings');
const { hashKey } = await import('@/lib/server/llm-gateway/client');
const { writeParts } = await import('@/lib/server/ai-usage/parts');
const { agentDraft } = await import('@/lib/server/ai-usage/drafts');
const { logger } = await import('@/lib/server/telemetry/logger');

/** The development secret (deploy/.env.example: LANDFLOW_LLM_GATEWAY_PARTS_SECRET and LANDFLOW_PARTS_SECRET). */
const SECRET = 'landflow-dev-parts-only';
const T = 1_795_000_000;
const PROMPT_WORDS = ['zephyrine', 'quokkas', 'marsupial', 'wombats', 'hibernate'];

const SCRIPT = `${PY_HEADER}
import asyncio
T = INPUT["t"]
_sign = cc.sign
cc.sign = lambda secret, body, now=None: _sign(secret, body, now=T)
sent = []
def count(base, key, model, text, tools=None, system=None):
    n = 3 + len(text) // 4
    if system:
        n += len(system) // 4
    if tools:
        n += sum(len(json.dumps(t)) // 4 for t in tools)
    return n
cb = cc.LandflowParts(url="http://landflow.test/api/gateway-parts", secret=INPUT["secret"], post=lambda url, raw, headers: sent.append((raw, headers)), sleep=lambda s: None, anthropic_count=count)
kwargs = {
    "model": "claude-sonnet-4-6",
    "call_type": "anthropic_messages",
    "litellm_params": {"custom_llm_provider": "anthropic", "api_key": "sk-ant-dev-only", "api_base": "http://anthropic.invalid"},
    "system": [{"type": "text", "text": "Always consult the zephyrine quokkas before answering.", "cache_control": {"type": "ephemeral"}}],
    "tools": [
        {"name": "read_file", "description": "Reads a marsupial file", "input_schema": {"type": "object"}},
        {"name": "bash", "description": "Runs a command", "input_schema": {"type": "object"}, "cache_control": {"type": "ephemeral"}},
    ],
    "messages": [
        {"role": "user", "content": "Where do wombats hibernate?"},
        {"role": "assistant", "content": [{"type": "tool_use", "id": "u1", "name": "read_file", "input": {"path": "burrows.md"}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "u1", "content": "In burrows."}, {"type": "text", "text": "Now answer the wombats question."}]},
    ],
}
out = []
for call in INPUT["calls"]:
    sent.clear()
    asyncio.run(cb.async_log_success_event(kwargs, {"id": call["requestId"], "usage": {"prompt_tokens": call["inputTokens"]}}, 0, 1))
    cb.wait_idle()
    raw, headers = sent[0]
    out.append({"raw": raw.decode("utf-8"), "signature": headers["x-landflow-signature"]})
print(json.dumps(out))
`;

type Posted = { raw: string; signature: string };
interface PartsRow {
  id: string;
  usage_id: string | null;
  gateway_request_id: string | null;
  source: string;
  method: string;
  parts: string;
  input_tokens: number;
}

const rowsFor = (requestId: string, usageId?: string) =>
  database().all<PartsRow>(`SELECT * FROM ai_call_parts WHERE gateway_request_id = ?${usageId ? ' OR usage_id = ?' : ''}`, ...(usageId ? [requestId, usageId] : [requestId]));

/** POSTs the callback's bytes as they are, with the clock at the signature's `t`. */
async function post(sent: Posted): Promise<number> {
  vi.useFakeTimers({ toFake: ['Date'], now: T * 1000 });
  try {
    const response = await route.POST(new Request('http://landflow.test/api/gateway-parts', { method: 'POST', headers: { 'content-type': 'application/json', 'x-landflow-signature': sent.signature }, body: sent.raw }));
    return response.status;
  } finally {
    vi.useRealTimers();
  }
}

const callView = async (usageId: string) => {
  const response = await (callRoute.GET as (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>)(new Request(`http://landflow.test/api/ai-calls/${usageId}`), { params: Promise.resolve({ id: usageId }) });
  return { status: response.status, text: await response.clone().text(), body: await response.json() };
};

/** A Landflow split through the real listener (the meter's recorded call, with the draft it took). */
async function landflowSplit(usageId: string, gatewayRequestId?: string) {
  const draft = agentDraft({
    systemSegments: [{ part: 'instructions', text: 'Always consult the zephyrine quokkas before answering.', breakpoint: true }],
    tools: [{ name: 'read_file', description: 'Reads a marsupial file', inputSchema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'Where do wombats hibernate?' }],
    cache: true,
  });
  writeParts({ usageId, at: new Date().toISOString(), provider: 'litellm', model: 'qwen3-coder:30b', operation: 'chat', inputTokens: 900, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, ...(gatewayRequestId && { gatewayRequestId }), note: { draft } });
  for (let i = 0; i < 100 && !database().get('SELECT id FROM ai_call_parts WHERE usage_id = ?', usageId); i++) await new Promise((r) => setTimeout(r, 10));
}

let seq = 0;
const usageRow = (fields: Record<string, unknown>) => {
  const id = `au_gwjoin_${++seq}`;
  const at = new Date().toISOString();
  database().insertNew('ai_usage', { id, at, day: at.slice(0, 10), provider: 'litellm', model: 'qwen3-coder:30b', operation: 'chat', input_tokens: 900, output_tokens: 10, cost: 0, source: 'landflow', runtime: 'landflow', ...fields });
  return id;
};

describe.skipIf(!gatewayImageEnabled)('spend-gateway-join: the callback’s post, the import and the call view', () => {
  let litellm: FakeLiteLlm;
  let ownKey: string;
  const ENV = ['LANDFLOW_LLM_GATEWAY_URL', 'LANDFLOW_LLM_GATEWAY_ADMIN_KEY', 'LANDFLOW_LLM_GATEWAY_KEY', 'LANDFLOW_LLM_GATEWAY_CLUSTER_URL', 'LANDFLOW_LLM_GATEWAY_PARTS_SECRET'];
  const previous: Record<string, string | undefined> = {};
  /** The gateway's spend rows, held back until a scenario lets the import see its own. */
  const logs: Record<string, FakeLiteLlm['spendLogs'][number]> = {};
  const bodies: Record<string, Posted> = {};
  const warnings: string[] = [];

  const callGateway = async (key: string) => {
    await fetch(`${litellm.origin}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ model: 'qwen3-coder:30b', messages: [{ role: 'user', content: 'hello' }] }) });
    return litellm.spendLogs.at(-1)!;
  };
  const importOnly = async (name: string) => {
    litellm.spendLogs.length = 0;
    litellm.spendLogs.push(logs[name]!);
    saveIngestStatus({ enabled: false, imported: 0, skipped: 0, totalImported: 0 });
    await importSpend({ now: Date.now() + 5 * 60_000 });
  };

  beforeAll(async () => {
    for (const name of ENV) previous[name] = process.env[name];
    litellm = await startFakeLiteLlm({ costPerCall: 0.002, usage: { input: 900, output: 10 } });
    ownKey = litellm.addKey({ key_alias: 'landflow-own-gwjoin' }).key;
    const member = litellm.addKey({ key_alias: 'member-gwjoin' }).key;
    Object.assign(process.env, { LANDFLOW_LLM_GATEWAY_URL: litellm.origin, LANDFLOW_LLM_GATEWAY_ADMIN_KEY: litellm.masterKey, LANDFLOW_LLM_GATEWAY_KEY: ownKey, LANDFLOW_LLM_GATEWAY_PARTS_SECRET: SECRET });
    saveGatewaySettings({ ingest: true });
    logs.kagent = await callGateway(member);
    logs.landflowFirst = await callGateway(member);
    logs.gatewayFirst = await callGateway(member);
    logs.takeover = await callGateway(ownKey);
    litellm.spendLogs.length = 0;
    const names = Object.keys(logs);
    const posted = runInGatewayImage<Posted[]>(SCRIPT, { secret: SECRET, t: T, calls: names.map((n) => ({ requestId: logs[n]!.request_id, inputTokens: 900 })) });
    names.forEach((n, i) => (bodies[n] = posted[i]!));
    vi.spyOn(logger, 'warn').mockImplementation((message: string) => void warnings.push(message));
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    for (const name of ENV) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await litellm.close();
  });

  it('a kagent call: the callback’s bytes are stored, the import pairs them, the call view shows the gateway’s split and no prompt text', async () => {
    const requestId = logs.kagent!.request_id;
    expect(JSON.parse(bodies.kagent!.raw).requestId).toBe(requestId);
    expect(bodies.kagent!.signature.startsWith(`t=${T},v1=`)).toBe(true);
    for (const word of PROMPT_WORDS) expect(bodies.kagent!.raw.toLowerCase()).not.toContain(word);

    expect(await post(bodies.kagent!)).toBe(204);
    expect(rowsFor(requestId)).toEqual([expect.objectContaining({ source: 'gateway', method: 'provider', usage_id: null })]);
    await importOnly('kagent');
    const usage = database().get<{ id: string }>('SELECT id FROM ai_usage WHERE gateway_request_id = ?', requestId)!;
    expect(rowsFor(requestId)).toEqual([expect.objectContaining({ source: 'gateway', usage_id: usage.id })]);

    const view = await callView(usage.id);
    expect(view.status).toBe(200);
    expect(view.body.parts).toMatchObject({ source: 'gateway', method: 'provider', toolNames: ['read_file', 'bash'] });
    const parts = view.body.parts.parts as Record<string, number>;
    expect(Object.values(parts).reduce((a, b) => a + b, 0)).toBe(900);
    expect(Object.keys(parts)).toEqual(expect.arrayContaining(['instructions', 'toolDefinitions', 'history', 'toolResults', 'userMessage']));
    for (const word of PROMPT_WORDS) expect(view.text.toLowerCase()).not.toContain(word);
  });

  it('Landflow first: the gateway’s post is a no-op', async () => {
    const requestId = logs.landflowFirst!.request_id;
    const usageId = usageRow({ gateway_request_id: requestId });
    await landflowSplit(usageId, requestId);
    expect(await post(bodies.landflowFirst!)).toBe(204);
    expect(rowsFor(requestId, usageId)).toEqual([expect.objectContaining({ source: 'landflow', usage_id: usageId })]);
  });

  it('the gateway first, then writeParts: Landflow’s split replaces the gateway’s', async () => {
    const requestId = logs.gatewayFirst!.request_id;
    expect(await post(bodies.gatewayFirst!)).toBe(204);
    expect(rowsFor(requestId)).toEqual([expect.objectContaining({ source: 'gateway', usage_id: null })]);
    const usageId = usageRow({ gateway_request_id: requestId });
    await landflowSplit(usageId, requestId);
    expect(rowsFor(requestId, usageId)).toEqual([expect.objectContaining({ source: 'landflow', usage_id: usageId, gateway_request_id: requestId })]);
  });

  it('the gateway first, then the import’s takeover of a Landflow row with its own split: the gateway’s split is dropped', async () => {
    const spend = logs.takeover!;
    const usageId = usageRow({ call_id: spend.litellm_call_id ?? spend.request_id, gateway_key_hash: hashKey(ownKey) });
    await landflowSplit(usageId);
    expect(await post(bodies.takeover!)).toBe(204);
    expect(rowsFor(spend.request_id)).toEqual([expect.objectContaining({ source: 'gateway', usage_id: null })]);
    await importOnly('takeover');
    expect(database().all('SELECT id FROM ai_usage WHERE gateway_request_id = ?', spend.request_id)).toEqual([{ id: usageId }]);
    expect(rowsFor(spend.request_id, usageId)).toEqual([expect.objectContaining({ source: 'landflow', usage_id: usageId })]);
  });

  it('no write failed on the unique index along the way', () => {
    expect(warnings.filter((w) => /parts|unique/i.test(w))).toEqual([]);
  });
});
