/**
 * Which runs a rule alerts on. Pure functions over an execution record, so they are easy to test: what a finished run
 * counts as (`eventsOf`), whether a rule watches it (`watches`), and when a waiting run has waited too long.
 */
import type { Workflow } from '@landflow/engine';
import { DEFAULT_WAITING_MINUTES, type AlertEvent, type AlertRule, type AlertScope } from '../../shared/alerts';
import type { ExecutionRecord } from '../../shared/types';

/** Runs started from the editor: only rules with `includeManual` alert on them. */
const MANUAL_MODES = new Set(['manual', 'chat']);

/** The engine's timeout errors: "Workflow timed out after 30 s", "Node timed out after 10 s". */
const TIMEOUT = /\b(?:Workflow|Node) timed out after \d+ s\b/;

/**
 * What a finished run counts as: nothing unless it failed for good (no automatic retry pending); then `failed`, plus
 * `timedOut` when a timeout failed it and `retriesExhausted` when it was itself an automatic retry.
 */
export function eventsOf(record: Pick<ExecutionRecord, 'status' | 'retryAt' | 'retryOf' | 'error'>): AlertEvent[] {
  if (record.status !== 'error' || record.retryAt) return [];
  const events: AlertEvent[] = ['failed'];
  if (TIMEOUT.test(record.error?.message ?? '')) events.push('timedOut');
  if (record.retryOf) events.push('retriesExhausted');
  return events;
}

/** The event a message leads with: the most specific one. */
export function headlineEvent(events: AlertEvent[]): AlertEvent {
  for (const event of ['timedOut', 'retriesExhausted', 'waiting', 'failed'] as const) if (events.includes(event)) return event;
  return events[0] ?? 'failed';
}

/** Whether a scope covers a workflow. */
export function inScope(scope: AlertScope, workflowId: string, tags: readonly string[] = []): boolean {
  if (scope.mode === 'ids') return Boolean(scope.ids?.includes(workflowId));
  if (scope.mode === 'tags') {
    const wanted = new Set((scope.tags ?? []).map((tag) => tag.toLowerCase()));
    return tags.some((tag) => wanted.has(tag.toLowerCase()));
  }
  return true;
}

/**
 * Whether an enabled rule watches this run: production top-level runs of a workflow in its scope (editor runs with
 * `includeManual`). Sub-executions are left to their parent, debug and evaluation runs are never alerted.
 */
export function watches(rule: AlertRule, record: ExecutionRecord, workflow?: Pick<Workflow, 'tags'>): boolean {
  if (!rule.enabled || !rule.channelIds.length) return false;
  if (record.debug || record.evaluation || record.parentExecutionId) return false;
  if (MANUAL_MODES.has(record.mode) && !rule.includeManual) return false;
  return inScope(rule.workflows, record.workflowId, workflow?.tags ?? record.workflow?.tags);
}

/** The events of a finished run this rule alerts on. */
export function matchingEvents(rule: AlertRule, events: AlertEvent[]): AlertEvent[] {
  return events.filter((event) => rule.events.includes(event));
}

/** When a waiting run started waiting. */
export function waitingSince(record: Pick<ExecutionRecord, 'wait' | 'startedAt' | 'finishedAt'>): string {
  return record.wait?.since ?? record.finishedAt ?? record.startedAt;
}

/**
 * Whether a waiting run has waited longer than the rule allows. A Wait node's timer that hasn't come due is on
 * schedule, not stuck; forms, webhooks, approvals and sub-workflows count from when the run started waiting.
 */
export function waitedTooLong(rule: AlertRule, record: ExecutionRecord, now = Date.now()): boolean {
  if (record.status !== 'waiting' || !rule.events.includes('waiting')) return false;
  if (record.wait?.resume === 'time' && record.wait.until && Date.parse(record.wait.until) > now) return false;
  const minutes = rule.waitingMinutes && rule.waitingMinutes > 0 ? rule.waitingMinutes : DEFAULT_WAITING_MINUTES;
  return now - Date.parse(waitingSince(record)) >= minutes * 60_000;
}
