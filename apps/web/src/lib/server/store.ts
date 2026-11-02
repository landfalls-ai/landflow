/**
 * The host's system of record for workflows, executions and poll trigger state, on the database
 * (lib/server/db: SQLite at <data dir>/landflow.db, or Postgres). The API is synchronous. Workflows
 * are cached in memory (this module is their only writer); executions are read from the database,
 * their summaries from columns and the full record (run data included) on demand.
 *
 * Crash recovery: a run's node runs (`execution_steps`) and its scheduler state after each finished
 * main-flow node (`execution_checkpoints`) are saved as it goes; the runner resumes executions left
 * `running` from them at boot.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import type { JsonObject } from '@landflow/protocol';
import type { NodeItem } from '@landflow/protocol';
import type { CheckpointState, NodeRun, Workflow } from '@landflow/engine';
import type { ExecutionRecord, ExecutionState, ExecutionSummary, WorkflowSummary } from '../shared/types';
import { currentActorId } from './auth/context';
import { database, dataDir, type Database } from './db';
import { executionRow, parse, pollRow, summarize, trimRunData, workflowRow } from './db/rows';
import { recordExecutionInsights } from './insights';
import { recordExecutionUsage } from './usage/ledger';
import { pruneExecutions } from './settings';
import { singleton } from './singleton';
import { syncPublication } from './publications';
import { recordVersion, versionFor } from './versions';

/** Write JSON through a temp file and a rename, so readers never see half a file. */
export function atomicWrite(path: string, data: unknown) {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

/** Persisted per workflow + poll trigger node, keyed `${workflowId}:${nodeId}`. */
export interface PollRecord {
  /** What the trigger returned as `pollState` last time. */
  state?: JsonObject;
  /** Hash of the trigger's type, parameters and credentials: a change restarts from a baseline. */
  configHash: string;
  /** The baseline poll succeeded; later polls report new items. */
  ready: boolean;
  lastPolledAt?: string;
  lastItems?: number;
  lastError?: string;
  lastExecutionId?: string;
  polls: number;
}

/** The scheduler state saved after a main-flow node finished (see the runner's crash recovery). */
export interface StoredCheckpoint {
  /** `<nodeId>#<runIndex>` of the node that finished, or `start`. */
  stepId: string;
  /** How many entries of the execution's `executionOrder` it covers. */
  steps: number;
  savedAt: string;
  /** The engine's checkpoint state without run data, execution order and node outputs. */
  state: CheckpointState;
  /** Where the running segment started in `executionOrder` (a resumed wait starts after the runs before it). */
  baseSteps: number;
  /** `$('Node')` outputs when the running segment started (later ones come from the node runs). */
  baseOutputs?: Record<string, NodeItem[][]>;
}

/** Statuses that were never shown in the history before they finished: left out of stats(). */
const IN_FLIGHT = new Set<ExecutionState>(['running', 'queued']);

class Store {
  readonly dir = dataDir();
  private workflows?: Map<string, Workflow>;
  private listeners = new Set<() => void>();

  constructor() {
    mkdirSync(this.dir, { recursive: true });
  }

  private get db(): Database {
    return database();
  }

  /** Workflows, loaded from the database on first use. */
  private get cache(): Map<string, Workflow> {
    if (!this.workflows) {
      const loaded = new Map<string, Workflow>();
      for (const row of this.db.all<{ data: string }>('SELECT data FROM workflows')) {
        const workflow = parse<Workflow>(row.data);
        if (workflow?.id) loaded.set(workflow.id, workflow);
      }
      this.workflows = loaded;
    }
    return this.workflows;
  }

  onWorkflowsChanged(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- workflows ----------------------------------------------------------

  listWorkflows(): Workflow[] {
    return [...this.cache.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  workflowSummaries(): WorkflowSummary[] {
    return this.listWorkflows().map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description,
      active: Boolean(w.active),
      nodeCount: w.nodes.length,
      nodeTypes: [...new Set(w.nodes.map((n) => n.type))],
      tags: w.tags ?? [],
      folderId: w.folderId,
      updatedAt: w.updatedAt ?? '',
      createdAt: w.createdAt ?? '',
    }));
  }

  getWorkflow(id: string): Workflow | undefined {
    return this.cache.get(id);
  }

  saveWorkflow(workflow: Workflow): Workflow {
    const now = new Date().toISOString();
    // Who: the signed-in user of the request saving it (none for system saves, which keep the last one).
    const actor = currentActorId();
    const existing = this.cache.get(workflow.id);
    const createdBy = existing ? existing.createdBy : (workflow.createdBy ?? actor);
    const updatedBy = actor ?? workflow.updatedBy;
    const saved: Workflow = {
      ...workflow,
      createdAt: existing?.createdAt ?? workflow.createdAt ?? now,
      updatedAt: now,
      ...(createdBy && { createdBy }),
      ...(updatedBy && { updatedBy }),
    };
    this.db.transaction(() => {
      this.db.upsert('workflows', workflowRow(saved));
      // A save is a draft; turning `active` on or off (older clients) publishes it or unpublishes.
      syncPublication(saved, (recordVersion(saved) ?? versionFor(saved))?.id);
    });
    this.cache.set(saved.id, saved);
    this.listeners.forEach((listener) => listener());
    return saved;
  }

  deleteWorkflow(id: string): boolean {
    if (!this.cache.has(id)) return false;
    this.db.delete('workflows', { id });
    this.cache.delete(id);
    this.listeners.forEach((listener) => listener());
    return true;
  }

  // ---- executions ---------------------------------------------------------

  saveExecution(record: ExecutionRecord) {
    this.db.upsert('executions', executionRow(trimRunData(record)));
    if (IN_FLIGHT.has(record.status)) return;
    const summary = summarize(record);
    // Insights first: its rollup keeps the run's counts after retention deletes the execution.
    recordExecutionInsights(summary);
    // The usage ledger too (docs/second-brain.md): what ran, failed and was slow, without the items.
    recordExecutionUsage(record, record.workflow ?? this.getWorkflow(record.workflowId));
    // Retention (Settings → General): count and age; running and waiting executions are never pruned.
    pruneExecutions();
  }

  /** Change fields of a saved execution (links between retries, a scheduled retry) without counting it again. */
  patchExecution(id: string, patch: Partial<ExecutionRecord>): ExecutionRecord | undefined {
    const record = this.getExecution(id);
    if (!record) return undefined;
    const next = { ...record, ...patch };
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete (next as Record<string, unknown>)[key];
    this.db.upsert('executions', executionRow(next));
    return next;
  }

  /** Saved executions, newest first. Running ones are left out: the runner lists them (their rows are for crash recovery). */
  listExecutions(filter: { workflowId?: string; limit?: number } = {}): ExecutionSummary[] {
    const limit = filter.limit ?? 100;
    const bounded = Number.isFinite(limit);
    const where = filter.workflowId ? "WHERE status <> 'running' AND workflow_id = ?" : "WHERE status <> 'running'";
    const sql = `SELECT summary FROM executions ${where} ORDER BY started_at DESC, id DESC${bounded ? ' LIMIT ?' : ''}`;
    const params = [...(filter.workflowId ? [filter.workflowId] : []), ...(bounded ? [Math.max(0, Math.floor(limit))] : [])];
    return this.db.all<{ summary: string }>(sql, ...params).flatMap((row) => parse<ExecutionSummary>(row.summary) ?? []);
  }

  getExecution(id: string): ExecutionRecord | undefined {
    if (!/^[\w-]+$/.test(id)) return undefined;
    return parse<ExecutionRecord>(this.db.get<{ data: string }>('SELECT data FROM executions WHERE id = ?', id)?.data);
  }

  /** The newest finished or waiting executions whose saved record contains `text` (a team id in a flow's snapshot), newest first. */
  executionsMentioning(text: string, limit = 5): ExecutionRecord[] {
    const pattern = `%${text.replace(/[%_\\]/g, '\\$&')}%`;
    return this.db
      .all<{ data: string }>("SELECT data FROM executions WHERE status <> 'running' AND data LIKE ? ESCAPE '\\' ORDER BY started_at DESC, id DESC LIMIT ?", pattern, Math.max(1, Math.floor(limit)))
      .flatMap((row) => parse<ExecutionRecord>(row.data) ?? []);
  }

  /** Saved executions in one state, oldest first. */
  executionsWithStatus(status: ExecutionState, workflowId?: string): ExecutionRecord[] {
    const rows = workflowId
      ? this.db.all<{ data: string }>('SELECT data FROM executions WHERE status = ? AND workflow_id = ? ORDER BY started_at, id', status, workflowId)
      : this.db.all<{ data: string }>('SELECT data FROM executions WHERE status = ? ORDER BY started_at, id', status);
    return rows.flatMap((row) => parse<ExecutionRecord>(row.data) ?? []);
  }

  /** How many saved executions of a workflow are in one of these states. */
  countExecutions(workflowId: string, statuses: ExecutionState[]): number {
    if (!statuses.length) return 0;
    const sql = `SELECT COUNT(*) AS n FROM executions WHERE workflow_id = ? AND status IN (${statuses.map(() => '?').join(', ')})`;
    return Number(this.db.get<{ n: number }>(sql, workflowId, ...statuses)?.n ?? 0);
  }

  /** Executions in the `waiting` state (lib/server/waits.ts resumes them). */
  waitingExecutions(): ExecutionRecord[] {
    return this.executionsWithStatus('waiting').reverse();
  }

  deleteExecution(id: string): boolean {
    const deleted = this.db.transaction(() => {
      const deleted = this.db.delete('executions', { id }) > 0;
      this.db.delete('execution_steps', { execution_id: id });
      this.db.delete('execution_checkpoints', { execution_id: id });
      // The Run Trace journal goes with the execution (lib/server/journal).
      this.db.delete('execution_events', { execution_id: id });
      this.db.delete('retries', { execution_id: id });
      this.db.delete('chat_feedback', { id: `execution:${id}` });
      return deleted;
    });
    executionDeletedListeners.forEach((listener) => listener(id));
    return deleted;
  }

  // ---- checkpoints (crash recovery) ---------------------------------------

  /** One node run of a running execution, untrimmed, at its position in `executionOrder`. */
  saveStep(executionId: string, seq: number, nodeId: string, run: NodeRun) {
    this.db.upsert('execution_steps', { execution_id: executionId, seq, node_id: nodeId, run: JSON.stringify(run) });
  }

  /** The node runs saved for an execution's running segment, in order. */
  steps(executionId: string): Array<{ seq: number; nodeId: string; run: NodeRun }> {
    return this.db
      .all<{ seq: number; node_id: string; run: string }>('SELECT seq, node_id, run FROM execution_steps WHERE execution_id = ? ORDER BY seq', executionId)
      .flatMap((row) => {
        const run = parse<NodeRun>(row.run);
        return run ? [{ seq: Number(row.seq), nodeId: row.node_id, run }] : [];
      });
  }

  /**
   * Replace the checkpoint of a running execution. A segment's first checkpoint carries `baseSteps` and `baseOutputs`;
   * later ones leave them as they are.
   */
  saveCheckpoint(executionId: string, checkpoint: Omit<StoredCheckpoint, 'savedAt' | 'baseSteps'> & { baseSteps?: number }) {
    this.db.upsert('execution_checkpoints', {
      execution_id: executionId,
      step_id: checkpoint.stepId,
      steps: checkpoint.steps,
      saved_at: new Date().toISOString(),
      state: JSON.stringify(checkpoint.state),
      ...(checkpoint.baseSteps !== undefined && { base_steps: checkpoint.baseSteps }),
      ...(checkpoint.baseOutputs && { base_outputs: JSON.stringify(checkpoint.baseOutputs) }),
    });
  }

  getCheckpoint(executionId: string): StoredCheckpoint | undefined {
    const row = this.db.get<{ step_id: string; steps: number; saved_at: string; state: string; base_steps: number; base_outputs: string | null }>(
      'SELECT step_id, steps, saved_at, state, base_steps, base_outputs FROM execution_checkpoints WHERE execution_id = ?',
      executionId,
    );
    const state = parse<CheckpointState>(row?.state);
    if (!row || !state) return undefined;
    const baseOutputs = parse<Record<string, NodeItem[][]>>(row.base_outputs);
    return { stepId: row.step_id, steps: Number(row.steps), savedAt: row.saved_at, state, baseSteps: Number(row.base_steps) || 0, ...(baseOutputs && { baseOutputs }) };
  }

  /** Drop an execution's saved steps, and its checkpoint unless `keepCheckpoint` (a failed run keeps it for a retry). */
  clearCheckpoint(executionId: string, keepCheckpoint = false) {
    this.db.transaction(() => {
      this.db.delete('execution_steps', { execution_id: executionId });
      if (!keepCheckpoint) this.db.delete('execution_checkpoints', { execution_id: executionId });
    });
  }

  // ---- poll trigger state -------------------------------------------------

  getPoll(key: string): PollRecord | undefined {
    return parse<PollRecord>(this.db.get<{ data: string }>('SELECT data FROM poll_state WHERE key = ?', key)?.data);
  }

  pollKeys(): string[] {
    return this.db.all<{ key: string }>('SELECT key FROM poll_state ORDER BY key').map((row) => row.key);
  }

  setPoll(key: string, record: PollRecord | undefined) {
    if (record) this.db.upsert('poll_state', pollRow(key, record));
    else this.db.delete('poll_state', { key });
  }

  stats() {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const recent = this.db.get<{ n: number; failed: number | null; total: number | null }>(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failed, SUM(duration_ms) AS total FROM executions WHERE started_at > ? AND evaluation_run_id IS NULL AND status NOT IN (${[...IN_FLIGHT].map(() => '?').join(', ')})`,
      since,
      ...IN_FLIGHT,
    );
    const workflows = this.listWorkflows();
    const count = Number(recent?.n ?? 0);
    return {
      workflows: workflows.length,
      activeWorkflows: workflows.filter((w) => w.active).length,
      executions24h: count,
      failed24h: Number(recent?.failed ?? 0),
      avgDurationMs: count ? Math.round(Number(recent?.total ?? 0) / count) : 0,
    };
  }

  /** Forget the workflow cache (tests that reopen the database). */
  reload() {
    this.workflows = undefined;
  }

  /** Queue mode: another process changed workflows. Reload them on next use and tell the listeners. */
  reloadWorkflows() {
    this.workflows = undefined;
    this.listeners.forEach((listener) => listener());
  }
}

/** Called with the id of every deleted execution, also one that was never saved (its binary data goes with it). */
const executionDeletedListeners = singleton('execution-deleted-listeners', () => new Set<(executionId: string) => void>());

export function onExecutionDeleted(listener: (executionId: string) => void): () => void {
  executionDeletedListeners.add(listener);
  return () => executionDeletedListeners.delete(listener);
}

export const store = singleton('store', () => new Store());
// Hot reload re-evaluates this module but singleton() keeps the first instance: give it the current class's methods.
Object.setPrototypeOf(store, Store.prototype);
