/**
 * Tool approvals of AI Agent nodes in workflows (docs/agents.md → Tool approvals). An AI Agent whose
 * tool call needs a person puts the execution to wait (`resume: 'webhook'`, `rerun: true`) with
 * `wait.data.approval` = { nodeName, calls, channel, slack? }. A decision arrives from the editor's chat
 * panel or the execution view (POST /api/executions/:id/approvals, signed in) or from a Slack button
 * (/api/slack/interactions); it is stored on the waiting record, and once every call has one the
 * execution resumes with `{ decisions }` and the agent node continues its loop.
 */
import type { JsonObject } from '@landflow/protocol';
import type { ExecutionEvent } from '@landflow/engine';
import type { ExecutionRecord } from '../shared/types';
import { recordDecision } from './journal/decisions';
import { liveExecution, resumeExecution } from './runner';
import { decidedBlocks, slackCredentialFor, slackRefOf, updateMessage } from './slack';
import { store } from './store';
import { logger } from './telemetry';

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
}

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
}

export class ApprovalError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The approval an execution waits for, if any. */
export function pendingApproval(record: Pick<ExecutionRecord, 'status' | 'wait'> | undefined): PendingApproval | undefined {
  const approval = record?.status === 'waiting' ? (record.wait?.data?.approval as unknown as PendingApproval | undefined) : undefined;
  return approval && Array.isArray(approval.calls) ? approval : undefined;
}

export type DecisionOutcome = { status: 'waiting'; approval: PendingApproval } | { status: 'resumed'; record: ExecutionRecord };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Record a decision on one waiting tool call; once all calls have one, resume the execution (streamed into
 * `onEvent`). `slackUser` (a member id) is checked against the node's Approvers.
 */
export async function decideApproval(
  executionId: string,
  callId: string,
  approved: boolean,
  options: { by?: string; slackUser?: string; onEvent?: (event: ExecutionEvent) => void; streaming?: boolean } = {},
): Promise<DecisionOutcome> {
  // A Slack click can come in while the node is still on its way into waiting.
  let stored = liveExecution(executionId) ? undefined : store.getExecution(executionId);
  for (let tries = 0; tries < 40 && liveExecution(executionId); tries++) {
    await sleep(150);
    stored = liveExecution(executionId) ? undefined : store.getExecution(executionId);
  }
  stored ??= store.getExecution(executionId);
  if (!stored) throw new ApprovalError('Execution not found', 404);
  const approval = pendingApproval(stored);
  if (!approval) throw new ApprovalError(stored.status === 'waiting' ? 'This execution is not waiting for a tool approval' : `This execution is ${stored.status}, not waiting for an approval`, 409);
  const call = approval.calls.find((c) => c.id === callId);
  if (!call) throw new ApprovalError('That tool call is not waiting for approval', 404);
  if (options.slackUser && approval.slack?.approvers?.length && !approval.slack.approvers.includes(options.slackUser)) {
    throw new ApprovalError('You are not one of the approvers of this tool call', 403);
  }
  const previous = approval.decisions?.[callId];
  if (previous) throw new ApprovalError(`Already ${previous.approved ? 'approved' : 'rejected'}`, 409);

  // Read, change and save in one synchronous step: two clicks can't overwrite each other.
  const by = options.by ?? (options.slackUser ? `slack:${options.slackUser}` : undefined);
  const decisions = { ...approval.decisions, [callId]: { approved, ...(by && { by }), at: new Date().toISOString() } };
  const next: PendingApproval = { ...approval, decisions };
  store.saveExecution({ ...stored, wait: { ...stored.wait!, data: { ...stored.wait!.data, approval: next as unknown as JsonObject } } });
  // Said in the run's journal, in the wait it answers (before the resume ends that wait): web, Slack and email alike.
  recordDecision(executionId, stored.workflowId, { id: by ?? 'unknown', name: by }, `${approved ? 'Approved' : 'Rejected'} ${call.tool}`);
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
  await updateMessage(credential, {
    channel: approval.slack.channel,
    ts,
    text: `${call.tool}: ${decision.approved ? 'approved' : 'rejected'}`,
    blocks: decidedBlocks({ title: approval.title ?? `${approval.nodeName} wants to run a tool`, tool: call.tool, input: call.input, approved: decision.approved, user, ...(!user && decision.by && { note: decision.by }) }),
  });
}
