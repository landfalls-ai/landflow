/**
 * Join test (wave 14, carryover-w14 §2, `spend-detectors-join`): SP13's waste detectors ↔ the real meter, the prompt
 * parts the host's listener writes and the daily rollup ↔ SP23's `spend-anomaly` detector, in one `runBrain('all')`.
 * Calls are recorded through the real meter and parts recording with fake models: an agent loop with tools on a fake
 * Anthropic server (a large tool result, a tool it never calls, the same question every session, every session at its
 * iteration limit), Spotlight calls that carry a `workflowId`, a workflow's own repeated prompts, and a workflow on a
 * large unpriced Ollama model. SP13's detectors fire on what the parts and rows hold, Spotlight never counts toward the
 * workflow, the local `aiCost` judges the Ollama model on the token sums the rollup holds, `runBrain('all')` stamps the
 * study (a stale fact no longer stops it) and runs SP13's and SP23's detectors in one pass, `brain-visibility`'s member
 * check holds over all of them (a member's private work changes nothing they find; a member sees only suggestions about
 * what they may edit), and no suggestion or parts row holds a word of a prompt. Offline; run under
 * TZ=Pacific/Kiritimati and TZ=America/Los_Angeles too.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { Proposal } from '@/lib/shared/brain';
import { startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-spend-detectors-join-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' });

// The host's registrations: the recorded-call listener (parts) is runtime.ts's; the usage listeners write agent.session.
await import('@/lib/server/runtime');
const { startUsageListeners } = await import('@/lib/server/usage/listeners');
startUsageListeners();
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
registry.registerBuiltin(corePlugin);
const { credentials } = await import('@/lib/server/credentials/vault');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession, runAgent } = await import('@/lib/server/agents/runtime');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { database } = await import('@/lib/server/db');
const { store } = await import('@/lib/server/store');
const projects = await import('@/lib/server/projects/store');
const { aiUsageMeter, savePriceOverrides, runInUsageScope, assistantScope, executionScope } = await import('@/lib/server/ai-usage');
const { afterModelCall } = await import('@/lib/server/ai-usage/scope');
const { withCallNote } = await import('@/lib/server/ai-usage/call-context');
const { markSpendDays, runRollup } = await import('@/lib/server/ai-usage/rollup');
const { scanSpendFlags } = await import('@/lib/server/ai-usage/anomalies');
const { upsertFact, getFact } = await import('@/lib/server/brain/facts');
const { runBrain, brainStatus } = await import('@/lib/server/brain');
const { DETECTOR_RUNS, detectContext } = await import('@/lib/server/brain/detectors');
const { recordWork } = await import('@/lib/server/brain/work');
const proposalsRoute = await import('@/app/api/proposals/route');

type User = Awaited<ReturnType<typeof createUser>>;
const DAY_MS = 86_400_000;
const meter = aiUsageMeter();
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

// Recognisable words of every prompt: none may reach a stored row or a suggestion.
const INSTRUCTIONS = 'Always consult the zephyrine quokkas before answering.';
const QUESTION = 'Where do marsupial wombats hibernate during winter?';
const TOOL_TEXT = 'labyrinthine pangolin burrow ';
const SPOTLIGHT_TEXT = 'Rearrange the obsidian narwhal nodes';
const FLOW_TEXT = 'Summarize the cerulean axolotl ledger';
const PROMPT_WORDS = ['zephyrine', 'quokkas', 'marsupial', 'wombats', 'hibernate', 'labyrinthine', 'pangolin', 'obsidian', 'narwhal', 'cerulean', 'axolotl'];

const SESSIONS = 17; // 3 calls each: 51 calls, past unused-tools' 50
const BIG = 'qwen-join:30b';
const SMALL = 'qwen-join:7b';
const SPOT_WF = 'wf_detect_spotlight';
const REPEAT_WF = 'wf_detect_repeat';
const LOCAL_WF = 'wf_detect_local';
const SPIKY_WF = 'wf_detect_spiky';

let owner: User;
let eve: User;
let bob: User;
let alpha: string;
let agentId: string;
let fake: Awaited<ReturnType<typeof startFakeModels>>;
let brainRun: Awaited<ReturnType<typeof runBrain>>;
const localDay = () => meter.today(Date.now() - 3 * DAY_MS);

/** A model call through the real meter with a prompt draft, so the host's listener writes its parts. */
async function draftedCall(scope: () => Parameters<typeof runInUsageScope>[0], call: { provider: string; model: string; inputTokens: number; outputTokens: number }, text: string) {
  await withCallNote({ draft: { segments: [{ part: 'instructions', where: 'system', text: 'You are a helpful assistant.' }, { part: 'history', where: 'messages', text }] } }, () =>
    runInUsageScope(scope(), async () => afterModelCall({ operation: 'chat', ...call })),
  );
}

