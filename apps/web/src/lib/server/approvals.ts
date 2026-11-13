/**
 * Tool approvals of AI Agent nodes in workflows (docs/agents.md → Tool approvals). An AI Agent whose
 * tool call needs a person puts the execution to wait (`resume: 'webhook'`, `rerun: true`) with
 * `wait.data.approval` = { nodeName, calls, channel, slack? }. A decision arrives from the editor's chat
 * panel or the execution view (POST /api/executions/:id/approvals, signed in) or from a Slack button
 * (/api/slack/interactions); it is stored on the waiting record, and once every call has one the
 * execution resumes with `{ decisions }` and the agent node continues its loop.
 *
 * The Ask a Person node (nodes/confirm.ts) waits the same way with one call, `confirm`, and `wait.data.approval.confirm`
 * = { title, text, allowEdit, ... }: its decision may also carry the text a person edited and a comment.
 */
import type { JsonObject } from '@landflow/protocol';
import type { ExecutionEvent } from '@landflow/engine';
import type { ExecutionRecord } from '../shared/types';
import { recordDecision } from './journal/decisions';
import { liveExecution, resumeExecution } from './runner';
import { confirmDecidedBlocks, decidedBlocks, slackCredentialFor, slackRefOf, updateMessage } from './slack';
import { store } from './store';
import { logger } from './telemetry';
import { HttpError } from './errors';

export interface ApprovalCall {
  id: string;
  tool: string;
  input: JsonObject;
}

export interface ApprovalDecision {
  approved: boolean;
  /** "slack:U123", a user's email, or absent. */
  by?: string;
  at: string;
  /** The input a person changed before approving: the tool runs with it instead of the call's own. */
  input?: JsonObject;
  /** Ask a Person: the draft as a person edited it before approving. */
  text?: string;
  /** Ask a Person: a note the person left with the decision. */
  comment?: string;
}

/** What an Ask a Person node asks (`wait.data.approval.confirm`). */
export interface ConfirmRequest {
  title: string;
  /** The draft the person is asked about. */
  text: string;
  allowEdit: boolean;
  /** Who may answer: emails (signed-in users) or Slack member ids. Empty: anyone who can see the request. */
  approvers?: string[];
  /** What the node does when nobody answers in time. */
  onTimeout?: 'approve' | 'reject' | 'fail';
}

/** The id of the one call an Ask a Person node waits on. */
export const CONFIRM_CALL = 'confirm';

/** What `wait.data.approval` holds. */
export interface PendingApproval {
  nodeName: string;
  nodeId?: string;
  itemIndex?: number;
  channel: 'chat' | 'slack' | 'email';
  calls: ApprovalCall[];
  requestedAt?: string;
  /** What the request says it wants, when not the node's "wants to run a tool" (a team member's: "Developer wants to use …"). */
  title?: string;
  decisions?: Record<string, ApprovalDecision>;
  slack?: { channel: string; messages?: Record<string, string>; approvers?: string[] };
  email?: { to: string[] };
  /** Set by the Ask a Person node. */
  confirm?: ConfirmRequest;
}

export class ApprovalError extends HttpError {
  constructor(
    message: string,
    status: number,
  ) {
    super(message, status, { expose: true });
  }
}

/** The approval an execution waits for, if any. */
export function pendingApproval(record: Pick<ExecutionRecord, 'status' | 'wait'> | undefined): PendingApproval | undefined {
  const approval = record?.status === 'waiting' ? (record.wait?.data?.approval as unknown as PendingApproval | undefined) : undefined;
  return approval && Array.isArray(approval.calls) ? approval : undefined;
}

export type DecisionOutcome = { status: 'waiting'; approval: PendingApproval } | { status: 'resumed'; record: ExecutionRecord };

const isJsonObject = (value: unknown): value is JsonObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Record a decision on one waiting tool call; once all calls have one, resume the execution (streamed into
 * `onEvent`). `slackUser` (a member id) is checked against the node's Approvers.
 */
