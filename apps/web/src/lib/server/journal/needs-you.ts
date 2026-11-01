/**
 * What needs a person across runs (`GET /api/runs/needs-you`): waiting executions whose wait is for a person (a tool
 * approval, a form, an agent's question; not timers, webhooks or sub-workflows) and failed checks of the last 7 days
 * nobody settled yet (read from the journal).
 */
import type { ExecutionRecord } from '../../shared/types';
import type { JournalEvent, RunActor, RunCheck } from '../../shared/run-trace';
import { liveExecution } from '../runner';
import { store } from '../store';
import { openWaitSpan } from './decisions';
import { checksSince, spanStart } from './store';

/** `gate`: a Run report waits for a person to accept its failed checks or send the work back. */
export type NeedsYouKind = 'approval' | 'form' | 'question' | 'gate' | 'check';

export interface NeedsYouItem {
  executionId: string;
  workflowId: string;
  workflowName: string;
  kind: NeedsYouKind;
  title: string;
  detail?: string;
  actor?: RunActor;
  spanId?: string;
  /** ISO: when it started waiting, or when the check failed. */
  since: string;
}

const DAY_MS = 86_400_000;
const CHECK_DAYS = 7;
const MAX_ITEMS = 200;

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function waitItem(record: ExecutionRecord): NeedsYouItem | undefined {
  const wait = record.wait;
  if (!wait) return undefined;
  const data = (wait.data ?? {}) as Record<string, unknown>;
  const node = record.workflow?.nodes.find((n) => n.id === wait.nodeId);
  const actor: RunActor = { id: `node:${wait.nodeId}`, name: wait.nodeName, type: node?.type === 'core.aiAgent' || node?.type === 'core.messageAgent' ? 'agent' : 'system', ...(node && { nodeType: node.type }) };
  const spanId = openWaitSpan(record.executionId);
  const base = { executionId: record.executionId, workflowId: record.workflowId, workflowName: record.workflowName, actor, since: wait.since, ...(spanId && { spanId }) };
  const approval = isObject(data.approval) && Array.isArray(data.approval.calls) ? data.approval : undefined;
  if (approval) {
    const tools = (approval.calls as unknown[]).filter(isObject).map((c) => String(c.tool)).filter(Boolean);
    return { ...base, kind: 'approval', title: tools.length ? `${wait.nodeName} wants to run ${tools.join(', ')}` : `${wait.nodeName} needs an approval`, detail: record.workflowName };
  }
  if (wait.resume === 'form') {
    const form = isObject(data.form) ? data.form : undefined;
    if (isObject(data.runReport) && data.runReport.gate) {
      const failed = Array.isArray(data.runReport.failed) ? data.runReport.failed.filter(isObject) : [];
      return { ...base, kind: 'gate', title: typeof form?.title === 'string' && form.title ? form.title : `${wait.nodeName}: checks failed`, detail: failed.map((c) => String(c.name)).join(' · ') || record.workflowName };
    }
    return { ...base, kind: 'form', title: typeof form?.title === 'string' && form.title ? form.title : `${wait.nodeName}: fill in the form`, detail: record.workflowName };
  }
  if (isObject(data.pause) && data.pause.type === 'question') return { ...base, kind: 'question', title: `${wait.nodeName} asks a question`, detail: record.workflowName };
  return undefined;
}

type CheckEvent = Extract<JournalEvent, { type: 'check' }>;

/** Failed checks whose latest word is the failure: not passed since, not accepted or sent back. */
function failedChecks(now: number): CheckEvent[] {
  const latest = new Map<string, CheckEvent>();
  for (const event of checksSince(new Date(now - CHECK_DAYS * DAY_MS).toISOString())) {
    if (event.type === 'check') latest.set(`${event.executionId}\u0000${event.spanId}\u0000${event.check.name}\u0000${event.check.subject ?? ''}`, event);
  }
  return [...latest.values()].filter((event) => event.check.status === 'fail' && !event.check.resolution);
}

/** The items for the executions `visible` allows (undefined: all), newest first. */
export function needsYou(visible: Set<string> | undefined, now = Date.now()): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  // A run whose Run report waits on its failed checks shows them once, as that wait.
  const gated = new Set<string>();
  for (const record of store.waitingExecutions()) {
    if (visible && !visible.has(record.workflowId)) continue;
    const item = waitItem(record);
    if (item) items.push(item);
    if (item?.kind === 'gate') gated.add(record.executionId);
  }
  const names = new Map<string, { workflowId: string; workflowName: string }>();
  for (const event of failedChecks(now)) {
    if (gated.has(event.executionId)) continue;
    let execution = names.get(event.executionId);
    if (!execution) {
      const record = liveExecution(event.executionId) ?? store.getExecution(event.executionId);
      if (!record) continue;
      names.set(event.executionId, (execution = { workflowId: record.workflowId, workflowName: record.workflowName }));
    }
    if (visible && !visible.has(execution.workflowId)) continue;
    const actor = spanStart(event.executionId, event.spanId)?.actor;
    const check: RunCheck = event.check;
    items.push({
      executionId: event.executionId,
      workflowId: execution.workflowId,
      workflowName: execution.workflowName,
      kind: 'check',
      title: check.name,
      ...((check.message || check.subject) && { detail: (check.message ?? check.subject)! }),
      ...(actor && { actor }),
      spanId: event.spanId,
      since: event.at,
    });
  }
  return items.sort((a, b) => b.since.localeCompare(a.since)).slice(0, MAX_ITEMS);
}
