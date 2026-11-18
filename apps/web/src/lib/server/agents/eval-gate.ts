/**
 * The eval gate (docs/agents.md "Eval gate"): test cases a standalone agent is checked against, a run of them on the draft or a
 * published version, and the check a publish goes through. An LLM judge scores each reply 1–5 (correctness when the case has an
 * expected answer, helpfulness when it doesn't). Cases run one after another with approvals denied, on sessions that are
 * deleted afterwards, so they never reach the agent's sessions or its online grading.
 */
import { nanoid } from 'nanoid';
import {
  gateVerdict,
  MAX_EVAL_CASES,
  meanScore,
  type AgentEvalCase,
  type AgentEvalResult,
  type AgentEvalRun,
  type GateVerdict,
} from '../../shared/agent-eval';
import { database } from '../db';
import { parse } from '../db/rows';
import { agentTarget } from '../evaluations/online';
import { judge } from '../evaluations/metrics';
import { getOnlineConfig } from '../evaluations/store';
import { agentModel } from './models';
import { runAgent, newSession } from './runtime';
import { agentStore } from './store';
import { assistantScope, runInUsageScope } from '../ai-usage'; // AG15:
import { withCallNote } from '../ai-usage/call-context'; // AG15:
import { currentActorId } from '../auth/context'; // AG15:
import { HttpError } from '../errors';

const db = () => database();
const MAX_RUNS_PER_AGENT = 30;
const clip = (text: string, limit = 4_000) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

export class EvalGateError extends HttpError {
  static readonly errorName: string = 'EvalGateError';
  constructor(
    message: string,
    status = 400,
  ) {
    super(message, status, { expose: true });
  }
}

export function listCases(agentId: string): AgentEvalCase[] {
  return db()
    .all<{ data: string }>('SELECT data FROM agent_eval_cases WHERE agent_id = ? ORDER BY created_at, id', agentId)
    .flatMap((row) => parse<AgentEvalCase>(row.data) ?? []);
}

/** ag3 carryover: cases added in the same millisecond (a design saves several at once) keep the order they were added in (listCases sorts by created_at, then a random id). */
let lastCaseAt = 0;

export function addCase(agentId: string, input: { input: string; expected?: string }): AgentEvalCase {
  const text = input.input.trim();
  if (!text) throw new EvalGateError('A test case needs a question');
  if (listCases(agentId).length >= MAX_EVAL_CASES) throw new EvalGateError(`An agent keeps at most ${MAX_EVAL_CASES} test cases`);
  const expected = input.expected?.trim();
  const testCase: AgentEvalCase = { id: `ec_${nanoid(10)}`, input: clip(text), ...(expected && { expected: clip(expected) }), createdAt: new Date((lastCaseAt = Math.max(Date.now(), lastCaseAt + 1))).toISOString() };
  db().upsert('agent_eval_cases', { id: testCase.id, agent_id: agentId, created_at: testCase.createdAt, data: JSON.stringify(testCase) });
  return testCase;
}

/**
 * Replace some of an agent's cases with new ones in one transaction: every id to remove must be the agent's, and the result must
 * fit the cap; on any failure nothing changes. Returns the agent's cases after.
 */
export function replaceCases(agentId: string, removeIds: string[], add: Array<{ input: string; expected?: string }>): AgentEvalCase[] {
  // A replace that adds nothing would leave the agent with fewer cases, perhaps none (the publish gate skips an agent with no cases).
  if (removeIds.length && !add.length) throw new EvalGateError('A replace must add at least one case; delete a case on its own to remove it', 400);
  return db().transaction(() => {
    const have = new Set(listCases(agentId).map((c) => c.id));
    const missing = removeIds.filter((id) => !have.has(id));
    if (missing.length) throw new EvalGateError('A test case to replace is no longer there', 409);
    if (have.size - new Set(removeIds).size + add.length > MAX_EVAL_CASES) throw new EvalGateError(`An agent keeps at most ${MAX_EVAL_CASES} test cases`);
    for (const id of new Set(removeIds)) deleteCase(agentId, id);
    for (const c of add) addCase(agentId, c);
    return listCases(agentId);
  });
}

export function deleteCase(agentId: string, id: string): boolean {
  const found = db().get<{ id: string }>('SELECT id FROM agent_eval_cases WHERE id = ? AND agent_id = ?', id, agentId);
  if (found) db().delete('agent_eval_cases', { id });
  return Boolean(found);
}

/** Removes an agent's cases and runs with it. */
export function deleteAgentEvals(agentId: string) {
  for (const row of db().all<{ id: string }>('SELECT id FROM agent_eval_cases WHERE agent_id = ?', agentId)) db().delete('agent_eval_cases', { id: row.id });
  for (const row of db().all<{ id: string }>('SELECT id FROM agent_eval_runs WHERE agent_id = ?', agentId)) db().delete('agent_eval_runs', { id: row.id });
}

