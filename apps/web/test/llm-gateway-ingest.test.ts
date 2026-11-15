/**
 * The spend import (docs/llm-gateway.md, "Agents outside Landflow") against a fake LiteLLM: calls of a runtime key become
 * `ai_usage` rows once each, attributed to agent, project and person, with one `ai.call` event; Landflow's own calls, failed
 * and empty rows are skipped; the caps count the imported rows; a gateway that is down or an import that is off never throws.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeLiteLlm, type FakeLiteLlm, type FakeSpendLog } from './fake-litellm';

const { database } = await import('@/lib/server/db');
const { aiUsageMeter, agentLimits, executionScope, runInUsageScope } = await import('@/lib/server/ai-usage');
const { afterModelCall } = await import('@/lib/server/ai-usage/scope');
const { importSpend } = await import('@/lib/server/llm-gateway/ingest');
const { ensureRuntimeKey } = await import('@/lib/server/llm-gateway/runtime-keys');
const { hashKey } = await import('@/lib/server/llm-gateway/client');
const { saveGatewaySettings, saveIngestStatus, ingestStatus } = await import('@/lib/server/llm-gateway/settings');
const { LITELLM_IDS } = await import('@/lib/shared/llm-gateway');

interface UsageRow {
  id: string;
  agent_id: string | null;
  user_id: string | null;
  project_id: string | null;
  runtime: string;
  source: string;
  provider: string;
  model: string;
  operation: string;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  gateway_cost: number;
  call_id: string;
  gateway_request_id: string | null;
  day: string;
}

let litellm: FakeLiteLlm;
let ownKey: string;
const ENV = ['LANDFLOW_LLM_GATEWAY_URL', 'LANDFLOW_LLM_GATEWAY_ADMIN_KEY', 'LANDFLOW_LLM_GATEWAY_KEY', 'LANDFLOW_LLM_GATEWAY_CLUSTER_URL'];
const saved: Record<string, string | undefined> = {};
let seq = 0;
const fresh = (prefix: string) => `${prefix}_${process.pid}_${++seq}`;

/** The import runs "later": the window ends a minute before `now`. */
const later = () => Date.now() + 5 * 60_000;
const rows = (agent?: string) => database().all<UsageRow>(`SELECT * FROM ai_usage WHERE source = 'litellm'${agent ? ' AND agent_id = ?' : ''} ORDER BY at`, ...(agent ? [agent] : []));

