/**
 * File-backed persistence: one JSON document per workflow and per execution
 * under LANDFLOW_DATA_DIR (default apps/web/.data). Good enough for a single
 * host; swap this module for Postgres when you need multi-instance.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonObject } from '@landflow/protocol';
import type { Workflow } from '@landflow/engine';
import type { ExecutionRecord, ExecutionSummary, WorkflowSummary } from '../shared/types';
import { recordExecutionInsights } from './insights';
import { pruneExecutions } from './settings';
import { singleton } from './singleton';
import { recordVersion } from './versions';

const MAX_ITEMS_PER_OUTPUT = 200;

/** Write JSON through a temp file and a rename, so readers never see half a file. */
export function atomicWrite(path: string, data: unknown) {
  const tmp = `${path}.${process.pid}.tmp`;
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

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

class Store {
  readonly dir = process.env.LANDFLOW_DATA_DIR ?? join(process.cwd(), '.data');
  private readonly workflowsDir = join(this.dir, 'workflows');
  private readonly executionsDir = join(this.dir, 'executions');
  private workflows = new Map<string, Workflow>();
  private executions: ExecutionSummary[] = [];
  private listeners = new Set<() => void>();
  private readonly pollPath = join(this.dir, 'poll-state.json');
  private polls: Record<string, PollRecord> = {};

  constructor() {
    mkdirSync(this.workflowsDir, { recursive: true });
    mkdirSync(this.executionsDir, { recursive: true });
    for (const file of readdirSync(this.workflowsDir).filter((f) => f.endsWith('.json'))) {
      const workflow = readJson<Workflow>(join(this.workflowsDir, file));
      if (workflow) this.workflows.set(workflow.id, workflow);
    }
    for (const file of readdirSync(this.executionsDir).filter((f) => f.endsWith('.json'))) {
      const record = readJson<ExecutionRecord>(join(this.executionsDir, file));
      if (record) this.executions.push(summarize(record));
    }
    this.executions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    this.polls = readJson<Record<string, PollRecord>>(this.pollPath) ?? {};
  }

  onWorkflowsChanged(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- workflows ----------------------------------------------------------

  listWorkflows(): Workflow[] {
    return [...this.workflows.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
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
    return this.workflows.get(id);
  }

  saveWorkflow(workflow: Workflow): Workflow {
    const now = new Date().toISOString();
    const saved: Workflow = {
      ...workflow,
      createdAt: this.workflows.get(workflow.id)?.createdAt ?? workflow.createdAt ?? now,
      updatedAt: now,
    };
    this.workflows.set(saved.id, saved);
    atomicWrite(join(this.workflowsDir, `${saved.id}.json`), saved);
    recordVersion(saved);
    this.listeners.forEach((listener) => listener());
    return saved;
  }

  deleteWorkflow(id: string): boolean {
    if (!this.workflows.delete(id)) return false;
    rmSync(join(this.workflowsDir, `${id}.json`), { force: true });
    this.listeners.forEach((listener) => listener());
    return true;
  }

  // ---- executions ---------------------------------------------------------

  saveExecution(record: ExecutionRecord) {
    const trimmed: ExecutionRecord = {
      ...record,
      runData: Object.fromEntries(
        Object.entries(record.runData).map(([nodeId, runs]) => [
          nodeId,
          runs.map((run) => ({
            ...run,
            inputs: run.inputs.map((branch) => branch.slice(0, MAX_ITEMS_PER_OUTPUT)),
            outputs: run.outputs.map((branch) => branch.slice(0, MAX_ITEMS_PER_OUTPUT)),
          })),
        ]),
      ),
    };
    atomicWrite(join(this.executionsDir, `${record.executionId}.json`), trimmed);
    const summary = summarize(record);
    // A waiting execution is saved again when it finishes: replace its summary.
    const previous = this.executions.findIndex((e) => e.id === record.executionId);
    if (previous >= 0) this.executions.splice(previous, 1);
    this.executions.unshift(summary);
    // Insights first: its rollup keeps the run's counts after retention deletes the file.
    recordExecutionInsights(summary);
    // Retention (Settings → General): count and age; running and waiting executions are never pruned.
    pruneExecutions();
  }

  listExecutions(filter: { workflowId?: string; limit?: number } = {}): ExecutionSummary[] {
    const list = filter.workflowId ? this.executions.filter((e) => e.workflowId === filter.workflowId) : this.executions;
    return list.slice(0, filter.limit ?? 100);
  }

  getExecution(id: string): ExecutionRecord | undefined {
    if (!/^[\w-]+$/.test(id)) return undefined;
    return readJson<ExecutionRecord>(join(this.executionsDir, `${id}.json`));
  }

  /** Executions in the `waiting` state (lib/server/waits.ts resumes them). */
  waitingExecutions(): ExecutionRecord[] {
    return this.executions
      .filter((e) => e.status === 'waiting')
      .map((e) => this.getExecution(e.id))
      .filter((record): record is ExecutionRecord => record?.status === 'waiting');
  }

  deleteExecution(id: string): boolean {
    const index = this.executions.findIndex((e) => e.id === id);
    if (index < 0) return false;
    this.executions.splice(index, 1);
    rmSync(join(this.executionsDir, `${id}.json`), { force: true });
    return true;
  }

  // ---- poll trigger state -------------------------------------------------

  getPoll(key: string): PollRecord | undefined {
    return this.polls[key];
  }

  pollKeys(): string[] {
    return Object.keys(this.polls);
  }

  setPoll(key: string, record: PollRecord | undefined) {
    if (record) this.polls[key] = record;
    else if (key in this.polls) delete this.polls[key];
    else return;
    atomicWrite(this.pollPath, this.polls);
  }

  stats() {
    const day = Date.now() - 24 * 3600 * 1000;
    const recent = this.executions.filter((e) => Date.parse(e.startedAt) > day);
    return {
      workflows: this.workflows.size,
      activeWorkflows: [...this.workflows.values()].filter((w) => w.active).length,
      executions24h: recent.length,
      failed24h: recent.filter((e) => e.status === 'error').length,
      avgDurationMs: recent.length ? Math.round(recent.reduce((s, e) => s + e.durationMs, 0) / recent.length) : 0,
    };
  }
}

function summarize(record: ExecutionRecord): ExecutionSummary {
  return {
    id: record.executionId,
    workflowId: record.workflowId,
    workflowName: record.workflowName,
    mode: record.mode,
    status: record.status,
    startedAt: record.startedAt,
    durationMs: record.durationMs,
    nodesRun: record.executionOrder.filter((id) => !record.runData[id]?.at(-1)?.reused).length,
    ...(record.error && { error: record.error }),
    ...(record.rerunOf && { rerunOf: record.rerunOf }),
    ...(record.debug && { debug: true }),
    ...(record.status === 'waiting' && record.wait && { wait: { nodeName: record.wait.nodeName, resume: record.wait.resume, ...(record.wait.until && { until: record.wait.until }) } }),
    ...(record.parentExecutionId && { parentExecutionId: record.parentExecutionId }),
  };
}

export const store = singleton('store', () => new Store());
// Hot reload re-evaluates this module but singleton() keeps the first instance: give it the current class's methods.
Object.setPrototypeOf(store, Store.prototype);
