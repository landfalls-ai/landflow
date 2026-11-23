/**
 * What needs a person across runs (`GET /api/runs/needs-you`): waiting executions whose wait is for a person (a tool
 * approval, a form, an agent's question; not timers, webhooks or sub-workflows) and failed checks of the last 7 days
 * nobody settled yet (read from the journal).
 */
import type { InboxItemFields } from '../../shared/approval-inbox'; // AP01:
import { isFallbackReason, judgeTitle, type FallbackReason } from '../../shared/judge'; // C13:
import type { ExecutionRecord } from '../../shared/types';
import type { JournalEvent, RunActor, RunCheck } from '../../shared/run-trace';
import { openAsks } from '../a2a/agent-asks';
import { canDecide } from '../approval-inbox/access'; // AP01:
import { waitingOfExecution } from '../approval-inbox/store'; // AP01:
import { ticketsOf } from '../approval-inbox/tickets'; // C12:
import type { Actor } from '../projects/access'; // AP01:
import { liveExecution } from '../runner';
import { store } from '../store';
import { openWaitSpan } from './decisions';
import { checksSinceAsync, spanStartAsync } from './store';

/** `gate`: a Run report waits for a person to accept its failed checks or send the work back. `budget` (PC14): a project's AI budget warning or stop. `spend` (SP23): a forecast over a cap or unusual AI spend. */
export type NeedsYouKind = 'approval' | 'form' | 'question' | 'gate' | 'check' | 'budget' | 'task' | 'spend'; // SP23: spend

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
  // PC14: a `budget` item's fields (lib/shared/project-budget.ts `BudgetNeedsYouFields`); its executionId, workflowId and workflowName are ''.
  projectId?: string;
  incidentId?: string;
  incidentKind?: 'warn' | 'stop';
  href?: string;
  canRaise?: boolean;
  canResume?: boolean;
  // PC19: a `task` item's fields (lib/shared/project-tasks.ts `TaskNeedsYouFields`); its executionId, workflowId and workflowName are ''.
  taskId?: string;
  taskRunId?: string;
  taskRunStatus?: 'requested' | 'waiting';
  canDecide?: boolean;
  // SP23: a `spend` item's fields (ai-usage/spend-flags.ts); its executionId, workflowId and workflowName are ''.
  flagId?: string;
  flagKind?: 'anomaly' | 'forecast';
  canAcknowledge?: boolean;
  // AP01: an `approval` item whose wait is an approval-inbox request (lib/shared/approval-inbox.ts `InboxItemFields`): one item per waiting request.
  requestId?: InboxItemFields['requestId'];
  inboxStatus?: InboxItemFields['inboxStatus'];
  tool?: InboxItemFields['tool'];
  agentName?: InboxItemFields['agentName'];
  agentVersion?: InboxItemFields['agentVersion'];
  workflowVersion?: InboxItemFields['workflowVersion'];
  destination?: InboxItemFields['destination'];
  expiresAt?: InboxItemFields['expiresAt'];
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

/** C13: the reason code a judge request stored (fixed words), never the model's text. */
function judgeWhyOf(row: { evidence: string | null }): FallbackReason | undefined {
  try {
    const why = (JSON.parse(row.evidence ?? 'null') as { fallbackReason?: unknown } | null)?.fallbackReason;
    return isFallbackReason(why) ? why : undefined;
  } catch {
    return undefined;
  }
}
const judgeConfidenceOf = (row: { evidence: string | null }): number | undefined => {
  try {
    const c = (JSON.parse(row.evidence ?? 'null') as { confidence?: unknown } | null)?.confidence;
    return typeof c === 'number' ? c : undefined;
  } catch {
    return undefined;
  }
};

/** AP01: one item per request of an approval-inbox wait that still waits ("“Alert mailer” wants to run “Send Email”"). */
function inboxItems(record: ExecutionRecord, actor: Actor | undefined): NeedsYouItem[] {
  const wait = record.wait;
  const inbox = (wait?.data as Record<string, unknown> | undefined)?.inbox;
  if (!wait || !isObject(inbox) || !isObject(inbox.ids)) return [];
  const node = record.workflow?.nodes.find((n) => n.id === wait.nodeId);
  const actorOf: RunActor = { id: `node:${wait.nodeId}`, name: wait.nodeName, type: 'agent', ...(node && { nodeType: node.type }) };
  const spanId = openWaitSpan(record.executionId);
  const ids = new Set(Object.values(inbox.ids).map(String));
  return waitingOfExecution(record.executionId)
    .filter((row) => ids.has(row.id))
    .map((row): NeedsYouItem => {
      const version = row.agent_version === null ? undefined : row.agent_version === 'draft' ? 'draft' : Number(row.agent_version);
      const workflowVersion = row.workflow_version === null ? undefined : Number(row.workflow_version);
      const tickets = ticketsOf(row.id);
      return {
        executionId: record.executionId,
        workflowId: record.workflowId,
        workflowName: record.workflowName,
        kind: 'approval',
        title: row.kind === 'judge' ? judgeTitle(row.tool, judgeWhyOf(row) ?? 'no decision', judgeConfidenceOf(row)) : `“${row.agent_name}” wants to run “${row.tool}”`,
        detail: [row.destination, workflowVersion !== undefined ? `${record.workflowName} v${workflowVersion}` : record.workflowName].filter(Boolean).join(' · '),
        actor: actorOf,
        ...(spanId && { spanId }),
        since: row.requested_at,
        requestId: row.id,
        inboxStatus: row.status,
        ...(row.kind === 'judge' && { inboxKind: 'judge' as const, ...(judgeWhyOf(row) && { judgeWhy: judgeWhyOf(row) }) }),
        tool: row.tool,
        ...(tickets.length && { tickets }),
        agentName: row.agent_name,
        ...(version !== undefined && { agentVersion: version as number | 'draft' }),
        ...(workflowVersion !== undefined && { workflowVersion }),
        ...(row.destination && { destination: row.destination }),
        expiresAt: row.expires_at,
        canDecide: canDecide(actor, row),
      };
    });
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
export async function needsYou(visible: Set<string> | undefined, now = Date.now(), actor?: Actor): Promise<NeedsYouItem[]> {
  const items: NeedsYouItem[] = [];
  // A run whose Run report waits on its failed checks shows them once, as that wait.
  const gated = new Set<string>();
  for (const record of store.waitingExecutions()) {
    if (visible && !visible.has(record.workflowId)) continue;
    // AP01: an approval-inbox wait shows one item per waiting request; rows already settled never show.
    const inbox = inboxItems(record, actor);
    if (inbox.length) {
      items.push(...inbox);
      continue;
    }
    if ((record.wait?.data as Record<string, unknown> | undefined)?.inbox) continue;
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
