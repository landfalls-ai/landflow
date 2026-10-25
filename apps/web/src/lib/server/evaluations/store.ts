/**
 * Evaluation storage in the host database (migrations 500 and 501): offline runs (`evaluation_runs`) with one
 * row per test case (`evaluation_cases`), and the online grading settings and scores per agent or AI Agent node
 * (`online_eval_configs`, `online_eval_scores`). Synchronous, like the rest of the store.
 */
import type { EvaluationCase, EvaluationRunSummary, OnlineEvalConfig, OnlineEvalScore } from '../../shared/evaluations';
import { DEFAULT_ONLINE_EVAL } from '../../shared/evaluations';
import { database } from '../db';
import { parse } from '../db/rows';

/** Scores kept per target; older ones are deleted. */
export const MAX_SCORES_PER_TARGET = 2_000;
/** Runs kept per workflow; older ones (and their cases) are deleted. */
export const MAX_RUNS_PER_WORKFLOW = 100;

const db = () => database();

// ---------------------------------------------------------------------------
// Offline runs
// ---------------------------------------------------------------------------

export function saveRun(run: EvaluationRunSummary) {
  db().upsert('evaluation_runs', {
    id: run.id,
    workflow_id: run.workflowId,
    number: run.number,
    status: run.status,
    started_at: run.startedAt,
    finished_at: run.finishedAt ?? null,
    data: JSON.stringify(run),
  });
}

export function getRun(id: string): EvaluationRunSummary | undefined {
  if (!/^[\w-]+$/.test(id)) return undefined;
  return parse<EvaluationRunSummary>(db().get<{ data: string }>('SELECT data FROM evaluation_runs WHERE id = ?', id)?.data);
}

/** A workflow's runs, newest first. */
export function listRuns(workflowId: string, limit = MAX_RUNS_PER_WORKFLOW): EvaluationRunSummary[] {
  return db()
    .all<{ data: string }>('SELECT data FROM evaluation_runs WHERE workflow_id = ? ORDER BY started_at DESC, number DESC LIMIT ?', workflowId, Math.max(1, Math.floor(limit)))
    .flatMap((row) => parse<EvaluationRunSummary>(row.data) ?? []);
}

/** Runs in a state (all workflows), oldest first. */
export function runsWithStatus(status: EvaluationRunSummary['status']): EvaluationRunSummary[] {
  return db()
    .all<{ data: string }>('SELECT data FROM evaluation_runs WHERE status = ? ORDER BY started_at', status)
    .flatMap((row) => parse<EvaluationRunSummary>(row.data) ?? []);
}

/** The next run number of a workflow. */
export function nextRunNumber(workflowId: string): number {
  return Number(db().get<{ n: number | null }>('SELECT MAX(number) AS n FROM evaluation_runs WHERE workflow_id = ?', workflowId)?.n ?? 0) + 1;
}

export function deleteRun(id: string): boolean {
  return db().transaction(() => {
    db().delete('evaluation_cases', { run_id: id });
    return db().delete('evaluation_runs', { id }) > 0;
  });
}

/** Keep the newest MAX_RUNS_PER_WORKFLOW runs of a workflow. */
export function pruneRuns(workflowId: string) {
  const stale = db().all<{ id: string }>('SELECT id FROM evaluation_runs WHERE workflow_id = ? ORDER BY started_at DESC, number DESC LIMIT -1 OFFSET ?', workflowId, MAX_RUNS_PER_WORKFLOW);
  for (const { id } of stale) deleteRun(id);
}

export function saveCase(testCase: EvaluationCase) {
  db().upsert('evaluation_cases', {
    run_id: testCase.runId,
    idx: testCase.index,
    execution_id: testCase.executionId ?? null,
    status: testCase.status,
    data: JSON.stringify(testCase),
  });
}

export function getCase(runId: string, index: number): EvaluationCase | undefined {
  return parse<EvaluationCase>(db().get<{ data: string }>('SELECT data FROM evaluation_cases WHERE run_id = ? AND idx = ?', runId, index)?.data);
}