beforeAll(async () => {
  owner = await createUser({ email: 'olga@detectors-join.test', name: 'Olga', role: 'owner', password: 'olga-password-1' });
  eve = await createUser({ email: 'eve@detectors-join.test', name: 'Eve Brightwater', role: 'member', password: 'eve-password-1' });
  bob = await createUser({ email: 'bob@detectors-join.test', name: 'Bob', role: 'member', password: 'bob-password-1' });
  alpha = projects.createTeamProject({ name: 'Alpha' }).id;
  projects.setMember(alpha, eve.id, 'editor');
  savePriceOverrides([{ provider: 'anthropic', model: 'claude-spiky', input: 1, output: 0 }]);
  meter.invalidatePrices();

  // The agent loop: a fake Anthropic server that always asks for Lookup (its result is large), never Unused.
  fake = await startFakeModels({ reply: () => ({ toolCalls: [{ id: `call_${Math.random().toString(36).slice(2)}`, name: 'Lookup', arguments: {} }], usage: { input: 900, output: 20 } }) });
  const claude = credentials.create({ name: 'Fake Claude', type: 'core.anthropicApi', data: { apiKey: 'sk-ant-test', baseUrl: fake.origin } });
  const agent = agentStore.create({
    name: 'Loop desk',
    instructions: INSTRUCTIONS,
    model: { provider: 'anthropic', model: 'claude-detect-join', credential: { id: claude.id, name: claude.name } },
    settings: { maxIterations: 3, toolConcurrency: 1, sessionTokenBudget: 0, maxDelegationDepth: 2 },
    tools: [
      { id: 't_lookup', type: 'node', name: 'Lookup', description: 'Look the answer up', nodeType: 'core.set', parameters: { mode: 'manual', includeOtherFields: false, fields: { values: [{ name: 'text', type: 'string', value: TOOL_TEXT.repeat(600) }] } } },
      { id: 't_unused', type: 'node', name: 'Unused', description: 'Never needed', nodeType: 'core.noOp', parameters: {} },
    ],
  } as never);
  agentId = agent.id;
  projects.setHomeProject('agent', agentId, alpha);
  for (let i = 0; i < SESSIONS; i++) {
    const session = newSession(agent, { source: 'test', version: 'draft' });
    const result = await runAgent({ agent, session, message: QUESTION });
    expect(result.reason).toBe('max_iterations');
  }

  for (const [id, name] of [[SPOT_WF, 'Spotlight target'], [REPEAT_WF, 'Repeat flow'], [LOCAL_WF, 'Local flow'], [SPIKY_WF, 'Spiky flow']] as const) {
    store.saveWorkflow({ id, name, nodes: id === LOCAL_WF ? [{ id: 'n1', name: 'Ask', type: 'core.aiAgent', typeVersion: 1, position: [0, 0], parameters: { model: BIG } }] : [], connections: [] } as unknown as Workflow);
    projects.setHomeProject('workflow', id, alpha);
  }
  // Spotlight: six identical prompts about SPOT_WF (a workflowId on an assistant call: not the flow's spend).
  for (let i = 0; i < 6; i++) await draftedCall(() => assistantScope({ userId: eve.id, surface: 'spotlight', workflowId: SPOT_WF }), { provider: 'anthropic', model: 'claude-detect-join', inputTokens: 400, outputTokens: 10 }, SPOTLIGHT_TEXT);
  // The control: the same six identical prompts in a workflow's own runs.
  for (let i = 0; i < 6; i++) await draftedCall(() => executionScope({ executionId: `ex_rep_${i}`, workflowId: REPEAT_WF }), { provider: 'anthropic', model: 'claude-detect-join', inputTokens: 400, outputTokens: 10 }, FLOW_TEXT);
  await settle();

  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
  const now = Date.now();
  try {
    // A workflow on a large unpriced local model with short answers, 3 days ago; a smaller one of the family was seen.
    vi.setSystemTime(now - 3 * DAY_MS);
    for (let i = 0; i < 24; i++) await draftedCall(() => executionScope({ executionId: `ex_loc_${i}`, workflowId: LOCAL_WF }), { provider: 'ollama', model: BIG, inputTokens: 1_000 + i * 37, outputTokens: 60 + i }, `${FLOW_TEXT} number ${i}`);
    await draftedCall(() => executionScope({ executionId: 'ex_small', workflowId: 'wf_other_local' }), { provider: 'ollama', model: SMALL, inputTokens: 500, outputTokens: 20 }, FLOW_TEXT);
    // A workflow with 15 ordinary days and a spike today (SP23's flag, then its detector).
    for (let back = 15; back >= 0; back--) {
      vi.setSystemTime(now - back * DAY_MS - 60_000);
      await runInUsageScope(executionScope({ executionId: `ex_spiky_${back}`, workflowId: SPIKY_WF }), async () =>
        afterModelCall({ provider: 'anthropic', model: 'claude-spiky', operation: 'chat', inputTokens: back === 0 ? 30_000_000 : 2_000_000 + (back % 3) * 500_000, outputTokens: 10 }),
      );
    }
  } finally {
    vi.useRealTimers();
  }
  await settle();
  markSpendDays(Array.from({ length: 16 }, (_, back) => meter.today(now - back * DAY_MS - 60_000)));
  runRollup();
  scanSpendFlags();

  // A fact that goes stale in the study (on main the study failed on it, so no detector ran on the brain's loop).
  upsertFact({ subjectType: 'workflow', subjectId: 'wf_ghost', kind: 'purpose', statement: 'Does a thing', confidence: 0.5 } as never, database(), new Date(Date.now() - 3 * DAY_MS).toISOString());
  brainRun = await runBrain('all', {});
});

