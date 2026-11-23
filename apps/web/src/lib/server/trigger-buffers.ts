/**
 * Debounce and batching of trigger events (`WorkflowNode.debounce` / `.batch` on a trigger node), as Inngest's
 * debounce and batchEvents and Trigger.dev's debounce do it:
 *
 * - Debounce: events with the same key (an expression over the trigger item, e.g. `{{ $json.body.userId }}`)
 *   within `windowSeconds` of each other collapse into one run, `windowSeconds` after the last one (or at most
 *   `maxWaitSeconds` after the first). The run gets the last event (`mode: 'last'`, default) or all of them (`all`).
 * - Batching: events are collected until `size` of them arrived, or `timeoutSeconds` after the first; then one run
 *   gets them all as items.
 *
 * Production starts only (webhook, schedule, poll, app webhooks, public chats): manual runs are never held. A held
 * event makes runWorkflow reject with RunBufferedError (a RunSkippedError, so callers that skip runs handle it); the
 * Webhook trigger answers 202 `{ status: 'debounced' | 'batched' }`. Buffers live in `trigger_buffers` (migration 402)
 * and their timers are re-armed at boot, so a restart doesn't lose events.
 *
 * Queue mode: events are added under a cluster lock per trigger with the rows read fresh (`addExclusive`), and only
 * the leader keeps the timers (another process hands the buffer to it; `sync()` re-arms them all on a new leader).
 */
import { ExpressionResolver, type TriggerBatch, type TriggerDebounce, type Workflow, type WorkflowNode } from '@landflow/engine';
import type { ExecutionMode, NodeItem } from '@landflow/protocol';
import { delegated, forwardToLeader } from './cluster/state';
import { RunSkippedError } from './concurrency';
import { database, type Database } from './db';
import { singleton } from './singleton';
import { store } from './store';
import { logger } from './telemetry';

/** Modes whose runs may be held; manual and chat-panel runs always start at once. */
export const BUFFERED_MODES = new Set<ExecutionMode>(['webhook', 'trigger', 'poll']);
/** Events one buffer holds at most (the oldest go first past it). */
export const MAX_BUFFERED_ITEMS = 1_000;

export class RunBufferedError extends RunSkippedError {
  static readonly errorName: string = 'RunBufferedError';
  constructor(
    workflowId: string,
    readonly kind: 'debounce' | 'batch',
    readonly key: string,
    readonly count: number,
    readonly dueAt: string,
    /** A batch that just filled up: its run started with this event. */
    readonly startedNow = false,
  ) {
    super(workflowId, kind === 'debounce' ? 'debounced' : 'batched');
    this.message =
      kind === 'debounce'
        ? `Debounced: the run starts at ${dueAt} unless more events come in`
        : startedNow
          ? `Batched: the batch of ${count} event(s) is full and its run started`
          : `Batched: ${count} event(s) waiting, the run starts by ${dueAt}`;
  }
}

interface BufferRow {
  key: string;
  workflow_id: string;
  node_id: string;
  kind: 'debounce' | 'batch';
  first_at: string;
  due_at: string;
  count: number;
  data: string;
}

interface BufferData {
  items: NodeItem[];
  mode: ExecutionMode;
  debounceKey?: string;
  /** The events are a poll trigger's new items: the trigger outputs them without polling again. */
  asOutput?: boolean;
}

/** What starts the held run (runner.runWorkflow, injected to keep this module free of the runner). */
export type BufferedStart = (
  workflow: Workflow,
  node: WorkflowNode,
  items: NodeItem[],
  mode: ExecutionMode,
  meta: { kind: 'debounce' | 'batch'; key: string; count: number; asOutput?: boolean },
) => Promise<unknown>;

/** The debounce key of an item: the expression's value, or the setting as written when it has none. */
export function debounceKey(workflow: Workflow, setting: TriggerDebounce, item: NodeItem): string {
  const raw = setting.key?.trim();
  if (!raw) return '';
  try {
    const resolver = new ExpressionResolver({ items: [item], nodeOutputs: {}, workflow: { id: workflow.id, name: workflow.name }, execution: { id: '', mode: 'webhook' }, parameters: {} });
    const value = resolver.resolveValue(raw, 0);
    return typeof value === 'string' ? value : JSON.stringify(value ?? null);
  } catch (error) {
    logger.warn('debounce key failed; using one key for all events', { 'landflow.workflow.id': workflow.id, error: (error as Error).message });
    return '';
  }
}

