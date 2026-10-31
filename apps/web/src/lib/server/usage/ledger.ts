/**
 * The usage ledger (docs/second-brain.md#1-the-usage-ledger): one `usage_events` row per thing that happened on the
 * platform, fed where the data already passes: finished executions (store.saveExecution), the audit writer, the AI usage
 * meter, agent runs and feedback (./listeners), the assistant's feedback route, Spotlight and template use.
 *
 * Metadata only. Node types, durations, counts, tokens and costs go in; item contents never do. Error messages and texts
 * people typed are redacted (emails, URLs' queries, tokens, long numbers, ids) and clipped, and a failure's signature is
 * a hash of its normalized message, so the same failure groups whatever its details.
 *
 * Recording never fails what it records: errors are logged and dropped. LANDFLOW_BRAIN=false turns the ledger off.
 */
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Workflow } from '@landflow/engine';
import type { AuditEvent } from '../../shared/audit';
import type { UsageAttr, UsageEvent, UsageKind } from '../../shared/brain';
import type { ExecutionRecord } from '../../shared/types';
import { database, type Database } from '../db';
import { homeProjectId } from '../projects/store';
import { instanceTimezone } from '../settings';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';

const MESSAGE_MAX = 300;
/** A node run this slow, or most of a run that took a second or more, is recorded as `node.slow`. */
export const SLOW_NODE_MS = 2_000;

export const brainEnabled = () => process.env.LANDFLOW_BRAIN?.trim().toLowerCase() !== 'false';

// ---------------------------------------------------------------------------
// Redaction and signatures
// ---------------------------------------------------------------------------