afterAll(async () => {
  enableTestAuth();
  await fake?.close();
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

const proposals = () => database().all<{ detector: string; data: string }>("SELECT detector, data FROM proposals WHERE status = 'open'").map((r) => ({ detector: r.detector, ...(JSON.parse(r.data) as Proposal) }));
const of = (detector: string) => proposals().filter((p) => p.detector === detector);
const targetIds = (detector: string) => of(detector).map((p) => p.target?.id);
async function listed(user: User): Promise<Proposal[]> {
  enableTestAuth(user);
  try {
    return ((await (await proposalsRoute.GET(new Request('http://landflow.test/api/proposals?limit=500'))).json()) as { proposals: Proposal[] }).proposals;
  } finally {
    enableTestAuth();
  }
}

describe('the waste detectors on what the meter and the parts listener recorded', () => {
  it('recorded every agent call with its parts: tool names, a tool-results part and a prompt hash', () => {
    const rows = database().all<{ id: string; iteration: number; session_id: string }>("SELECT id, iteration, session_id FROM ai_usage WHERE agent_id = ? AND operation = 'chat'", agentId);
    expect(rows).toHaveLength(SESSIONS * 3);
    const parts = database().all<{ usage_id: string; parts: string; tool_names: string | null; prompt_hash: string | null }>(`SELECT usage_id, parts, tool_names, prompt_hash FROM ai_call_parts WHERE usage_id IN (${rows.map(() => '?').join(',')})`, ...rows.map((r) => r.id));
    expect(parts).toHaveLength(rows.length);
    expect(parts.every((p) => p.prompt_hash && JSON.parse(p.tool_names ?? '[]').includes('Unused'))).toBe(true);
    expect(parts.filter((p) => (JSON.parse(p.parts) as Record<string, number>).toolResults > 0)).toHaveLength(SESSIONS * 2);
    // Each session asks the same question with the same instructions, yet no two first prompts hash alike: the agent's
    // system prompt carries the current time to the millisecond (docs/limitations.md, Token spend wave 14), so
    // repeated-calls cannot see an agent's own repeats. The workflow below repeats through the same meter and listener.
    const first = new Set(rows.filter((r) => r.iteration === 1).map((r) => parts.find((p) => p.usage_id === r.id)!.prompt_hash));
    expect(first.size).toBe(SESSIONS);
    const systems = fake.requests.filter((r) => !JSON.stringify(r.body.messages).includes('tool_result')).map((r) => JSON.stringify(r.body.system).replace(/Current date and time: [^"]*/, ''));
    expect(new Set(systems).size).toBe(1);
  });

  it('fires fat tool results, the unused tool and the loop at the iteration limit on the agent, and repeated prompts on the flow', () => {
    expect(targetIds('fat-tool-results')).toEqual([agentId]);
    expect(targetIds('unused-tools')).toEqual([agentId]);
    expect(of('unused-tools')[0]!.evidence!.find((e) => e.label === 'Tool names')!.value).toBe('Unused');
    expect(targetIds('repeated-calls')).toEqual([REPEAT_WF]);
    expect(of('repeated-calls')[0]!.evidence!.find((e) => e.label === 'Identical prompts in a day')!.value).toBe(6);
    expect(targetIds('agent-loops')).toEqual([agentId]);
    expect(of('agent-loops')[0]!.evidence!.find((e) => e.label === 'Sessions at the iteration limit')!.value).toBe(SESSIONS);
    // The share the detector names is the share the parts rows hold.
    const sums = database().get<{ results: number; input: number }>(
      "SELECT SUM(COALESCE(json_extract(p.parts, '$.toolResults'), 0)) AS results, SUM(p.input_tokens) AS input FROM ai_call_parts p JOIN ai_usage u ON u.id = p.usage_id WHERE u.agent_id = ?",
      agentId,
    )!;
    expect(of('fat-tool-results')[0]!.evidence!.find((e) => e.label === 'Tool result tokens')!.value).toBe(Math.round(Number(sums.results)));
  });

  it('never counts Spotlight’s calls toward the workflow they carry, while the same calls in the flow’s own runs count', () => {
    const spotlight = database().all<{ id: string }>("SELECT id FROM ai_usage WHERE workflow_id = ? AND surface = 'spotlight'", SPOT_WF);
    expect(spotlight).toHaveLength(6);
    const hashes = database().all<{ prompt_hash: string }>(`SELECT prompt_hash FROM ai_call_parts WHERE usage_id IN (${spotlight.map(() => '?').join(',')})`, ...spotlight.map((r) => r.id));
    expect(new Set(hashes.map((h) => h.prompt_hash)).size).toBe(1);
    expect(proposals().some((p) => p.target?.id === SPOT_WF)).toBe(false);
    expect(targetIds('repeated-calls')).toContain(REPEAT_WF);
  });

  it('judges the unpriced local model on the token sums the rollup holds', () => {
    const [finding] = of('ai-cost').filter((p) => p.target?.id === LOCAL_WF);
    expect(finding, JSON.stringify(of('ai-cost'))).toBeDefined();
    expect(finding!.title).toBe(`Try ${SMALL} instead of ${BIG} in “Local flow”`);
    const rolled = database().get<{ calls: number; input: number; output: number }>(
      'SELECT SUM(calls) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM ai_usage_daily WHERE workflow_id = ? AND model = ? AND day = ?',
      LOCAL_WF,
      BIG,
      localDay(),
    )!;
    const evidence = Object.fromEntries(finding!.evidence!.map((e) => [e.label, e.value]));
    expect(evidence['Calls this week']).toBe(Number(rolled.calls));
    expect(evidence['Input tokens this week']).toBe(Number(rolled.input));
    expect(evidence['Average output tokens']).toBe(Math.round(Number(rolled.output) / Number(rolled.calls)));
  });
});

describe('one pass of the brain', () => {
  it('stamps the study past a stale fact and runs SP13’s and SP23’s detectors in the same pass', () => {
    expect(brainRun.study).toBeDefined();
    expect(brainRun.study!.stale).toBeGreaterThanOrEqual(1);
    expect(getFact('workflow:wf_ghost:purpose')?.status).toBe('stale');
    expect(brainStatus().lastStudy).toBeTruthy();
    const by = brainRun.detect!.byDetector;
    for (const id of ['fat-tool-results', 'unused-tools', 'repeated-calls', 'agent-loops', 'spend-anomaly', 'ai-cost'] as const) expect(by[id], id).toBeGreaterThan(0);
    for (const id of ['context-bloat', 'cache-misses'] as const) expect(by[id], id).toBeDefined();
    expect(targetIds('spend-anomaly')).toEqual([SPIKY_WF]);
  });

  it('holds brain-visibility’s member check over every detector: a member’s private work changes nothing found', () => {
    const detect = () => JSON.stringify(Object.entries(DETECTOR_RUNS).map(([id, run]) => [id, run(detectContext())]));
    const before = detect();
    const at = new Date(Date.now() - 1_000).toISOString();
    expect(recordWork({ id: eve.id, role: 'member' }, [{ kind: 'work.session', source: 'claude-code', sourceId: 'eve-private', occurredAt: at, title: 'Looked at the Loop desk tools' }]).saved).toHaveLength(1);
    expect(detect()).toBe(before);
  });

  it('shows a member only the suggestions about what they may edit, and names no person', async () => {
    const all = await listed(owner);
    const mine = new Set([agentId, SPOT_WF, REPEAT_WF, LOCAL_WF, SPIKY_WF]);
    const waste = all.filter((p) => ['fat-tool-results', 'unused-tools', 'repeated-calls', 'agent-loops', 'spend-anomaly', 'ai-cost', 'cache-misses', 'context-bloat'].includes(p.detector ?? ''));
    expect(waste.length).toBeGreaterThanOrEqual(6);
    expect(waste.every((p) => mine.has(p.target?.id ?? ''))).toBe(true);
    // Eve edits Alpha: she sees them; Bob is in no project: none of them.
    const eves = new Set((await listed(eve)).map((p) => p.id));
    for (const p of waste) expect(eves.has(p.id), p.title).toBe(true);
    const bobs = new Set((await listed(bob)).map((p) => p.id));
    for (const p of waste) expect(bobs.has(p.id), p.title).toBe(false);
    const text = JSON.stringify(waste);
    for (const word of [eve.id, eve.email, 'Brightwater', owner.id]) expect(text, word).not.toContain(word);
  });

  it('keeps every word of the prompts out of the suggestions and the stored rows', () => {
    const stored = [
      ...database().all('SELECT * FROM proposals'),
      ...database().all('SELECT * FROM ai_call_parts'),
      ...database().all('SELECT * FROM ai_usage'),
      ...database().all('SELECT * FROM ai_usage_daily'),
      ...database().all('SELECT * FROM ai_spend_flags'),
    ]
      .flatMap((r) => Object.values(r as Record<string, unknown>).map((v) => String(v ?? '')))
      .join(' ')
      .toLowerCase();
    for (const word of PROMPT_WORDS) expect(stored, word).not.toContain(word);
  });
});