export async function decideApproval(
  executionId: string,
  callId: string,
  approved: boolean,
  options: { by?: string; slackUser?: string; onEvent?: (event: ExecutionEvent) => void; streaming?: boolean; input?: JsonObject; text?: string; comment?: string } = {},
): Promise<DecisionOutcome> {
  if (options.text !== undefined) {
    if (!approved) throw new ApprovalError('Only an approval can carry edited text', 400);
    if (typeof options.text !== 'string' || !options.text.trim()) throw new ApprovalError('The edited text is empty', 400);
    if (options.text.length > 200_000) throw new ApprovalError('The edited text is too large', 400);
  }
  if (options.comment !== undefined && (typeof options.comment !== 'string' || options.comment.length > 5_000)) throw new ApprovalError('The comment must be text of at most 5,000 characters', 400);
  if (options.input !== undefined) {
    if (!approved) throw new ApprovalError('Only an approval can carry an edited input', 400);
    if (!isJsonObject(options.input)) throw new ApprovalError('The edited input must be a JSON object', 400);
  }
  // A Slack click can come in while the node is still on its way into waiting.
  let stored = liveExecution(executionId) ? undefined : await store.loadExecution(executionId);
  for (let tries = 0; tries < 40 && liveExecution(executionId); tries++) {
    await sleep(150);
    stored = liveExecution(executionId) ? undefined : await store.loadExecution(executionId);
  }
  stored ??= await store.loadExecution(executionId);
  if (!stored) throw new ApprovalError('Execution not found', 404);
  const approval = pendingApproval(stored);
  if (!approval) throw new ApprovalError(stored.status === 'waiting' ? 'This execution is not waiting for a tool approval' : `This execution is ${stored.status}, not waiting for an approval`, 409);
  const call = approval.calls.find((c) => c.id === callId);
  if (!call) throw new ApprovalError('That tool call is not waiting for approval', 404);
  if (options.slackUser && approval.slack?.approvers?.length && !approval.slack.approvers.includes(options.slackUser)) {
    throw new ApprovalError('You are not one of the approvers of this tool call', 403);
  }
  if (approval.confirm) {
    if (options.input !== undefined) throw new ApprovalError('An Ask a Person request takes edited text, not an input', 400);
    if (options.text !== undefined && !approval.confirm.allowEdit) throw new ApprovalError('This request does not allow editing the text', 403);
    const allowed = (approval.confirm.approvers ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean);
    // A signed link in an email was sent to its recipient, so it needs no further check; a Slack click and a signed-in person do.
    const who = options.slackUser ? options.slackUser.toLowerCase() : options.by && !options.by.startsWith('email:') ? options.by.toLowerCase() : undefined;
    if (allowed.length && who && !allowed.includes(who)) throw new ApprovalError('You are not one of the people who may answer this request', 403);
  } else if (options.text !== undefined || options.comment !== undefined) {
    throw new ApprovalError('Only an Ask a Person request takes text or a comment', 400);
  }
  const previous = approval.decisions?.[callId];
  if (previous) throw new ApprovalError(`Already ${previous.approved ? 'approved' : 'rejected'}`, 409);

  // Read, change and save in one synchronous step: two clicks can't overwrite each other.
  const by = options.by ?? (options.slackUser ? `slack:${options.slackUser}` : undefined);
  const decisions = { ...approval.decisions, [callId]: { approved, ...(by && { by }), at: new Date().toISOString(), ...(options.input && { input: options.input }), ...(options.text !== undefined && { text: options.text }), ...(options.comment?.trim() && { comment: options.comment.trim() }) } };
  const next: PendingApproval = { ...approval, decisions };
  store.saveExecution({ ...stored, wait: { ...stored.wait!, data: { ...stored.wait!.data, approval: next as unknown as JsonObject } } });
  // Said in the run's journal, in the wait it answers (before the resume ends that wait): web, Slack and email alike.
  const edited = options.input !== undefined || (options.text !== undefined && options.text !== approval.confirm?.text);
  recordDecision(executionId, stored.workflowId, { id: by ?? 'unknown', name: by }, `${approved ? 'Approved' : 'Rejected'} ${approval.confirm ? `“${approval.confirm.title}”` : call.tool}${edited ? ' with changes' : ''}`, edited ? { editedBy: by ?? 'A person' } : undefined);
  void updateSlackMessage(stored, next, call, decisions[callId]).catch((error: Error) =>
    logger.warn('could not update the Slack approval message', { 'landflow.execution.id': executionId, error: error.message }),
  );

  if (approval.calls.some((c) => !decisions[c.id])) return { status: 'waiting', approval: next };
  const record = await resumeExecution(executionId, {
    kind: 'approval',
    outputs: [[{ json: { decisions: decisions as unknown as JsonObject } }]],
    ...(options.onEvent && { onEvent: options.onEvent }),
    ...(options.streaming && { streaming: true }),
  });
  return { status: 'resumed', record };
}

/** Swap a Slack approval message's buttons for the decision (whoever decided, wherever). */
async function updateSlackMessage(record: ExecutionRecord, approval: PendingApproval, call: ApprovalCall, decision: ApprovalDecision) {
  const ts = approval.slack?.messages?.[call.id];
  if (!approval.slack || !ts) return;
  const node = record.workflow?.nodes.find((n) => n.id === approval.nodeId || n.name === approval.nodeName);
  const held = slackRefOf(node?.credentials);
  if (!held) return;
  const credential = await slackCredentialFor(held.ref);
  const user = decision.by?.startsWith('slack:') ? decision.by.slice(6) : undefined;
  if (approval.confirm) {
    const text = decision.text ?? approval.confirm.text;
    await updateMessage(credential, {
      channel: approval.slack.channel,
      ts,
      text: `${approval.confirm.title}: ${decision.approved ? (text !== approval.confirm.text ? 'approved with changes' : 'approved') : 'rejected'}`,
      blocks: confirmDecidedBlocks({ title: approval.confirm.title, text, approved: decision.approved, edited: text !== approval.confirm.text, ...(user && { user }), ...(!user && decision.by && { note: decision.by }), ...(decision.comment && { comment: decision.comment }) }),
    });
    return;
  }
  await updateMessage(credential, {
    channel: approval.slack.channel,
    ts,
    text: `${call.tool}: ${decision.approved ? 'approved' : 'rejected'}`,
    blocks: decidedBlocks({ title: approval.title ?? `${approval.nodeName} wants to run a tool`, tool: call.tool, input: call.input, approved: decision.approved, user, ...(!user && decision.by && { note: decision.by }) }),
  });
}