const post = (key: string, headers: Record<string, string> = {}, model = 'qwen3-coder:30b') =>
  fetch(`${litellm.origin}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }] }),
  });

beforeAll(async () => {
  litellm = await startFakeLiteLlm({ costPerCall: 0.002, usage: { input: 30, output: 10 } });
  for (const name of ENV) saved[name] = process.env[name];
  ownKey = litellm.addKey({ key_alias: 'landflow-own' }).key;
  process.env.LANDFLOW_LLM_GATEWAY_URL = litellm.origin;
  process.env.LANDFLOW_LLM_GATEWAY_ADMIN_KEY = litellm.masterKey;
  process.env.LANDFLOW_LLM_GATEWAY_KEY = ownKey;
});
afterAll(async () => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  await litellm.close();
});
beforeEach(() => {
  litellm.setDown(false);
  litellm.spendLogs.length = 0;
  litellm.requests.length = 0;
  saveGatewaySettings({ ingest: true });
  saveIngestStatus({ enabled: false, imported: 0, skipped: 0, totalImported: 0 });
});

const landflowRow = (fields: Record<string, string>) =>
  database().insertNew('ai_usage', { id: fresh('au'), at: new Date().toISOString(), day: new Date().toISOString().slice(0, 10), provider: 'litellm', model: 'qwen3-coder:30b', operation: 'chat', input_tokens: 1, output_tokens: 1, cost: 0, source: 'landflow', runtime: 'landflow', ...fields });
/** What Landflow's meter writes for a call it counted through the server's gateway: its call id and response id. */
const metered = (row: { litellm_call_id?: string; request_id: string }) => landflowRow({ call_id: idOf(row), gateway_request_id: row.request_id });
/** The same for a call with no response id (embeddings) on the server's own key: its call id and the key's hash. */
const meteredByCallId = (row: { litellm_call_id?: string; api_key: string }) => landflowRow({ call_id: row.litellm_call_id!, gateway_key_hash: row.api_key });
/** Landflow's meter recording a call after the import read its spend row. */
const meterLater = (fields: { callId?: string; gatewayRequestId?: string; gatewayKeyHash?: string }) =>
  runInUsageScope(executionScope({ executionId: fresh('ex'), workflowId: 'wf_meter_later', userId: 'u_meter_later' }), async () =>
    afterModelCall({ provider: 'litellm', model: 'qwen3-coder:30b', operation: 'chat', inputTokens: 30, outputTokens: 10, ...fields }),
  );
const byRequest = (requestId: string) => database().all<UsageRow & { user_id: string | null }>('SELECT * FROM ai_usage WHERE gateway_request_id = ?', requestId);

/** The id the import keeps: the proxy's call id (`x-litellm-call-id`), else the response id. */
const idOf = (row: { litellm_call_id?: string; request_id: string }): string => row.litellm_call_id ?? row.request_id;

describe('the spend import', () => {
  it('turns a runtime key’s calls into ai_usage rows, once each, with an ai.call event', async () => {
    const agentId = fresh('ag');
    const { key } = await ensureRuntimeKey({ agentId, runtime: 'kagent', model: 'qwen3-coder:30b', projectId: 'prj_a' });
    await post(key);
    await post(key);
    const [first, second] = litellm.spendLogs;

    const status = await importSpend({ now: later() });
    expect(status).toMatchObject({ enabled: true, imported: 2, skipped: 0, totalImported: 2 });
    expect(status.error).toBeUndefined();
    const imported = rows(agentId);
    expect(imported).toHaveLength(2);
    expect(imported[0]).toMatchObject({
      agent_id: agentId,
      project_id: 'prj_a',
      runtime: 'kagent',
      source: 'litellm',
      provider: 'litellm',
      model: 'qwen3-coder:30b',
      operation: 'chat',
      input_tokens: 30,
      output_tokens: 10,
      cost: 0.002,
      gateway_cost: 0.002,
    });
    expect(imported.map((r) => r.call_id).sort()).toEqual([idOf(first), idOf(second)].sort());
    expect(imported[0].id).toMatch(/^au_ll_[0-9a-f]{20}$/);
    const events = database().all<{ id: string; kind: string; agent_id: string; tokens: number; attrs: string }>('SELECT * FROM usage_events WHERE agent_id = ?', agentId);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'ai.call', tokens: 40 });
    expect(JSON.parse(events[0].attrs)).toMatchObject({ provider: 'litellm', source: 'litellm', runtime: 'kagent', gatewayCost: 0.002, input: 30, output: 10 });

    // Again, and with an overlapping window: nothing is added.
    expect(await importSpend({ now: later() + 60_000 })).toMatchObject({ imported: 0, totalImported: 2 });
    expect(await importSpend({ now: later() })).toMatchObject({ imported: 0 });
    expect(rows(agentId)).toHaveLength(2);
    expect(database().all('SELECT 1 FROM usage_events WHERE agent_id = ?', agentId)).toHaveLength(2);
  });

  it('attributes to the project the key was minted for', async () => {
    const agentId = fresh('ag');
    litellm.teams.set(LITELLM_IDS.team('prj_team'), { team_id: LITELLM_IDS.team('prj_team'), spend: 0 });
    const { key } = await ensureRuntimeKey({ agentId, runtime: 'claude', model: 'qwen3-coder:30b', projectId: 'prj_team' });
    await post(key);
    await importSpend({ now: later() });
    expect(rows(agentId)[0]).toMatchObject({ runtime: 'claude', project_id: 'prj_team' });
  });

  it('skips the calls Landflow counted (by call id), failed calls and empty rows; a caller’s in-process label skips nothing', async () => {
    const agentId = fresh('ag');
    const { key } = await ensureRuntimeKey({ agentId, runtime: 'kagent', model: 'qwen3-coder:30b' });
    await post(key);
    const keep = litellm.spendLogs[0];
    await post(ownKey, { 'x-litellm-spend-logs-metadata': JSON.stringify({ landflow: 'in-process' }) });
    metered(litellm.spendLogs[1]);
    // Another client claiming `in-process` is still counted: only Landflow's own record says a call was counted.
    const stranger = litellm.addKey({ key_alias: 'some-client' });
    await post(stranger.key, { 'x-litellm-spend-logs-metadata': JSON.stringify({ landflow: 'in-process' }) });
    const template = litellm.spendLogs[0];
    const extra = (patch: Partial<FakeSpendLog>) => litellm.spendLogs.push({ ...template, litellm_call_id: undefined, request_id: fresh('req'), api_key: hashKey(key), metadata: { spend_logs_metadata: {} }, ...patch });
    extra({ status: 'failure' });
    extra({ spend: 0, total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 });

    const status = await importSpend({ now: later() });
    expect(status).toMatchObject({ imported: 2, skipped: 3 });
    expect(rows().filter((r) => r.agent_id === agentId).map((r) => r.call_id)).toEqual([idOf(keep)]);
    expect(rows().some((r) => r.call_id === idOf(litellm.spendLogs[1]))).toBe(false);
    expect(rows().find((r) => r.call_id === idOf(litellm.spendLogs[2]))).toMatchObject({ runtime: 'other' });
  });

  it('counts a call Landflow made outside a usage scope (marked unmetered), even on its own key', async () => {
    await post(ownKey, { 'x-litellm-spend-logs-metadata': JSON.stringify({ landflow: 'unmetered', runtime: 'landflow' }) });
    const unmetered = litellm.spendLogs.at(-1)!;
    await post(ownKey, { 'x-litellm-spend-logs-metadata': JSON.stringify({ landflow: 'in-process', runtime: 'landflow' }) });
    const counted = litellm.spendLogs.at(-1)!;
    metered(counted);
    await importSpend({ now: later() });
    expect(rows().find((r) => r.call_id === idOf(unmetered))).toMatchObject({ source: 'litellm', runtime: 'landflow' });
    expect(rows().some((r) => r.call_id === idOf(counted))).toBe(false);
  });

  it('imports a runtime key’s call even when it claims to be in-process, and attributes it to the agent', async () => {
    const agentId = fresh('ag');
    const { key } = await ensureRuntimeKey({ agentId, runtime: 'kagent', model: 'qwen3-coder:30b', projectId: 'prj_claim' });
    await post(key, { 'x-litellm-spend-logs-metadata': JSON.stringify({ landflow: 'in-process', runtime: 'claude', agent: 'someone-else', project: 'prj_other' }) });
    const status = await importSpend({ now: later() });
    expect(status).toMatchObject({ imported: 1, skipped: 0 });
    expect(rows(agentId)).toHaveLength(1);
    expect(rows(agentId)[0]).toMatchObject({ runtime: 'kagent', project_id: 'prj_claim' });
    expect(rows().some((r) => r.agent_id === 'someone-else')).toBe(false);
  });

  it('pairs a call on the server’s key without a response id by its call id, and imports a runtime key’s row that reuses it', async () => {
    await post(ownKey);
    const own = litellm.spendLogs.at(-1)!;
    meteredByCallId(own);
    // A kagent agent sends Landflow's call id (it is in the ai.call event) on its own call: it is still counted.
    const agentId = fresh('ag');
    const { key } = await ensureRuntimeKey({ agentId, runtime: 'kagent', model: 'qwen3-coder:30b' });
    await post(key, { 'x-litellm-call-id': idOf(own) });
    expect(await importSpend({ now: later() })).toMatchObject({ imported: 1, skipped: 1 });
    expect(rows(agentId)).toHaveLength(1);
    expect(rows().some((r) => r.gateway_request_id === own.request_id)).toBe(false);
  });

  it('never lets a key holder hide a call by reusing the call id of a Landflow call made with the same key, whichever is read first', async () => {
    // A member's credential points at the server's gateway with the member's own key: Landflow's call on it is counted
    // by the meter (with the response id), and the member reuses its call id for a call of their own.
    const member = litellm.addKey({ key_alias: 'member-key' }).key;
    await post(member);
    const landflowCall = litellm.spendLogs.at(-1)!;
    metered(landflowCall);
    await post(member, { 'x-litellm-call-id': idOf(landflowCall) }, 'qwen3-coder:30b');
    const own = litellm.spendLogs.pop()!;
    litellm.spendLogs.unshift(own);
    expect(await importSpend({ now: later() })).toMatchObject({ imported: 1, skipped: 1 });
    expect(byRequest(own.request_id)).toHaveLength(1);
    expect(byRequest(own.request_id)[0]).toMatchObject({ source: 'litellm' });
    // Without a response id (embeddings) only the server's key pairs by call id: on the member's key both are imported.
    litellm.spendLogs.length = 0;
    await post(member);
    const unpaired = litellm.spendLogs.at(-1)!;
    meteredByCallId(unpaired);
    await post(member, { 'x-litellm-call-id': idOf(unpaired) });
    expect(await importSpend({ now: later() })).toMatchObject({ imported: 2, skipped: 0 });
  });

  it('lets the meter take over the row when the import read the spend row first: one row, Landflow’s attribution', async () => {
    const member = litellm.addKey({ key_alias: 'member-late' }).key;
    await post(member);
    const call = litellm.spendLogs.at(-1)!;
    expect(await importSpend({ now: later() })).toMatchObject({ imported: 1 });
    await meterLater({ callId: idOf(call), gatewayRequestId: call.request_id });
    expect(byRequest(call.request_id)).toHaveLength(1);
    expect(byRequest(call.request_id)[0]).toMatchObject({ source: 'landflow', user_id: 'u_meter_later', workflow_id: 'wf_meter_later' });
    const events = database().all<{ attrs: string }>("SELECT attrs FROM usage_events WHERE kind = 'ai.call'").filter((e) => e.attrs.includes(call.request_id));
    expect(events).toHaveLength(1);
    // A second run imports nothing again.
    expect(await importSpend({ now: later() })).toMatchObject({ imported: 0 });
    expect(byRequest(call.request_id)).toHaveLength(1);

    // On the server's own key, a call without a response id is taken over by its call id.
    await post(ownKey);
    const own = litellm.spendLogs.at(-1)!;
    await importSpend({ now: later() });
    await meterLater({ callId: idOf(own), gatewayKeyHash: hashKey(ownKey) });
    const ownRows = database().all<UsageRow & { user_id: string | null }>('SELECT * FROM ai_usage WHERE call_id = ?', idOf(own));
    expect(ownRows).toHaveLength(1);
    expect(ownRows[0]).toMatchObject({ source: 'landflow', user_id: 'u_meter_later' });

    // Any other key's call id takes nothing over: the meter's row is a second one (counted twice, never hidden).
    await post(member);
    const other = litellm.spendLogs.at(-1)!;
    await importSpend({ now: later() });
    await meterLater({ callId: idOf(other), gatewayKeyHash: hashKey(member) });
    expect(byRequest(other.request_id)).toHaveLength(1);
    expect(byRequest(other.request_id)[0]).toMatchObject({ source: 'litellm' });
  });

  it('counts every call of a key that reuses one call id', async () => {
    const agentId = fresh('ag');
    const { key } = await ensureRuntimeKey({ agentId, runtime: 'kagent', model: 'qwen3-coder:30b' });
    const reused = fresh('call');
    for (let i = 0; i < 3; i++) await post(key, { 'x-litellm-call-id': reused });
    await importSpend({ now: later() });
    expect(rows(agentId)).toHaveLength(3);
    // A second run imports nothing more: rows are named by LiteLLM's request id.
    expect(await importSpend({ now: later() })).toMatchObject({ imported: 0 });
    expect(rows(agentId)).toHaveLength(3);
  });

  it('names nobody from what the caller sends: an unknown key’s call is runtime other with no person', async () => {
    const other = litellm.addKey({ key_alias: 'some-client' });
    const before = new Set(rows().map((r) => r.id));
    await post(other.key, { 'x-litellm-end-user-id': LITELLM_IDS.customer('usr_ana') });
    await post(other.key);
    await importSpend({ now: later() });
    const mine = rows().filter((r) => r.runtime === 'other' && !before.has(r.id));
    expect(mine).toHaveLength(2);
    // The end user header is the caller's word: it must not charge usr_ana's cap.
    expect(mine.every((r) => r.user_id === null && r.agent_id === null && r.source === 'litellm')).toBe(true);
  });

  it('is counted by the agent’s caps, and not by a person the caller names', async () => {
    const agentId = fresh('ag');
    const { key } = await ensureRuntimeKey({ agentId, runtime: 'kagent', model: 'qwen3-coder:30b' });
    await post(key, { 'x-litellm-end-user-id': LITELLM_IDS.customer('usr_cap') });
    await post(key, { 'x-litellm-end-user-id': LITELLM_IDS.customer('usr_cap') });
    const meter = aiUsageMeter();
    expect(meter.agentDay(agentId).calls).toBe(0);
    const [limit] = agentLimits(agentId, 'Capped', { dailyCostLimit: 0.003 });
    expect(limit.used()).toBe(0);
    await importSpend({ now: later() });
    expect(meter.agentDay(agentId)).toMatchObject({ calls: 2, inputTokens: 60, outputTokens: 20 });
    expect(meter.agentDay(agentId).cost).toBeCloseTo(0.004);
    expect(meter.sinceTotals('user_id', 'usr_cap', 'day').calls).toBe(0);
    // The cap that was not reached before is now: the next call would be refused.
    expect(limit.used()).toBeGreaterThanOrEqual(limit.max);
  });

  it('imports every row across pages', async () => {
    const agentId = fresh('ag');
    const { key } = await ensureRuntimeKey({ agentId, runtime: 'kagent', model: 'qwen3-coder:30b' });
    await post(key);
    saveIngestStatus({ enabled: true, imported: 0, skipped: 0, totalImported: 0, lastEnd: new Date().toISOString() });
    const template = litellm.spendLogs[0];
    for (let i = 0; i < 1_149; i++) litellm.spendLogs.push({ ...template, litellm_call_id: undefined, request_id: `bulk-${agentId}-${i}` });
    const status = await importSpend({ now: later() });
    expect(status.imported).toBe(1_150);
    expect(rows(agentId)).toHaveLength(1_150);
    const pages = litellm.requests.filter((r) => r.path === '/spend/logs/v2');
    expect(pages.map((r) => r.query.get('page'))).toEqual(['1', '2', '3', '4']);
    expect(pages[0].query.get('page_size')).toBe('500');
    expect(pages[0].query.get('end_date')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('keeps paging when the gateway says its total is capped, and counts every row', async () => {
    saveIngestStatus({ enabled: true, imported: 0, skipped: 0, totalImported: 0, lastEnd: new Date().toISOString() });
    const tag = fresh('cap');
    const all = Array.from({ length: 1_200 }, (_, i) => ({ request_id: `${tag}-${i}`, api_key: 'unknown', status: 'success', spend: 0.001, total_tokens: 3, prompt_tokens: 2, completion_tokens: 1, model: 'm', startTime: new Date().toISOString(), metadata: {} }));
    let chunks = 0;
    const fetcher = async (input: string) => {
      const q = new URL(input).searchParams;
      const page = Number(q.get('page'));
      if (page === 1) chunks++;
      const data = chunks === 1 ? all.slice((page - 1) * 500, page * 500) : [];
      return new Response(JSON.stringify({ data, total: 10_000, total_is_capped: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const status = await importSpend({ now: later(), fetcher });
    expect(status.imported).toBe(1_200);
    expect(status.error).toBeUndefined();
    expect(new Date(status.lastEnd!).getTime()).toBeGreaterThan(Date.now());
  });

  it('never moves the mark past unread rows when the page cap is hit, and the next run imports them', async () => {
    const before = new Date(Date.now() - 20 * 60_000).toISOString();
    saveIngestStatus({ enabled: true, imported: 0, skipped: 0, totalImported: 0, lastEnd: before });
    const tag = fresh('full');
    let seq2 = 0;
    const fetcher = async () => {
      const data = Array.from({ length: 500 }, () => ({ request_id: `${tag}-${seq2++}`, api_key: 'unknown', status: 'failure', spend: 0, metadata: {} }));
      return new Response(JSON.stringify({ data, total_is_capped: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const stuck = await importSpend({ now: later(), fetcher });
    expect(stuck.error).toMatch(/keeps its place/);
    expect(stuck.lastEnd).toBe(before);
    expect(seq2).toBe(200 * 500);

    const agentId = fresh('ag');
    const { key } = await ensureRuntimeKey({ agentId, runtime: 'kagent', model: 'qwen3-coder:30b' });
    await post(key);
    const next = await importSpend({ now: later() });
    expect(next.error).toBeUndefined();
    expect(rows(agentId)).toHaveLength(1);
  });

  it('keeps the error and does not throw when the gateway is down', async () => {
    litellm.setDown(true);
    const status = await importSpend({ now: later() });
    expect(status.enabled).toBe(true);
    expect(status.imported).toBe(0);
    expect(status.error).toBeTruthy();
    expect(ingestStatus().error).toBe(status.error);
    expect(status.lastEnd).toBeUndefined();
    litellm.setDown(false);
    expect((await importSpend({ now: later() })).error).toBeUndefined();
  });

  it('fetches nothing with ingest off, or without the admin key', async () => {
    saveGatewaySettings({ ingest: false });
    expect(await importSpend({ now: later() })).toMatchObject({ enabled: false, imported: 0 });
    saveGatewaySettings({ ingest: true });
    delete process.env.LANDFLOW_LLM_GATEWAY_ADMIN_KEY;
    const status = await importSpend({ now: later() });
    process.env.LANDFLOW_LLM_GATEWAY_ADMIN_KEY = litellm.masterKey;
    expect(status).toMatchObject({ enabled: false });
    expect(status.error).toMatch(/LANDFLOW_LLM_GATEWAY_ADMIN_KEY/);
    expect(litellm.requests).toEqual([]);
  });
});
