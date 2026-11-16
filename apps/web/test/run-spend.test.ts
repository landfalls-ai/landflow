/**
 * One run's spend and one call's view (wave 12, SP05): `GET /api/executions/:id/spend` and `GET /api/ai-calls/:id`.
 * Access follows docs/llm-gateway.md "Who sees what" (rule 3); no response holds prompt text (rule 4).
 * The demo run's numbers are `fixtures/run-spend-demo.json` (SP06 and SP07 read their numbers from it); run with
 * WRITE_RUN_SPEND_FIXTURE=1 to rewrite it after a deliberate change.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { CallParts } from '@/lib/shared/ai-call-parts';
import type { AiCallView, RunSpend, SpendCall } from '@/lib/shared/run-spend';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-run-spend-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });

const { store } = await import('@/lib/server/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const projects = await import('@/lib/server/projects');
const { database } = await import('@/lib/server/db');
const { aiUsageMeter } = await import('@/lib/server/ai-usage');
const { cacheLine, matchPrevious, runSpend, aiCallView, SPEND_CALL_LIMIT } = await import('@/lib/server/ai-usage/run-spend');
const { routePolicy } = await import('@/lib/server/auth/policy');
const { findPrice } = await import('@/lib/server/ai-usage/prices');
const spendRoute = await import('@/app/api/executions/[id]/spend/route');
const callRoute = await import('@/app/api/ai-calls/[id]/route');

type User = Awaited<ReturnType<typeof createUser>>;
const BASE = Date.parse('2026-11-16T10:00:00.000Z');
const at = (seconds: number) => new Date(BASE + seconds * 1000).toISOString();
const PROMPT_WORDS = ['zephyrine', 'quokkas', 'marsupial', 'wombats'];
let counter = 0;
let owner: User;
let member: User;
let stranger: User;
let demoAgent: { id: string; name: string };
let secretAgent: { id: string; name: string };

function usage(fields: Record<string, unknown>) {
  const input = Number(fields.input_tokens ?? 100);
  const output = Number(fields.output_tokens ?? 10);
  const read = Number(fields.cache_read_tokens ?? 0);
  const write = Number(fields.cache_write_tokens ?? 0);
  const provider = String(fields.provider ?? 'anthropic');
  const model = String(fields.model ?? 'claude-sonnet-4-6');
  const { cost } = aiUsageMeter().price({ provider, model, inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write });
  const id = String(fields.id ?? `au_rs_${++counter}`);
  database().insertNew('ai_usage', { id, at: at(0), day: '2026-11-16', operation: 'chat', input_tokens: input, output_tokens: output, cache_read_tokens: read, cache_write_tokens: write, cost, provider, model, ...fields });
  return id;
}

function split(usageId: string, fields: { parts: Record<string, number>; hashes?: Record<string, string>; prefix?: string; at?: string; method?: string; gatewayRequestId?: string; tools?: string[] }) {
  database().insertNew('ai_call_parts', {
    id: `acp_${usageId}`,
    usage_id: fields.gatewayRequestId ? null : usageId,
    gateway_request_id: fields.gatewayRequestId ?? null,
    at: fields.at ?? at(0),
    source: fields.gatewayRequestId ? 'gateway' : 'landflow',
    method: fields.method ?? 'estimate',
    input_tokens: Object.values(fields.parts).reduce((s, n) => s + n, 0),
    parts: JSON.stringify(fields.parts),
    prefix_hash: fields.prefix ?? null,
    prompt_hash: null,
    part_hashes: fields.hashes ? JSON.stringify(fields.hashes) : null,
    tool_names: fields.tools ? JSON.stringify(fields.tools) : null,
  });
}

function execution(executionId: string, workflowId: string, extra: Record<string, unknown> = {}) {
  store.saveExecution({ executionId, workflowId, workflowName: workflowId, mode: 'manual', status: 'success', startedAt: at(0), finishedAt: at(60), durationMs: 60_000, runData: {}, executionOrder: [], ...extra } as never);
}

const get = async (route: { GET: unknown }, id: string, user?: User) => {
  enableTestAuth(user);
  try {
    const response = await (route.GET as (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>)(new Request(`http://x.test/${id}`), { params: Promise.resolve({ id }) });
    return { status: response.status, text: await response.clone().text(), body: await response.json() };
  } finally {
    enableTestAuth();
  }
};

const fixturePath = join(import.meta.dirname, 'fixtures', 'run-spend-demo.json');

beforeAll(async () => {
  owner = await createUser({ email: 'olga@runspend.test', name: 'Olga Owner', role: 'owner', password: 'olga-password-1' });
  member = await createUser({ email: 'mia@runspend.test', name: 'Mia Member', role: 'member', password: 'mia-password-1' });
  stranger = await createUser({ email: 'sam@runspend.test', name: 'Sam Stranger', role: 'member', password: 'sam-password-1' });
  const open = projects.createTeamProject({ name: 'Open desk' }).id;
  const closed = projects.createTeamProject({ name: 'Closed desk' }).id;
  projects.setMember(open, member.id, 'editor');
  store.saveWorkflow({ id: 'wf_rs_demo', name: 'Support', nodes: [], connections: [] } as unknown as Workflow);
  store.saveWorkflow({ id: 'wf_rs_closed', name: 'Closed flow', nodes: [], connections: [] } as unknown as Workflow);
  projects.setHomeProject('workflow', 'wf_rs_demo', open);
  projects.setHomeProject('workflow', 'wf_rs_closed', closed);
  demoAgent = agentStore.create({ name: 'Support agent', instructions: 'Always consult the zephyrine quokkas. Where do marsupial wombats hibernate?' });
  secretAgent = agentStore.create({ name: 'Hidden Quokka Desk' });
  projects.setHomeProject('agent', demoAgent.id, open);
  projects.setHomeProject('agent', secretAgent.id, closed);

  // The demo run (docs: run-spend-api): an agent of three iterations and one unpriced guardrail call.
  execution('ex_demo', 'wf_rs_demo', { nodeNames: { n_agent: 'Support agent', n_guard: 'Guard' } });
  const iterations = [
    { input_tokens: 10_000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 8000 },
    { input_tokens: 10_000, output_tokens: 450, cache_read_tokens: 8000, cache_write_tokens: 0 },
    { input_tokens: 10_000, output_tokens: 500, cache_read_tokens: 8000, cache_write_tokens: 0 },
  ];
  iterations.forEach((tokens, i) => {
    const id = usage({ id: `au_demo_${i + 1}`, at: at(i * 10), execution_id: 'ex_demo', workflow_id: 'wf_rs_demo', agent_id: demoAgent.id, session_id: 'as_demo', node_id: 'n_agent', purpose: 'answer', iteration: i + 1, duration_ms: 2000, stop_reason: i < 2 ? 'tool_use' : 'end_turn', ...tokens });
    split(id, { parts: { toolDefinitions: 1500, instructions: 3000, history: 4500, userMessage: 1000 }, hashes: { toolDefinitions: 'tt', instructions: 'ii', history: `h${i}` }, prefix: 'pfx', at: at(i * 10) });
  });
  usage({ id: 'au_demo_guard', at: at(35), execution_id: 'ex_demo', workflow_id: 'wf_rs_demo', node_id: 'n_guard', purpose: 'guardrail', provider: 'ollama', model: 'llama3.2', input_tokens: 600, output_tokens: 50 });
});

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

describe('GET /api/executions/:id/spend', () => {
  it("the demo run's numbers (the fixture SP06 and SP07 read)", async () => {
    const { status, body, text } = await get(spendRoute, 'ex_demo');
    expect(status).toBe(200);
    const spend = body as RunSpend;
    expect(spend.totals).toEqual({ inputTokens: 30_600, outputTokens: 1500, cacheReadTokens: 16_000, cacheWriteTokens: 8000, cost: 0.07455, calls: 4, unpricedCalls: 1 });
    expect(spend.byPurpose.map((s) => [s.key, s.calls, s.share])).toEqual([['answer', 3, 1], ['guardrail', 1, 0]]);
    expect(spend.byPurpose[1].unpricedCalls).toBe(1);
    expect(spend.cache).toEqual({ hitRate: 0.5333, readTokens: 16_000, writeTokens: 8000, missCalls: 0, missReasons: [], savedUsd: 0.0432 });
    expect(spend.byModel.map((s) => s.key)).toEqual(['anthropic/claude-sonnet-4-6', 'ollama/llama3.2']);
    expect(spend.byNode.map((s) => s.label)).toEqual(['Support agent', 'Guard']);
    expect(spend.byAgent.map((s) => s.label)).toEqual(['Support agent']);
    expect(spend.byIteration.map((s) => [s.key, s.calls])).toEqual([['1', 1], ['2', 1], ['3', 1]]);
    expect(spend.composition).toMatchObject({ method: 'estimate', callsWithParts: 3, calls: 4, parts: { toolDefinitions: 4500, instructions: 9000 } });
    expect(spend.calls.map((c) => c.usageId)).toEqual(['au_demo_1', 'au_demo_2', 'au_demo_3', 'au_demo_guard']);
    expect(spend.calls.map((c) => c.hasParts)).toEqual([true, true, true, false]);
    expect(spend.hidden).toEqual({ runs: 0, totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, calls: 0, unpricedCalls: 0 } });
    expect(spend.truncated).toBe(false);
    // The fixture: the same JSON with the agent's generated id as a constant.
    const normal = JSON.parse(text.replaceAll(demoAgent.id, 'ag_demo'));
    if (process.env.WRITE_RUN_SPEND_FIXTURE) writeFileSync(fixturePath, `${JSON.stringify(normal, null, 2)}\n`);
    expect(normal).toEqual(JSON.parse(readFileSync(fixturePath, 'utf8')));
  });

  it('sums a sub-workflow and a team member the viewer can open; the ones they cannot are in hidden only', async () => {
    execution('ex_sub', 'wf_rs_demo');
    execution('ex_parent', 'wf_rs_demo');
    execution('ex_child_ok', 'wf_rs_demo', { parentExecutionId: 'ex_parent' });
    execution('ex_child_closed', 'wf_rs_closed', { parentExecutionId: 'ex_parent' });
    usage({ id: 'au_p_1', at: at(0), execution_id: 'ex_parent', workflow_id: 'wf_rs_demo', agent_id: demoAgent.id, session_id: 'as_p', input_tokens: 1000, output_tokens: 100, purpose: 'answer' });
    usage({ id: 'au_p_ok', at: at(1), execution_id: 'ex_child_ok', workflow_id: 'wf_rs_demo', input_tokens: 2000, output_tokens: 200, purpose: 'answer' });
    usage({ id: 'au_p_closed1', at: at(2), execution_id: 'ex_child_closed', workflow_id: 'wf_rs_closed', input_tokens: 3000, output_tokens: 300 });
    usage({ id: 'au_p_closed2', at: at(3), execution_id: 'ex_child_closed', workflow_id: 'wf_rs_closed', input_tokens: 3000, output_tokens: 300 });
    // A team member of another project's agent, in a session under the run.
    usage({ id: 'au_p_member', at: at(4), execution_id: 'ex_parent', workflow_id: 'wf_rs_demo', agent_id: secretAgent.id, session_id: 'as_secret', caller_agent_id: demoAgent.id, input_tokens: 4000, output_tokens: 400 });
    const asMember = await get(spendRoute, 'ex_parent', member);
    expect(asMember.status).toBe(200);
    const spend = asMember.body as RunSpend;
    expect(spend.totals).toMatchObject({ inputTokens: 3000, outputTokens: 300, calls: 2 });
    // Two rows of one closed sub-run are one run; the member's session is another.
    expect(spend.hidden.runs).toBe(2);
    expect(spend.hidden.totals).toMatchObject({ inputTokens: 10_000, outputTokens: 1000, calls: 3 });
    expect(spend.calls.map((c) => c.usageId)).toEqual(['au_p_1', 'au_p_ok']);
    for (const name of ['Hidden Quokka Desk', secretAgent.id, 'Closed flow', 'wf_rs_closed', 'au_p_closed1', 'au_p_member']) expect(asMember.text).not.toContain(name);
    const asOwner = (await get(spendRoute, 'ex_parent', owner)).body as RunSpend;
    expect(asOwner.totals).toMatchObject({ inputTokens: 13_000, calls: 5 });
    expect(asOwner.hidden.runs).toBe(0);
    expect(asOwner.byAgent.map((s) => s.label)).toContain('Hidden Quokka Desk');
  });

  it('counts an agent the viewer cannot read as "Another agent" without its name or id', async () => {
    execution('ex_other', 'wf_rs_demo');
    usage({ id: 'au_o_1', at: at(0), execution_id: 'ex_other', workflow_id: 'wf_rs_demo', agent_id: secretAgent.id, session_id: 'as_o', input_tokens: 500, output_tokens: 50 });
    const { body, text } = await get(spendRoute, 'ex_other', member);
    expect((body as RunSpend).byAgent.map((s) => s.label)).toEqual(['Another agent']);
    expect(text).not.toContain('Hidden Quokka Desk');
    expect(text).not.toContain(secretAgent.id);
  });

  it('truncates at 500 calls, newest last, with totals over all of them', async () => {
    execution('ex_big', 'wf_rs_demo');
    for (let i = 0; i < SPEND_CALL_LIMIT + 5; i++) usage({ id: `au_big_${String(i).padStart(4, '0')}`, at: at(i), execution_id: 'ex_big', workflow_id: 'wf_rs_demo', input_tokens: 10, output_tokens: 1 });
    const spend = (await get(spendRoute, 'ex_big')).body as RunSpend;
    expect(spend.truncated).toBe(true);
    expect(spend.calls).toHaveLength(SPEND_CALL_LIMIT);
    expect(spend.calls.at(-1)?.usageId).toBe(`au_big_${String(SPEND_CALL_LIMIT + 4).padStart(4, '0')}`);
    expect(spend.totals.calls).toBe(SPEND_CALL_LIMIT + 5);
  });

  it('degrades a run from before wave 11 to its totals: no node, no iteration, purpose none', async () => {
    execution('ex_old', 'wf_rs_demo');
    usage({ id: 'au_old_1', at: at(0), execution_id: 'ex_old', workflow_id: 'wf_rs_demo', input_tokens: 400, output_tokens: 40 });
    usage({ id: 'au_old_2', at: at(1), execution_id: 'ex_old', workflow_id: 'wf_rs_demo', input_tokens: 600, output_tokens: 60 });
    const spend = (await get(spendRoute, 'ex_old')).body as RunSpend;
    expect(spend.totals).toMatchObject({ inputTokens: 1000, outputTokens: 100, calls: 2 });
    expect(spend.byNode).toEqual([]);
    expect(spend.byIteration).toEqual([]);
    expect(spend.byPurpose.map((s) => [s.key, s.calls])).toEqual([['none', 2]]);
    expect(spend.composition).toBeUndefined();
  });

  it('answers 404 for a run that is not there or the caller cannot open', async () => {
    expect((await get(spendRoute, 'ex_nothing')).status).toBe(404);
    expect((await get(spendRoute, 'ex_demo', stranger)).status).toBe(404);
    expect((await get(spendRoute, 'ex_demo', member)).status).toBe(200);
  });
});

describe('the cache line', () => {
  const call = (n: number, fields: Partial<SpendCall> = {}): SpendCall => ({ usageId: `c${n}`, at: at(n * 10), provider: 'anthropic', model: 'm', inputTokens: 10_000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, priced: true, source: 'landflow', hasParts: false, sessionId: 's', ...fields });
  const parts = (hashes: Record<string, string>, tokens: Record<string, number> = { instructions: 5000 }): CallParts => ({ at: at(0), source: 'landflow', method: 'estimate', inputTokens: 1, parts: tokens, partHashes: hashes });
  const map = (entries: Array<[string, CallParts]>) => new Map(entries);

  it('tells the miss reasons from hashes, time and size', () => {
    const miss = (n: number) => call(n, { cacheWriteTokens: 5000 });
    const first = call(1, { cacheWriteTokens: 5000 });
    expect(cacheLine([first, miss(2)], map([['c1', parts({ instructions: 'a' })], ['c2', parts({ instructions: 'b' })]]))).toMatchObject({ missCalls: 1, missReasons: ['instructions-changed'] });
    expect(cacheLine([first, miss(2)], map([['c1', parts({ toolDefinitions: 'a' })], ['c2', parts({ toolDefinitions: 'b' })]]))).toMatchObject({ missReasons: ['tools-changed'] });
    expect(cacheLine([first, call(40, { cacheWriteTokens: 5000, at: at(1000) })], map([]))).toMatchObject({ missCalls: 1, missReasons: ['expired'] });
    expect(cacheLine([first, miss(2)], map([['c2', parts({}, { instructions: 600, toolDefinitions: 100 })]]))).toMatchObject({ missReasons: ['below-minimum'] });
    expect(cacheLine([first, miss(2)], map([['c2', parts({}, { instructions: 5000 })]]))).toMatchObject({ missReasons: ['unknown'] });
    expect(cacheLine([call(1), call(2)], map([]))).toMatchObject({ missCalls: 0, missReasons: ['not-requested'] });
    // No cache activity with a small stable prefix is below the minimum; with a big prefix or no split the model asked for none.
    const small = map([['c1', parts({}, { instructions: 600, toolDefinitions: 100 })], ['c2', parts({}, { instructions: 600, toolDefinitions: 100 })]]);
    expect(cacheLine([call(1), call(2)], small)).toMatchObject({ missCalls: 0, missReasons: ['below-minimum'] });
    expect(cacheLine([call(1), call(2)], map([['c1', parts({}, { instructions: 5000 })]]))).toMatchObject({ missReasons: ['not-requested'] });
    // A hit is no miss, and the first call of a session never is.
    expect(cacheLine([first, call(2, { cacheReadTokens: 5000 })], map([]))).toMatchObject({ missCalls: 0, missReasons: [], hitRate: 0.25 });
  });

  it('saves 0 for a model with no price, and leaves out providers and calls that report no cache', () => {
    const cached = call(1, { cacheReadTokens: 4000 });
    expect(cacheLine([cached], map([]), () => undefined).savedUsd).toBe(0);
    expect(cacheLine([cached], map([]), () => ({ input: 3, cacheRead: 0.3 })).savedUsd).toBeCloseTo(0.0108);
    const local = call(2, { provider: 'ollama', model: 'llama3.2' });
    expect(cacheLine([local], map([]))).toEqual({ readTokens: 0, writeTokens: 0, missCalls: 0, missReasons: [], savedUsd: 0 });
    expect(cacheLine([call(1, { purpose: 'embed', cacheReadTokens: 10 })], map([])).hitRate).toBeUndefined();
  });

  it('compares hashes only between splits of one source: a mixed pair is not an instructions change', () => {
    const miss = call(2, { cacheWriteTokens: 5000 });
    const first = call(1, { cacheWriteTokens: 5000 });
    const gateway = { ...parts({ instructions: 'b' }), source: 'gateway' as const };
    expect(cacheLine([first, miss], map([['c1', parts({ instructions: 'a' })], ['c2', gateway]]))).toMatchObject({ missCalls: 1, missReasons: ['unknown'] });
    expect(cacheLine([first, miss], map([['c1', parts({ instructions: 'a' })], ['c2', parts({ instructions: 'b' })]]))).toMatchObject({ missReasons: ['instructions-changed'] });
  });

  it('matches the previous call of the same agent and model', () => {
    const a = call(1, { agentId: 'a' });
    const b = call(2, { agentId: 'b' });
    const c = call(3, { agentId: 'a' });
    expect(matchPrevious(c, [a, b, c])?.usageId).toBe('c1');
    expect(matchPrevious(a, [a, b, c])).toBeUndefined();
    expect(matchPrevious(c, [a, { ...b, agentId: 'a', model: 'other' }])?.usageId).toBe('c1');
  });

  it('prices the saving with the real price function', () => {
    expect(findPrice('anthropic', 'claude-sonnet-4-6')).toMatchObject({ input: 3, cacheRead: 0.3 });
  });
});

describe('GET /api/ai-calls/:id', () => {
  it('a call with a Landflow split: parts, the previous call and the run link', async () => {
    const { status, body } = await get(callRoute, 'au_demo_3');
    expect(status).toBe(200);
    const view = body as AiCallView;
    expect(view.call).toMatchObject({ usageId: 'au_demo_3', purpose: 'answer', iteration: 3, hasParts: true, priced: true });
    expect(view.parts).toMatchObject({ source: 'landflow', method: 'estimate', parts: { instructions: 3000 } });
    // Same prefix as iteration 2; only the history changed.
    expect(view.previous).toEqual({ usageId: 'au_demo_2', samePrefix: true, changedParts: ['history'] });
    expect(view.runHref).toBe('/runs/ex_demo');
  });

  it('finds the previous call of an agent the viewer cannot read', async () => {
    const base = { workflow_id: 'wf_rs_demo', execution_id: 'ex_demo', agent_id: secretAgent.id, session_id: 'as_secret', node_id: 'n_agent' };
    usage({ id: 'au_sec_1', at: at(100), ...base });
    usage({ id: 'au_sec_2', at: at(110), ...base });
    const view = (await get(callRoute, 'au_sec_2', member)).body as AiCallView;
    expect(view.call.agentId).toBeUndefined();
    expect(view.previous?.usageId).toBe('au_sec_1');
  });

  it('does not open a call in a child session of an agent the viewer cannot read (the rule runSpend applies)', async () => {
    // au_p_member (above): a team member of another project's agent, called by the demo agent, in a run the member may open.
    expect((await get(callRoute, 'au_p_member', member)).status).toBe(404);
    expect((await get(callRoute, 'au_p_member', owner)).status).toBe(200);
    // The same agent as the run's own, not a child session: opens through the run.
    expect((await get(callRoute, 'au_sec_2', member)).status).toBe(200);
  });

  it('finds the previous call although more than 200 newer rows of another agent used the same model', async () => {
    usage({ id: 'au_pv_first', at: at(1000), execution_id: 'ex_pv', workflow_id: 'wf_rs_demo', agent_id: demoAgent.id, session_id: 'as_pv' });
    for (let i = 0; i < 230; i++) usage({ id: `au_pv_other_${String(i).padStart(3, '0')}`, at: at(1001 + i), execution_id: 'ex_pv', workflow_id: 'wf_rs_demo', agent_id: secretAgent.id, session_id: 'as_pv' });
    usage({ id: 'au_pv_last', at: at(2000), execution_id: 'ex_pv', workflow_id: 'wf_rs_demo', agent_id: demoAgent.id, session_id: 'as_pv' });
    const view = (await get(callRoute, 'au_pv_last', owner)).body as AiCallView;
    expect(view.previous?.usageId).toBe('au_pv_first');
  });

  it('does not compare hashes of a Landflow split with a gateway split', async () => {
    usage({ id: 'au_mx_1', at: at(3000), execution_id: 'ex_mx', workflow_id: 'wf_rs_demo', session_id: 'as_mx' });
    split('au_mx_1', { parts: { instructions: 500 }, hashes: { instructions: 'aa' }, prefix: 'p1', at: at(3000) });
    usage({ id: 'au_mx_2', at: at(3010), execution_id: 'ex_mx', workflow_id: 'wf_rs_demo', session_id: 'as_mx', source: 'litellm', gateway_request_id: 'req_mx_2' });
    split('au_mx_2', { parts: { instructions: 500 }, hashes: { instructions: 'bb' }, prefix: 'p2', gatewayRequestId: 'req_mx_2', method: 'tokenizer', at: at(3010) });
    const view = (await get(callRoute, 'au_mx_2', owner)).body as AiCallView;
    expect(view.parts?.source).toBe('gateway');
    expect(view.previous).toEqual({ usageId: 'au_mx_1', samePrefix: false, changedParts: [], compared: false });
  });

  it('says compared: false when a split of the same source has no hashes to compare', async () => {
    usage({ id: 'au_nh_1', at: at(4000), execution_id: 'ex_nh', workflow_id: 'wf_rs_demo', session_id: 'as_nh' });
    split('au_nh_1', { parts: { instructions: 500 }, hashes: { instructions: 'aa' }, prefix: 'p1', at: at(4000) });
    usage({ id: 'au_nh_2', at: at(4010), execution_id: 'ex_nh', workflow_id: 'wf_rs_demo', session_id: 'as_nh' });
    split('au_nh_2', { parts: { instructions: 500 }, at: at(4010) });
    const view = (await get(callRoute, 'au_nh_2', owner)).body as AiCallView;
    expect(view.previous).toEqual({ usageId: 'au_nh_1', samePrefix: false, changedParts: [], compared: false });
  });

  it('the route is readable with executions:read', () => {
    expect(routePolicy('GET', '/api/ai-calls/x')).toEqual({ scope: 'executions:read' });
  });

  it("a gateway's split joins by the row's gateway_request_id", async () => {
    usage({ id: 'au_gw', at: at(5), source: 'litellm', gateway_request_id: 'req_gw_1', project_id: projects.listProjects().find((p) => p.name === 'Open desk')?.id, input_tokens: 700, output_tokens: 20 });
    split('au_gw', { parts: { instructions: 500, history: 200 }, gatewayRequestId: 'req_gw_1', method: 'tokenizer', tools: ['search'] });
    const view = (await get(callRoute, 'au_gw', member)).body as AiCallView;
    expect(view.call).toMatchObject({ source: 'litellm', hasParts: true });
    expect(view.parts).toEqual({ source: 'gateway', method: 'tokenizer', parts: { instructions: 500, history: 200 }, toolNames: ['search'] });
    expect(view.runHref).toBeUndefined();
  });

  it('a call with no split has no parts', async () => {
    const view = (await get(callRoute, 'au_demo_guard')).body as AiCallView;
    expect(view.call.hasParts).toBe(false);
    expect(view.parts).toBeUndefined();
  });

  it('opens for the run project member, never for a stranger; a call with no run only for its person and admins', async () => {
    expect((await get(callRoute, 'au_demo_1', member)).status).toBe(200);
    expect((await get(callRoute, 'au_demo_1', stranger)).status).toBe(404);
    usage({ id: 'au_spot', at: at(0), user_id: member.id, surface: 'spotlight', input_tokens: 50, output_tokens: 5 });
    expect((await get(callRoute, 'au_spot', member)).status).toBe(200);
    expect((await get(callRoute, 'au_spot', stranger)).status).toBe(404);
    expect((await get(callRoute, 'au_spot', owner)).status).toBe(200);
    expect((await get(callRoute, 'au_missing', owner)).status).toBe(404);
    expect(aiCallView('au_spot', stranger)).toBeUndefined();
  });
});

describe('no prompt text', () => {
  it('has no key that holds text, and none of the prompt words', async () => {
    const keys = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) (keys.add(key), walk(inner));
    };
    const texts: string[] = [];
    for (const [route, id] of [[spendRoute, 'ex_demo'], [callRoute, 'au_demo_2']] as const) {
      const { body, text } = await get(route, id);
      walk(body);
      texts.push(text.toLowerCase());
    }
    for (const key of ['prompt', 'prompts', 'messages', 'content', 'text', 'system', 'draft', 'answer']) expect(keys.has(key), key).toBe(false);
    // `parts` holds token counts: every value is a number.
    const view = (await get(callRoute, 'au_demo_2')).body as AiCallView;
    expect(Object.values(view.parts?.parts ?? {}).every((n) => typeof n === 'number')).toBe(true);
    for (const word of PROMPT_WORDS) for (const text of texts) expect(text).not.toContain(word);
  });
});
