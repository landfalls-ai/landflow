/**
 * Evaluation storage in the host database (migrations 500 and 501): offline runs (`evaluation_runs`) with one
 * row per test case (`evaluation_cases`), and the online grading settings and scores per agent or AI Agent node
 * (`online_eval_configs`, `online_eval_scores`). Synchronous, like the rest of the store.
 */
import type { EvaluationCase, EvaluationFile, EvaluationRunSummary, EvaluationSchedule, OnlineEvalConfig, OnlineEvalScore } from '../../shared/evaluations';
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
    heartbeat_at: new Date().toISOString(),
    data: JSON.stringify(run),
  });
}

/** A running evaluation's process is alive (saved every few seconds while it runs). */
export function touchRun(id: string) {
  const run = getRun(id);
  if (run?.status === 'running') saveRun(run);
}

/** Runs still marked running whose process hasn't been heard from since `olderThanMs` ago (no heartbeat: judged by their start). */
export function staleRunning(olderThanMs: number, now = Date.now()): EvaluationRunSummary[] {
  const cutoff = now - olderThanMs;
  return db()
    .all<{ data: string; heartbeat_at: string | null; started_at: string }>('SELECT data, heartbeat_at, started_at FROM evaluation_runs WHERE status = ? ORDER BY started_at', 'running')
    .filter((row) => Date.parse(row.heartbeat_at ?? row.started_at) < cutoff)
    .flatMap((row) => parse<EvaluationRunSummary>(row.data) ?? []);
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

// ---------------------------------------------------------------------------
// File dataset and schedule (migration 1822)
// ---------------------------------------------------------------------------

/** What `evaluation_settings.data` holds for a workflow. */
export interface EvaluationSettings {
  /** The uploaded file: its metadata and where the bytes are (the binary store). */
  file?: EvaluationFile & { binaryId: string };
  schedule?: EvaluationSchedule;
}

export function getSettings(workflowId: string): EvaluationSettings {
  return parse<EvaluationSettings>(db().get<{ data: string }>('SELECT data FROM evaluation_settings WHERE workflow_id = ?', workflowId)?.data) ?? {};
}

export function saveSettings(workflowId: string, settings: EvaluationSettings) {
  const scope = settings.file ? settings.file.binaryId.split('.')[0] : null;
  if (!settings.file && !settings.schedule) {
    db().delete('evaluation_settings', { workflow_id: workflowId });
    return;
  }
  db().upsert('evaluation_settings', { workflow_id: workflowId, scope, data: JSON.stringify(settings), updated_at: new Date().toISOString() });
}

/** Workflows with a schedule switched on. */
export function scheduledWorkflows(): Array<{ workflowId: string; schedule: EvaluationSchedule }> {
  return db()
    .all<{ workflow_id: string; data: string }>('SELECT workflow_id, data FROM evaluation_settings')
    .flatMap((row) => {
      const schedule = parse<EvaluationSettings>(row.data)?.schedule;
      return schedule?.enabled ? [{ workflowId: row.workflow_id, schedule }] : [];
    });
}

/** Whether a binary scope holds a file dataset of a workflow that still exists (the orphan sweep keeps those). */
export function isDatasetScope(scope: string, workflowExists: (workflowId: string) => boolean): boolean {
  const row = db().get<{ workflow_id: string }>('SELECT workflow_id FROM evaluation_settings WHERE scope = ?', scope);
  return Boolean(row && workflowExists(row.workflow_id));
}
