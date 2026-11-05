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

const db = () => database();
const MAX_RUNS_PER_AGENT = 30;
const clip = (text: string, limit = 4_000) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

export class EvalGateError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function listCases(agentId: string): AgentEvalCase[] {
  return db()
    .all<{ data: string }>('SELECT data FROM agent_eval_cases WHERE agent_id = ? ORDER BY created_at, id', agentId)
    .flatMap((row) => parse<AgentEvalCase>(row.data) ?? []);
}

export function addCase(agentId: string, input: { input: string; expected?: string }): AgentEvalCase {
  const text = input.input.trim();
  if (!text) throw new EvalGateError('A test case needs a question');
  if (listCases(agentId).length >= MAX_EVAL_CASES) throw new EvalGateError(`An agent keeps at most ${MAX_EVAL_CASES} test cases`);
  const expected = input.expected?.trim();
  const testCase: AgentEvalCase = { id: `ec_${nanoid(10)}`, input: clip(text), ...(expected && { expected: clip(expected) }), createdAt: new Date().toISOString() };
  db().upsert('agent_eval_cases', { id: testCase.id, agent_id: agentId, created_at: testCase.createdAt, data: JSON.stringify(testCase) });
  return testCase;
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
export async function runEval(agentId: string, version: 'draft' | number = 'draft', options: { signal?: AbortSignal } = {}): Promise<AgentEvalRun> {
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
