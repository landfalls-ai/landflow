/**
 * On Usage Event (core.usageTrigger, nodes/usage.ts): published workflows that start from it run when the ledger records
 * a matching event. Events are batched per trigger (its *Batch Seconds*, default 10) into one run, one item per event.
 *
 * Loops can't form: events from workflows that start from On Usage Event themselves never fire it, whether they are about that workflow or written by it (Record Event's `recordedBy`). A trigger sees the
 * events its workflow's creator could see (./scope.ts). Each process fires for the events it recorded.
 */
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { NodeItem } from '@landflow/sdk';
import { attrsMatch, detectorFilter, parseAttrEquals, type UsageEvent, type UsageKind } from '../../shared/brain';
import { workflowForCall } from '../publish';
import { runWorkflow } from '../runner';
import { singleton } from '../singleton';
import { agentStore } from '../agents/store';
import { store } from '../store';
import { logger } from '../telemetry/logger';
import { fireTrigger } from '../telemetry/triggers';
import { database } from '../db';
import { onUsage } from '../usage/ledger';
import { getProposal } from './proposals';
import { covers, scopeForWorkflow } from './scope';

export const USAGE_TRIGGER = 'core.usageTrigger';
const CACHE_MS = 5_000;

interface Armed {
  workflow: Workflow;
  node: WorkflowNode;
}

const state = () =>
  singleton('usage-trigger', () => ({
    armed: { at: 0, list: [] as Armed[] },
    pending: new Map<string, { events: UsageEvent[]; timer: NodeJS.Timeout }>(),
    started: false,
  }));

const hasTrigger = (workflow: Workflow | undefined) => Boolean(workflow?.nodes.some((n) => n.type === USAGE_TRIGGER));

/** Published workflows with an enabled On Usage Event, re-read at most every 5 seconds. */
function armed(): Armed[] {
  const s = state();
  if (Date.now() - s.armed.at < CACHE_MS) return s.armed.list;
  const list: Armed[] = [];
  for (const saved of store.listWorkflows()) {
    if (!saved.active || !hasTrigger(saved)) continue;
    const workflow = workflowForCall(saved.id, 'trigger') ?? saved;
    for (const node of workflow.nodes) if (node.type === USAGE_TRIGGER && !node.disabled) list.push({ workflow, node });
  }
  s.armed = { at: Date.now(), list };
  return list;
}

const asList = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : typeof value === 'string' && value ? value.split(',').map((v) => v.trim()) : []);

/** Whether `event` is one `node` asks for (its kinds and filters). */
export function matches(event: UsageEvent, parameters: Record<string, unknown>): boolean {
  const kinds = asList(parameters.kinds) as UsageKind[];
  if (kinds.length && !kinds.includes(event.kind)) return false;
  if (!attrsMatch(event.attrs, parseAttrEquals(parameters.attrEquals))) return false;
  const workflowId = typeof parameters.workflowId === 'string' ? parameters.workflowId.trim() : '';
  if (workflowId && event.workflowId !== workflowId) return false;
  const detector = detectorFilter(parameters.detector);
  if (detector && event.kind === 'proposal.applied' && event.attrs?.detector !== detector) return false;
  const minCost = Number(parameters.minCost ?? 0);
  if (minCost > 0 && (event.cost ?? 0) < minCost) return false;
  if (parameters.onlyNew === true && event.kind === 'node.failed') {
    if (!event.signature) return false;
    const seen = Number(
      database().get<{ n: number }>('SELECT COUNT(*) AS n FROM usage_events WHERE signature = ? AND id <> ? AND at < ?', event.signature, event.id, event.at)?.n ?? 0,
    );
    if (seen > 0) return false;
  }
  return true;
}

/**
 * The trigger's items, one per event. The workflow's and agent's names ride along, so a message needs no lookup; an
 * applied suggestion rides whole (its why and evidence are longer than an event's attributes keep), for a flow that acts
 * on it.
 */
export function usageItems(events: UsageEvent[]): NodeItem[] {
  return events.map((event) => {
    const workflowName = event.workflowId ? store.getWorkflow(event.workflowId)?.name : undefined;
    const agentName = event.agentId ? agentStore.get(event.agentId)?.name : undefined;
    const applied = event.kind === 'proposal.applied' && typeof event.attrs?.proposal === 'string' ? getProposal(event.attrs.proposal) : undefined;
    const proposal = applied && { id: applied.id, detector: applied.detector, title: applied.title, why: applied.why, target: applied.target, evidence: applied.evidence, effect: applied.effect, appliedBy: applied.appliedBy };
    return { json: { ...event, ...(workflowName && { workflowName }), ...(agentName && { agentName }), ...(proposal && { proposal }) } as unknown as NodeItem['json'] };
  });
}

function flush(key: string, entry: Armed) {
  const s = state();
  const pending = s.pending.get(key);
  s.pending.delete(key);
  if (!pending?.events.length) return;
  const items = usageItems(pending.events);
  void fireTrigger({ source: 'usage', workflowId: entry.workflow.id, nodeName: entry.node.name }, () =>
    runWorkflow({ workflow: entry.workflow, mode: 'trigger', startNodeId: entry.node.id, triggerItems: items }),
  ).catch((error) => logger.warn('On Usage Event could not start its workflow', { error, 'landflow.workflow.id': entry.workflow.id }));
}

export function dispatchUsage(event: UsageEvent) {
  // No loops: what a usage-triggered workflow does never triggers one.
  if (event.workflowId && hasTrigger(store.getWorkflow(event.workflowId))) return;
  // Record Event notes which workflow wrote the event: one that starts from On Usage Event can't start another through it either.
  const recordedBy = typeof event.attrs?.recordedBy === 'string' ? event.attrs.recordedBy : undefined;
  if (recordedBy && hasTrigger(store.getWorkflow(recordedBy))) return;
  const s = state();
  for (const entry of armed()) {
    if (!matches(event, entry.node.parameters ?? {})) continue;
    if (!covers(scopeForWorkflow(entry.workflow.id), { workflowId: event.workflowId, agentId: event.agentId })) continue;
    const key = `${entry.workflow.id}|${entry.node.id}`;
    const pending = s.pending.get(key);
    if (pending) {
      if (pending.events.length < 500) pending.events.push(event);
      continue;
    }
    const seconds = Math.max(0, Math.min(3_600, Number(entry.node.parameters?.batchSeconds ?? 10) || 0));
    const timer = setTimeout(() => flush(key, entry), seconds * 1_000);
    timer.unref?.();
    s.pending.set(key, { events: [event], timer });
  }
}

/** Listen to the ledger (every process, once). */
export function startUsageTrigger() {
  const s = state();
  if (s.started) return;
  s.started = true;
  onUsage(dispatchUsage);
}

/** Forget the cached list (tests, after publishing). */
export function resetUsageTrigger() {
  const s = state();
  s.armed = { at: 0, list: [] };
  for (const pending of s.pending.values()) clearTimeout(pending.timer);
  s.pending.clear();
}