/** Queue mode (set by the cluster runtime): a lock across processes, and rows read fresh from the database. */
export interface SharedBuffers {
  exclusive<T>(name: string, fn: () => Promise<T>): Promise<T>;
  refresh(where: Record<string, string>): Promise<void>;
}

export class TriggerBuffers {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private starter?: BufferedStart;
  shared?: SharedBuffers;

  constructor(private readonly db: () => Database = database) {}

  /** Set what starts held runs and re-arm the buffers a restart left (queue mode: the leader's sync() does). */
  start(starter: BufferedStart) {
    this.starter = starter;
    if (!delegated()) this.sync();
  }

  /** Arm the timer of every buffer (or of one, `key`, read fresh in queue mode), and drop timers of buffers gone. */
  async sync(key?: string): Promise<void> {
    if (key) {
      await this.shared?.refresh({ key });
      const row = this.db().get<BufferRow>('SELECT * FROM trigger_buffers WHERE key = ?', key);
      if (row) this.arm(row.key, Date.parse(row.due_at));
      return;
    }
    const rows = this.db().all<BufferRow>('SELECT * FROM trigger_buffers');
    const keys = new Set(rows.map((row) => row.key));
    for (const [held, timer] of this.timers) {
      if (keys.has(held)) continue;
      clearTimeout(timer);
      this.timers.delete(held);
    }
    for (const row of rows) if (!this.timers.has(row.key)) this.arm(row.key, Date.parse(row.due_at));
  }

  /** `add` across processes (queue mode): under a lock for the trigger, with its buffers read fresh, written through. */
  async addExclusive(workflow: Workflow, node: WorkflowNode, items: NodeItem[], mode: ExecutionMode, options: { asOutput?: boolean; now?: number } = {}): Promise<RunBufferedError | undefined> {
    const shared = this.shared;
    if (!shared) return this.add(workflow, node, items, mode, options);
    return shared.exclusive(`buffer:${workflow.id}:${node.id}`, async () => {
      await shared.refresh({ workflow_id: workflow.id });
      const held = this.add(workflow, node, items, mode, options);
      await this.db().flush();
      return held;
    });
  }

  /** Whether runs of this trigger are held at all. */
  static applies(node: WorkflowNode | undefined, mode: ExecutionMode): node is WorkflowNode {
    return Boolean(node && BUFFERED_MODES.has(mode) && (validDebounce(node.debounce) || validBatch(node.batch)));
  }

  /** Hold `items` for the trigger; returns what to tell the caller (a full batch starts its run right away). */
  add(workflow: Workflow, node: WorkflowNode, items: NodeItem[], mode: ExecutionMode, options: { asOutput?: boolean; now?: number } = {}): RunBufferedError | undefined {
    const now = options.now ?? Date.now();
    const debounce = validDebounce(node.debounce);
    const batch = validBatch(node.batch);
    if (debounce) {
      const keyValue = debounceKey(workflow, debounce, items[0] ?? { json: {} });
      const key = `debounce:${workflow.id}:${node.id}:${keyValue}`;
      const result = this.db().transaction(() => {
        const row = this.db().get<BufferRow>('SELECT * FROM trigger_buffers WHERE key = ?', key);
        const data: BufferData = row ? JSON.parse(row.data) : { items: [], mode, debounceKey: keyValue, ...(options.asOutput && { asOutput: true }) };
        data.items = debounce.mode === 'all' ? [...data.items, ...items].slice(-MAX_BUFFERED_ITEMS) : items.slice(-1);
        data.mode = mode;
        const firstAt = row ? Date.parse(row.first_at) : now;
        let due = now + debounce.windowSeconds * 1000;
        if (debounce.maxWaitSeconds && debounce.maxWaitSeconds > 0) due = Math.min(due, firstAt + debounce.maxWaitSeconds * 1000);
        const count = (row?.count ?? 0) + items.length;
        this.db().upsert('trigger_buffers', { key, workflow_id: workflow.id, node_id: node.id, kind: 'debounce', first_at: new Date(firstAt).toISOString(), due_at: new Date(due).toISOString(), count, data: JSON.stringify(data) });
        return { due, count };
      });
      this.arm(key, result.due);
      return new RunBufferedError(workflow.id, 'debounce', key, result.count, new Date(result.due).toISOString());
    }
    if (batch) {
      const key = `batch:${workflow.id}:${node.id}`;
      const result = this.db().transaction(() => {
        const row = this.db().get<BufferRow>('SELECT * FROM trigger_buffers WHERE key = ?', key);
        const data: BufferData = row ? JSON.parse(row.data) : { items: [], mode, ...(options.asOutput && { asOutput: true }) };
        data.items = [...data.items, ...items].slice(-MAX_BUFFERED_ITEMS);
        data.mode = mode;
        const firstAt = row ? Date.parse(row.first_at) : now;
        const due = firstAt + batch.timeoutSeconds * 1000;
        this.db().upsert('trigger_buffers', { key, workflow_id: workflow.id, node_id: node.id, kind: 'batch', first_at: new Date(firstAt).toISOString(), due_at: new Date(due).toISOString(), count: data.items.length, data: JSON.stringify(data) });
        return { due, count: data.items.length };
      });
      if (result.count >= batch.size) {
        void this.flush(key);
        return new RunBufferedError(workflow.id, 'batch', key, result.count, new Date(now).toISOString(), true);
      }
      this.arm(key, result.due);
      return new RunBufferedError(workflow.id, 'batch', key, result.count, new Date(result.due).toISOString());
    }
    return undefined;
  }

