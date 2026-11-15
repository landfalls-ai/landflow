/**
 * The spend import (docs/llm-gateway.md, "Agents outside Landflow") against a fake LiteLLM: calls of a runtime key become
 * `ai_usage` rows once each, attributed to agent, project and person, with one `ai.call` event; Landflow's own calls, failed
 * and empty rows are skipped; the caps count the imported rows; a gateway that is down or an import that is off never throws.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeLiteLlm, type FakeLiteLlm, type FakeSpendLog } from './fake-litellm';

const { database } = await import('@/lib/server/db');
const { aiUsageMeter, agentLimits } = await import('@/lib/server/ai-usage');
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

  it('skips Landflow’s own calls, failed calls and empty rows', async () => {
    const agentId = fresh('ag');
    const { key } = await ensureRuntimeKey({ agentId, runtime: 'kagent', model: 'qwen3-coder:30b' });
    await post(key);
    const keep = litellm.spendLogs[0];
    await post(ownKey);
    // An `in-process` row from a key that is not a runtime key (here Landflow's own key, or another client's).
    const stranger = litellm.addKey({ key_alias: 'some-client' });
    await post(stranger.key, { 'x-litellm-spend-logs-metadata': JSON.stringify({ landflow: 'in-process' }) });
    const template = litellm.spendLogs[0];
    const extra = (patch: Partial<FakeSpendLog>) => litellm.spendLogs.push({ ...template, litellm_call_id: undefined, request_id: fresh('req'), api_key: hashKey(key), metadata: { spend_logs_metadata: {} }, ...patch });
    extra({ status: 'failure' });
    extra({ spend: 0, total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 });

    const status = await importSpend({ now: later() });
    expect(status).toMatchObject({ imported: 1, skipped: 4 });
    expect(rows().filter((r) => r.agent_id === agentId).map((r) => r.call_id)).toEqual([idOf(keep)]);
    expect(rows().some((r) => r.call_id === idOf(litellm.spendLogs[1]))).toBe(false);
    expect(rows().some((r) => r.call_id === idOf(litellm.spendLogs[2]))).toBe(false);
  });

  it('counts a call Landflow made outside a usage scope (marked unmetered), even on its own key', async () => {
    await post(ownKey, { 'x-litellm-spend-logs-metadata': JSON.stringify({ landflow: 'unmetered', runtime: 'landflow' }) });
    const unmetered = litellm.spendLogs.at(-1)!;
    await post(ownKey, { 'x-litellm-spend-logs-metadata': JSON.stringify({ landflow: 'in-process', runtime: 'landflow' }) });
    const metered = litellm.spendLogs.at(-1)!;
    await importSpend({ now: later() });
    expect(rows().find((r) => r.call_id === idOf(unmetered))).toMatchObject({ source: 'litellm', runtime: 'landflow' });
    expect(rows().some((r) => r.call_id === idOf(metered))).toBe(false);
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

  it('does not take a call whose id is already in ai_usage', async () => {
    const agentId = fresh('ag');
    const { key } = await ensureRuntimeKey({ agentId, runtime: 'kagent', model: 'qwen3-coder:30b' });
    await post(key);
    const call = litellm.spendLogs[0];
    database().insertNew('ai_usage', { id: fresh('au'), at: new Date().toISOString(), day: '2026-11-15', provider: 'anthropic', model: 'x', operation: 'chat', input_tokens: 1, output_tokens: 1, cost: 0, call_id: idOf(call), source: 'landflow', runtime: 'landflow' });
    expect(await importSpend({ now: later() })).toMatchObject({ imported: 0, skipped: 1 });
    expect(rows(agentId)).toEqual([]);
  });

  it('attributes an unknown key’s call to the person named as its end user, runtime other', async () => {
    const other = litellm.addKey({ key_alias: 'some-client' });
    const before = new Set(rows().map((r) => r.id));
    await post(other.key, { 'x-litellm-end-user-id': LITELLM_IDS.customer('usr_ana') });
    await post(other.key);
    await importSpend({ now: later() });
    const mine = rows().filter((r) => r.runtime === 'other' && !before.has(r.id));
    expect(mine).toHaveLength(2);
    const person = mine.find((r) => r.user_id === 'usr_ana')!;
    expect(person).toMatchObject({ agent_id: null, source: 'litellm' });
    expect(mine.find((r) => r.user_id === null)).toBeDefined();
  });

  it('is counted by the agent’s caps and the person’s totals', async () => {
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
    expect(meter.sinceTotals('user_id', 'usr_cap', 'day').calls).toBe(2);
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