const REDACTIONS: Array<[RegExp, string]> = [
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>'],
  [/\b(?:bearer|basic|token|key|secret|password|pwd)[=: ]+\S+/gi, '<secret>'],
  [/(https?:\/\/[^\s?#"']+)\?[^\s"']*/g, '$1?<query>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>'],
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g, '<token>'],
  [/\b\d{4,}\b/g, '<n>'],
];

/** A message or text with personal details and secrets replaced, clipped to 300 characters. */
export function redact(text: string | undefined): string | undefined {
  if (!text) return undefined;
  let out = text.replace(/\s+/g, ' ').trim();
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out.length > MESSAGE_MAX ? `${out.slice(0, MESSAGE_MAX - 1)}…` : out || undefined;
}

/** The same failure on the same node type has the same signature, whatever its numbers, ids and quoted values. */
export function signatureOf(nodeType: string | undefined, message: string | undefined): string | undefined {
  if (!message) return undefined;
  const normal = (redact(message) ?? '')
    .toLowerCase()
    .replace(/["'`“”‘’][^"'`“”‘’]{0,80}["'`“”‘’]/g, '<v>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha1').update(`${nodeType ?? ''}|${normal}`).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export type UsageInput = Omit<UsageEvent, 'id' | 'at' | 'day'> & { id?: string; at?: string };
type Listener = (event: UsageEvent) => void;

const listeners = () => singleton('usage-listeners', () => new Set<Listener>());

/** Hear of every event recorded in this process (On Usage Event, lib/server/brain/usage-trigger.ts). */
export function onUsage(listener: Listener): () => void {
  listeners().add(listener);
  return () => listeners().delete(listener);
}

/** YYYY-MM-DD in the instance time zone (as Insights and AI usage count days). */
export function dayOf(ms: number, timezone = safeTimezone()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

function safeTimezone(): string {
  try {
    return instanceTimezone();
  } catch {
    return 'UTC';
  }
}

const finite = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : undefined);

function cleanAttrs(attrs: Record<string, UsageAttr | undefined> | undefined): Record<string, UsageAttr> | undefined {
  if (!attrs) return undefined;
  const out: Record<string, UsageAttr> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === '') continue;
    out[key] = typeof value === 'string' ? value.slice(0, 200) : value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Record one event. Returns it, or undefined when the ledger is off or the write failed. */
export function recordUsage(input: UsageInput, db: Database = database()): UsageEvent | undefined {
  if (!brainEnabled()) return undefined;
  try {
    const atMs = input.at ? Date.parse(input.at) : Date.now();
    const at = new Date(Number.isFinite(atMs) ? atMs : Date.now());
    const projectId = input.projectId ?? (input.workflowId ? homeProjectId('workflow', input.workflowId) : input.agentId ? homeProjectId('agent', input.agentId) : undefined);
    const event: UsageEvent = {
      id: input.id ?? `ue_${nanoid(14)}`,
      at: at.toISOString(),
      day: dayOf(at.getTime()),
      kind: input.kind,
      ...(projectId && { projectId }),
      ...(input.workflowId && { workflowId: input.workflowId }),
      ...(input.nodeId && { nodeId: input.nodeId }),
      ...(input.nodeType && { nodeType: input.nodeType }),
      ...(input.agentId && { agentId: input.agentId }),
      ...(input.actorId && { actorId: input.actorId }),
      ...(input.executionId && { executionId: input.executionId }),
      ...(input.signature && { signature: input.signature }),
      ...(input.message && { message: redact(input.message) }),
      ...(finite(input.durationMs) !== undefined && { durationMs: input.durationMs }),
      ...(finite(input.items) !== undefined && { items: input.items }),
      ...(finite(input.tokens) !== undefined && { tokens: input.tokens }),
      ...(finite(input.cost) !== undefined && { cost: input.cost }),
      ...(cleanAttrs(input.attrs) && { attrs: cleanAttrs(input.attrs) }),
    };
    const inserted = db.insertNew('usage_events', toRow(event));
    if (!inserted) return undefined;
    for (const listener of listeners()) {
      try {
        listener(event);
      } catch (error) {
        logger.warn('a usage listener failed', { error });
      }
    }
    return event;
  } catch (error) {
    logger.warn('could not record a usage event', { error, 'landflow.usage.kind': input.kind });
    return undefined;
  }
}

export interface UsageRow {
  id: string;
  at: string;
  day: string;
  kind: string;
  project_id: string | null;
  workflow_id: string | null;
  node_id: string | null;
  node_type: string | null;
  agent_id: string | null;
  actor_id: string | null;
  execution_id: string | null;
  signature: string | null;
  message: string | null;
  duration_ms: number | null;
  items: number | null;
  tokens: number | null;
  cost: number | null;
  attrs: string | null;
}

const toRow = (e: UsageEvent) => ({
  id: e.id,
  at: e.at,
  day: e.day,
  kind: e.kind,
  project_id: e.projectId ?? null,
  workflow_id: e.workflowId ?? null,
  node_id: e.nodeId ?? null,
  node_type: e.nodeType ?? null,
  agent_id: e.agentId ?? null,
  actor_id: e.actorId ?? null,
  execution_id: e.executionId ?? null,
  signature: e.signature ?? null,
  message: e.message ?? null,
  duration_ms: e.durationMs ?? null,
  items: e.items ?? null,
  tokens: e.tokens ?? null,
  cost: e.cost ?? null,
  attrs: e.attrs ? JSON.stringify(e.attrs) : null,
});

export function fromRow(row: UsageRow): UsageEvent {
  let attrs: Record<string, UsageAttr> | undefined;
  try {
    attrs = row.attrs ? (JSON.parse(row.attrs) as Record<string, UsageAttr>) : undefined;
  } catch {
    attrs = undefined;
  }
  return {
    id: row.id,
    at: row.at,
    day: row.day,
    kind: row.kind as UsageKind,
    ...(row.project_id && { projectId: row.project_id }),
    ...(row.workflow_id && { workflowId: row.workflow_id }),
    ...(row.node_id && { nodeId: row.node_id }),
    ...(row.node_type && { nodeType: row.node_type }),
    ...(row.agent_id && { agentId: row.agent_id }),
    ...(row.actor_id && { actorId: row.actor_id }),
    ...(row.execution_id && { executionId: row.execution_id }),
    ...(row.signature && { signature: row.signature }),
    ...(row.message && { message: row.message }),
    ...(row.duration_ms !== null && { durationMs: Number(row.duration_ms) }),
    ...(row.items !== null && { items: Number(row.items) }),
    ...(row.tokens !== null && { tokens: Number(row.tokens) }),
    ...(row.cost !== null && { cost: Number(row.cost) }),
    ...(attrs && { attrs }),
  };
}

// ---------------------------------------------------------------------------
// Where the data passes
// ---------------------------------------------------------------------------

/**
 * A finished execution: `run.finished`, a `node.failed` per failed node run and a `node.slow` per slow one. Sub-node runs
 * count too (a failing tool), with the root node in `attrs.parent`. Ids come from the execution (`idPrefix` overrides it).
 */
export function recordExecutionUsage(record: ExecutionRecord, workflow?: Workflow, idPrefix?: string) {
  if (!brainEnabled() || record.status === 'running' || record.status === 'waiting') return;
  try {
    const wf = workflow ?? record.workflow;
    const typeOf = new Map((wf?.nodes ?? []).map((n) => [n.id, n.type]));
    const at = record.finishedAt ?? record.startedAt;
    // Ids from the execution: saving the record again (or the backfill finding it) records nothing twice.
    const id = (suffix: string) => `${idPrefix ?? `ex:${record.executionId}`}:${suffix}`;
    const lastRun = record.lastNodeId ? record.runData[record.lastNodeId]?.at(-1) : undefined;
    const base = { workflowId: record.workflowId, executionId: record.executionId, at, ...(record.startedBy && { actorId: record.startedBy }) };
    recordUsage({
      ...base,
      id: id('run'),
      kind: 'run.finished',
      durationMs: record.durationMs,
      items: lastRun?.outputs?.[0]?.length ?? 0,
      ...(record.error && { message: record.error.message, signature: signatureOf(record.error.nodeId ? typeOf.get(record.error.nodeId) : undefined, record.error.message) }),
      attrs: {
        status: record.status,
        mode: record.mode,
        ...(record.retryAttempt && { retry: record.retryAttempt }),
        ...(record.versionNumber && { version: record.versionNumber }),
        ...(record.errorOf && { errorWorkflow: true }),
        ...(record.parentExecutionId && { sub: true }),
        nodes: Object.keys(record.runData).length,
      },
    });
    for (const [nodeId, runs] of Object.entries(record.runData)) {
      runs.forEach((run, index) => {
        if (run.reused) return;
        const nodeType = typeOf.get(nodeId);
        const common = { ...base, nodeId, nodeType, durationMs: run.durationMs, attrs: { mode: record.mode, ...(run.parentNodeId && { parent: run.parentNodeId }) } };
        if (run.error) {
          recordUsage({ ...common, id: id(`fail:${nodeId}:${index}`), kind: 'node.failed', message: run.error.message, signature: signatureOf(nodeType, run.error.message) });
        } else if (run.durationMs >= SLOW_NODE_MS || (record.durationMs >= 1_000 && run.durationMs >= record.durationMs * 0.5 && !run.parentNodeId)) {
          recordUsage({ ...common, id: id(`slow:${nodeId}:${index}`), kind: 'node.slow', items: run.outputs?.[0]?.length ?? 0 });
        }
      });
    }
  } catch (error) {
    logger.warn('could not record the usage of an execution', { error, 'landflow.execution.id': record.executionId });
  }
}

/** Audit actions the ledger keeps, and as what. */
const AUDIT_KINDS: Record<string, UsageKind> = {
  'workflow.create': 'workflow.saved',
  'workflow.update': 'workflow.saved',
  'workflow.import': 'workflow.saved',
  'workflow.publish': 'workflow.published',
  'workflow.rollback': 'workflow.published',
  'credential.use': 'credential.used',
  'marketplace.install': 'plugin.installed',
};

/** An audit event the ledger keeps (see AUDIT_KINDS), with the target and who did it. */
export function recordAuditUsage(event: AuditEvent, idPrefix = 'au') {
  const kind = AUDIT_KINDS[event.action];
  if (!kind || event.outcome !== 'success') return;
  const details = (event.details ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const workflowId = event.target?.type === 'workflow' ? event.target.id : str(details.workflowId);
  recordUsage({
    id: `${idPrefix}:${event.id}`,
    at: event.at,
    kind,
    ...(event.projectId && { projectId: event.projectId }),
    ...(workflowId && { workflowId }),
    ...(event.actor.id && { actorId: event.actor.id }),
    ...(str(details.executionId) && { executionId: str(details.executionId) }),
    ...(kind === 'credential.used' && { nodeType: str(details.nodeType) }),
    attrs: {
      action: event.action,
      ...(event.target?.type && event.target.type !== 'workflow' && { targetType: event.target.type }),
      ...(event.target?.type === 'credential' && event.target.id && { credentialId: event.target.id }),
      ...(event.target?.type === 'credential' && event.target.name && { credentialName: event.target.name }),
      ...(kind === 'plugin.installed' && event.target?.name && { plugin: event.target.name }),
      ...(str(details.source) && { source: str(details.source) }),
      ...(typeof details.nodes === 'number' && { nodes: details.nodes }),
    },
  });
}
