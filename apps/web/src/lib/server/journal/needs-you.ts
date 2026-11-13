/**
 * What needs a person across runs (`GET /api/runs/needs-you`): waiting executions whose wait is for a person (a tool
 * approval, a form, an agent's question; not timers, webhooks or sub-workflows) and failed checks of the last 7 days
 * nobody settled yet (read from the journal).
 */
import type { ExecutionRecord } from '../../shared/types';
import type { JournalEvent, RunActor, RunCheck } from '../../shared/run-trace';
import { openAsks } from '../a2a/agent-asks';
import { liveExecution } from '../runner';
import { store } from '../store';
import { openWaitSpan } from './decisions';
import { checksSinceAsync, spanStartAsync } from './store';

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
  /** The team member it is for (a member's tool or a guard's ask), when the wait names one. */
  member?: string;
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
    // Ask a Person: the node's question, and who is asked.
    const confirm = isObject(approval.confirm) ? approval.confirm : undefined;
    if (confirm) {
      const who = Array.isArray(confirm.approvers) && confirm.approvers.length ? confirm.approvers.map(String).join(', ') : undefined;
      return { ...base, kind: 'approval', title: `Waiting for ${who ?? 'a person'}: ${String(confirm.title)}`, detail: record.workflowName };
    }
    const tools = (approval.calls as unknown[]).filter(isObject).map((c) => String(c.tool)).filter(Boolean);
    // A team member's tool (Run a Team): who wants it, and what for.
    const team = isObject(data.teamApproval) ? data.teamApproval : undefined;
    if (team) return { ...base, ...(typeof team.member === 'string' && { member: team.member }), kind: 'approval', title: `${String(team.member)} wants to use ${String(team.tool)}`, detail: typeof team.summary === 'string' && team.summary ? team.summary : record.workflowName };
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
async function failedChecks(now: number): Promise<CheckEvent[]> {
  const latest = new Map<string, CheckEvent>();
  for (const event of await checksSinceAsync(new Date(now - CHECK_DAYS * DAY_MS).toISOString())) {
    if (event.type === 'check') latest.set(`${event.executionId}\u0000${event.spanId}\u0000${event.check.name}\u0000${event.check.subject ?? ''}`, event);
  }
  return [...latest.values()].filter((event) => event.check.status === 'fail' && !event.check.resolution);
}

/** The items for the executions `visible` allows (undefined: all), newest first. */
export async function needsYou(visible: Set<string> | undefined, now = Date.now()): Promise<NeedsYouItem[]> {
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
  const nameOf = async (executionId: string) => {
    let execution = names.get(executionId);
    if (!execution) {
      const record = liveExecution(executionId) ?? (await store.loadExecution(executionId));
      if (record) names.set(executionId, (execution = { workflowId: record.workflowId, workflowName: record.workflowName }));
    }
    return execution;
  };
  // A command a Claude Code member asks about (a push to main): the run goes on, a person's word lets it through.
  for (const ask of openAsks()) {
    const execution = await nameOf(ask.executionId);
    if (!execution || (visible && !visible.has(execution.workflowId))) continue;
    items.push({
      executionId: ask.executionId,
      workflowId: execution.workflowId,
      workflowName: execution.workflowName,
      kind: 'approval',
      ...(ask.member && { member: ask.member }),
      title: `${ask.member ?? 'An agent'} wants to run ${ask.command.length > 120 ? `${ask.command.slice(0, 119)}…` : ask.command}`,
      detail: execution.workflowName,
      spanId: ask.spanId,
      since: ask.createdAt,
    });
  }
  for (const event of await failedChecks(now)) {
    if (gated.has(event.executionId)) continue;
    const execution = await nameOf(event.executionId);
    if (!execution) continue;
    if (visible && !visible.has(execution.workflowId)) continue;
    const actor = (await spanStartAsync(event.executionId, event.spanId))?.actor;
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