export function saveEvalRun(run: AgentEvalRun) {
  db().transaction(() => {
    db().upsert('agent_eval_runs', { id: run.id, agent_id: run.agentId, version: String(run.version), created_at: run.createdAt, average: run.average, data: JSON.stringify(run) });
    const stale = db().all<{ id: string }>('SELECT id FROM agent_eval_runs WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?', run.agentId, MAX_RUNS_PER_AGENT);
    for (const { id } of stale) db().delete('agent_eval_runs', { id });
  });
}

/** An agent's runs, newest first. */
export function listEvalRuns(agentId: string, limit = 10): AgentEvalRun[] {
  return db()
    .all<{ data: string }>('SELECT data FROM agent_eval_runs WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', agentId, Math.max(1, Math.floor(limit)))
    .flatMap((row) => parse<AgentEvalRun>(row.data) ?? []);
}

/** The average the published version last scored: what a draft is held against. */
export function baselineOf(agentId: string, version: number): number | undefined {
  return db().get<{ average: number }>('SELECT average FROM agent_eval_runs WHERE agent_id = ? AND version = ? ORDER BY created_at DESC LIMIT 1', agentId, String(version))?.average;
}

/** Run every case on the draft or a published version, judge the replies and save the run. */
export function runEval(agentId: string, version: 'draft' | number = 'draft', options: { signal?: AbortSignal } = {}): Promise<AgentEvalRun> {
  // AG15: the gate's runs and the judge's calls are the agent's tests: surface `agent-test`.
  const by = currentActorId();
  const scope = assistantScope({ surface: 'agent-test', agentId, ...(by && { userId: by }) });
  return runInUsageScope(scope, () => withCallNote({ purpose: 'eval' }, () => runEvalCases(agentId, version, options)));
}

async function runEvalCases(agentId: string, version: 'draft' | number, options: { signal?: AbortSignal }): Promise<AgentEvalRun> {
  const agent = agentStore.get(agentId);
  if (!agent) throw new EvalGateError('Agent not found', 404);
  const cases = listCases(agentId);
  if (!cases.length) throw new EvalGateError('Add a test case first');
  if (version !== 'draft' && !agent.history.some((v) => v.version === version)) throw new EvalGateError(`Version ${version} is not in the history`, 404);
  const config = version === 'draft' ? agent : (agent.history.find((v) => v.version === version)?.config ?? agent);
  const configured = getOnlineConfig(agentTarget(agentId)).model;
  const judgeChoice = configured?.model ? configured : config.model;
  if (!judgeChoice?.model) throw new EvalGateError('Choose a model for this agent first');
  const judgeModel = await agentModel(judgeChoice);

  const results: AgentEvalResult[] = [];
  for (const testCase of cases) {
    if (options.signal?.aborted) throw new EvalGateError('The evaluation was stopped');
    const base = { caseId: testCase.id, input: testCase.input, ...(testCase.expected && { expected: testCase.expected }) };
    const session = newSession(agent, { source: 'test', userId: 'evaluation', version, title: `Eval: ${testCase.input.slice(0, 40)}` });
    try {
      const result = await runAgent({ agent, session, message: testCase.input, approvals: 'deny', rootTrace: true, ...(options.signal && { signal: options.signal }) });
      const reply = result.reply ?? '';
      if (result.reason === 'error' || !reply.trim()) {
        results.push({ ...base, reply, score: 1, reasoning: 'The agent gave no reply.', error: result.reason === 'error' ? 'The run failed' : 'Empty reply' });
        continue;
      }
      const graded = testCase.expected
        ? await judge(judgeModel, 'correctness', { question: testCase.input, expected: testCase.expected, actual: clip(reply) }, options.signal)
        : await judge(judgeModel, 'helpfulness', { question: testCase.input, actual: clip(reply) }, options.signal);
      results.push({ ...base, reply: clip(reply, 2_000), score: graded.score, reasoning: graded.reasoning });
    } catch (caught) {
      results.push({ ...base, reply: '', score: 1, reasoning: 'The case could not run.', error: (caught as Error).message });
    } finally {
      agentStore.deleteSession(agentId, session.id);
    }
  }
  const run: AgentEvalRun = {
    id: `er_${nanoid(10)}`,
    agentId,
    version,
    createdAt: new Date().toISOString(),
    average: meanScore(results),
    judge: `${judgeModel.provider}/${judgeModel.model}`,
    results,
  };
  saveEvalRun(run);
  return run;
}

export interface GateResult {
  verdict: GateVerdict;
  run?: AgentEvalRun;
  /** The agent has no test cases: nothing was checked. */
  skipped?: boolean;
}

/** What a publish goes through: the draft's cases against the published version's last average. An agent with no cases passes. */
export async function checkPublish(agentId: string, options: { signal?: AbortSignal } = {}): Promise<GateResult> {
  if (!listCases(agentId).length) return { verdict: { ok: true, average: 0 }, skipped: true };
  const agent = agentStore.get(agentId);
  const baseline = agent?.published ? baselineOf(agentId, agent.published.version) : undefined;
  const run = await runEval(agentId, 'draft', options);
  return { verdict: gateVerdict(run.average, baseline), run };
}

/** After a publish: the run that let it through is the new version's baseline. */
export function adoptRun(run: AgentEvalRun, version: number) {
  saveEvalRun({ ...run, id: `er_${nanoid(10)}`, version });
}