export function listCases(runId: string): EvaluationCase[] {
  return db()
    .all<{ data: string }>('SELECT data FROM evaluation_cases WHERE run_id = ? ORDER BY idx', runId)
    .flatMap((row) => parse<EvaluationCase>(row.data) ?? []);
}

/** Change a case in one transaction (read, patch, write), so metrics recorded by two nodes don't overwrite each other. */
export function updateCase(runId: string, index: number, patch: (current: EvaluationCase) => EvaluationCase): EvaluationCase | undefined {
  return db().transaction(() => {
    const current = getCase(runId, index);
    if (!current) return undefined;
    const next = patch(current);
    saveCase(next);
    return next;
  });
}

// ---------------------------------------------------------------------------
// Online grading
// ---------------------------------------------------------------------------

export function getOnlineConfig(target: string): OnlineEvalConfig {
  const saved = parse<Partial<OnlineEvalConfig>>(db().get<{ data: string }>('SELECT data FROM online_eval_configs WHERE target = ?', target)?.data);
  return { ...DEFAULT_ONLINE_EVAL, ...saved };
}

export function hasOnlineConfig(target: string): boolean {
  return Boolean(db().get<{ target: string }>('SELECT target FROM online_eval_configs WHERE target = ?', target));
}

export function saveOnlineConfig(target: string, config: OnlineEvalConfig): OnlineEvalConfig {
  db().upsert('online_eval_configs', { target, data: JSON.stringify(config), updated_at: new Date().toISOString() });
  return config;
}

/** Targets with grading switched on. */
export function enabledTargets(prefix = ''): string[] {
  return db()
    .all<{ target: string; data: string }>('SELECT target, data FROM online_eval_configs')
    .filter((row) => row.target.startsWith(prefix) && parse<Partial<OnlineEvalConfig>>(row.data)?.enabled)
    .map((row) => row.target);
}

export function saveScore(score: OnlineEvalScore) {
  db().transaction(() => {
    db().upsert('online_eval_scores', { id: score.id, target: score.target, created_at: score.createdAt, score: score.score, flagged: score.flagged, data: JSON.stringify(score) });
    const stale = db().all<{ id: string }>('SELECT id FROM online_eval_scores WHERE target = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?', score.target, MAX_SCORES_PER_TARGET);
    for (const { id } of stale) db().delete('online_eval_scores', { id });
  });
}

/** A target's scores, newest first. */
export function listScores(target: string, limit = 200): OnlineEvalScore[] {
  return db()
    .all<{ data: string }>('SELECT data FROM online_eval_scores WHERE target = ? ORDER BY created_at DESC, id DESC LIMIT ?', target, Math.max(1, Math.floor(limit)))
    .flatMap((row) => parse<OnlineEvalScore>(row.data) ?? []);
}

/** Per UTC day since `since`: mean score, count and flagged count. */
export function dailyScores(target: string, since: string): Array<{ day: string; average: number; count: number; flagged: number }> {
  return db()
    .all<{ day: string; average: number; count: number; flagged: number }>(
      'SELECT SUBSTR(created_at, 1, 10) AS day, AVG(score) AS average, COUNT(*) AS count, SUM(flagged) AS flagged FROM online_eval_scores WHERE target = ? AND created_at >= ? GROUP BY SUBSTR(created_at, 1, 10) ORDER BY day',
      target,
      since,
    )
    .map((row) => ({ day: row.day, average: Number(row.average), count: Number(row.count), flagged: Number(row.flagged ?? 0) }));
}

/** All-time count, mean and flagged count of a target's scores. */
export function scoreTotals(target: string): { total: number; average?: number; flagged: number } {
  const row = db().get<{ n: number; average: number | null; flagged: number | null }>(
    'SELECT COUNT(*) AS n, AVG(score) AS average, SUM(flagged) AS flagged FROM online_eval_scores WHERE target = ?',
    target,
  );
  const total = Number(row?.n ?? 0);
  return { total, ...(total && row?.average !== null && row?.average !== undefined && { average: Number(row.average) }), flagged: Number(row?.flagged ?? 0) };
}

export function deleteScores(target: string): number {
  return db().delete('online_eval_scores', { target });
}