  private arm(key: string, dueAt: number) {
    // Queue mode: the leader keeps the timers.
    if (delegated()) return forwardToLeader({ t: 'buffer', key });
    clearTimeout(this.timers.get(key));
    const timer = setTimeout(() => void this.fire(key), Math.max(0, Math.min(dueAt - Date.now(), 2_147_000_000)));
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private async fire(key: string) {
    this.timers.delete(key);
    const row = this.db().get<BufferRow>('SELECT * FROM trigger_buffers WHERE key = ?', key);
    if (!row) return;
    // Pushed back by a later event since the timer was set.
    if (Date.parse(row.due_at) > Date.now() + 5) return this.arm(key, Date.parse(row.due_at));
    await this.flush(key);
  }

  /** Start the held run now (a full batch, a due timer, or a test). */
  async flush(key: string): Promise<boolean> {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    // Taken out in one step: an event arriving now starts a new buffer.
    const take = () =>
      this.db().transaction(() => {
        const found = this.db().get<BufferRow>('SELECT * FROM trigger_buffers WHERE key = ?', key);
        if (found) this.db().delete('trigger_buffers', { key });
        return found;
      });
    const shared = this.shared;
    const row = shared
      ? await shared.exclusive(`buffer:${key.split(':').slice(1, 3).join(':')}`, async () => {
          await shared.refresh({ key });
          const found = take();
          await this.db().flush();
          return found;
        })
      : take();
    if (!row) return false;
    const data = JSON.parse(row.data) as BufferData;
    const saved = store.getWorkflow(row.workflow_id);
    const workflow = saved && (await productionOf(saved));
    const node = workflow?.nodes.find((n) => n.id === row.node_id);
    if (!workflow || !node || !this.starter) {
      logger.warn('held trigger events dropped: the workflow or trigger is gone, or not published', { 'landflow.workflow.id': row.workflow_id, 'landflow.trigger.key': key });
      return false;
    }
    try {
      await this.starter(workflow, node, data.items, data.mode, { kind: row.kind, key, count: Number(row.count), ...(data.asOutput && { asOutput: true }) });
    } catch (error) {
      logger.warn('held trigger run failed', { 'landflow.workflow.id': row.workflow_id, error: (error as Error).message });
    }
    return true;
  }

  /** Buffers waiting, for diagnostics and tests. */
  pending(workflowId?: string): Array<{ key: string; kind: string; count: number; dueAt: string; firstAt: string }> {
    const rows = workflowId ? this.db().all<BufferRow>('SELECT * FROM trigger_buffers WHERE workflow_id = ?', workflowId) : this.db().all<BufferRow>('SELECT * FROM trigger_buffers');
    return rows.map((row) => ({ key: row.key, kind: row.kind, count: Number(row.count), dueAt: row.due_at, firstAt: row.first_at }));
  }

  stop() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

/** The published version of a workflow (held events run on what is published when they flush). */
async function productionOf(workflow: Workflow): Promise<Workflow | undefined> {
  const { productionWorkflow } = await import('./publish');
  return productionWorkflow(workflow);
}

function validDebounce(value: TriggerDebounce | undefined): TriggerDebounce | undefined {
  return value && Number(value.windowSeconds) > 0 ? value : undefined;
}

function validBatch(value: TriggerBatch | undefined): TriggerBatch | undefined {
  return value && Number(value.size) >= 1 && Number(value.timeoutSeconds) > 0 ? value : undefined;
}

export const triggerBuffers = singleton('trigger-buffers', () => new TriggerBuffers());

