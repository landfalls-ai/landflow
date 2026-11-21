/**
 * The approval inbox: production approvals wait for a person in Needs you (wave ap1; docs/approval-inbox.md).
 *
 * This file is the one copy of the contract (the old `backbone/contracts/ap1` folder is gone): edit it here.
 *
 * The person's decision of 2026-11-18 (accepted from the planner's suggestion, ag5 README option a): when a trigger, webhook
 * or schedule run (nobody watching) reaches an agent tool that asks first, the run pauses instead of refusing; the question
 * goes to Home's Needs you with a mail or Slack nudge; the run resumes on Approve and refuses that call on Deny; a pause
 * expires after a set time (expiry refuses the call, never approves it).
 *
 * One record per waiting tool call (table `approval_inbox`, migration 2907, AP01), or per AI Judge that could not decide (kind
 * `judge`, migration 2920, C13). The record is the truth: whoever moves it
 * from `waiting` first wins (a conditional update), every door (Needs you, the Run Trace card, the execution approvals route,
 * the emailed link, the expiry timer, a cancel) goes through that one claim, and the run reads the record on every resume.
 *
 * Browser-safe: no zod object, no server import.
 */

import type { FallbackReason, JudgeEvidence } from './judge';

/** A request's state. Only `waiting` moves, and only once. */
export type InboxStatus = 'waiting' | 'approved' | 'denied' | 'expired' | 'cancelled';

/**
 * What a request asks about: a tool call of Run an Agent (`tool`, every request before C13) or an AI Judge that could not decide
 * (`judge`, C13: the person decides the request itself). A row with no kind is a tool request.
 */
export type InboxKind = 'tool' | 'judge';

/** Where the settling word came from. */
export type InboxVia = 'inbox' | 'run-trace' | 'email' | 'expiry' | 'cancel';

export const INBOX_STATUSES: readonly InboxStatus[] = ['waiting', 'approved', 'denied', 'expired', 'cancelled'];

/** The host variable that sets how long a request waits (minutes), read when the request opens. */
export const EXPIRY_VARIABLE = 'LANDFLOW_APPROVAL_INBOX_EXPIRY_MINUTES';
/** 24 hours: the same as an approval email link (LANDFLOW_APPROVAL_EMAIL_TTL_HOURS). The person may change it (README decision 1). */
export const DEFAULT_EXPIRY_MINUTES = 1440;
export const MIN_EXPIRY_MINUTES = 1;
/** 30 days. */
export const MAX_EXPIRY_MINUTES = 43_200;

/** The expiry in minutes from the variable's raw value: a whole number clamped to [MIN, MAX], else the default. */
export function expiryMinutes(raw: string | undefined): number {
  const value = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(value)) return DEFAULT_EXPIRY_MINUTES;
  return Math.min(MAX_EXPIRY_MINUTES, Math.max(MIN_EXPIRY_MINUTES, Math.round(value)));
}

/** "10 min", "24 h", "2 days": how a span reads in every line. */
export function expiryText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 2880 || minutes % 1440 !== 0) return minutes % 60 === 0 ? `${minutes / 60} h` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return `${minutes / 1440} days`;
}

/**
 * How a run of this execution mode treats a tool that asks first: `inbox` waits in Needs you (a run nobody watches that can
 * pause: a webhook, a schedule, a poll, an app trigger, a form, an error or called workflow), `editor` is a person's run in the
 * editor (manual, the editor's chat: unchanged, wave ag2 and ag5 rules), `refuse` cannot pause (an MCP call or a workflow an
 * agent calls as a tool answers its caller at once).
 */
export function inboxMode(mode: string | undefined): 'inbox' | 'editor' | 'refuse' {
  if (mode === 'manual' || mode === 'chat') return 'editor';
  if (mode === 'mcp' || mode === 'tool') return 'refuse';
  return 'inbox';
}

/** The plain words for why a run refuses instead of waiting (the publish card's `why`). */
export const REFUSE_WHY = {
  refuseSetting: 'Tool Approvals is set to Refuse on this step',
  wired: 'a model or tools are wired to this step in the flow, so nobody can decide its calls',
  moved: 'tools this flow wired still run here until the agent is published',
  mcp: 'an MCP call answers its caller at once',
  tool: 'a workflow an agent calls as a tool answers it at once',
  hostedChat: 'the hosted chat page cannot show an approval',
  unknownOrigin: "this run's start could not be shown to come from a trigger that may wait",
  noInbox: 'this host has no approval inbox',
} as const;
export type RefuseWhy = keyof typeof REFUSE_WHY;

/** One line of the publish card, the Publish menu and the session's last line (GET /api/workflows/:id/unattended-approvals). */
export interface PublishLine {
  tool: string;
  agent: string;
  node: string;
  /** The trigger's plain word ("webhook", "schedule", …). */
  trigger: string;
  /** `waitLine` or `refusesLine`. */
  line: string;
  outcome: 'waits' | 'refuses';
  why?: RefuseWhy;
  /** With `waits`: the expiry a request opened now would get. */
  expiresAfterMinutes?: number;
}

/** The person's words of 2026-11-18, as the publish card says them before publishing. */
export function waitLine(tool: string, trigger: string, minutes: number): string {
  return `In production “${tool}” will wait for your approval in Needs you: a ${trigger} run pauses until someone approves or denies it, and the request expires after ${expiryText(minutes)}.`;
}

/** A tool that asks first which this run still refuses, with the reason. */
export function refusesLine(tool: string, trigger: string, why: RefuseWhy): string {
  return `In production “${tool}” is refused: a ${trigger} run cannot wait for an approval here (${REFUSE_WHY[why]}).`;
}

/** What AP02 hands the inbox when a run pauses: one per undecided call. No secret is ever in it (params are masked first). */
export interface InboxOpen {
  executionId: string;
  callId: string;
  workflowId: string;
  workflowName: string;
  /** The published version's number the run uses (`executions.version_id` → its number); absent for an unversioned run. */
  workflowVersion?: number;
  nodeId: string;
  nodeName: string;
  agentId: string;
  agentName: string;
  /** The agent version the run uses (its pin), or 'draft'. */
  agentVersion?: number | 'draft';
  sessionId: string;
  /** The tool's label as the agent's card names it ("Send Email"). */
  tool: string;
  /** The parameters the call would run with (fixed ∪ the model's), after `maskParams` and the host's secret redaction. */
  params: Record<string, unknown>;
  /** Where it goes, in plain words: recipients, URLs, and the target line (host and port), never a secret. */
  destination?: string;
  trigger: string;
  projectId?: string;
  /** C13: `judge` for an AI Judge's request; absent for a tool call (a row with no kind reads `tool`). */
  kind?: InboxKind;
  /** C13: with `judge`, what the judge saw and did (masked and capped again when the row is written). */
  evidence?: JudgeEvidence;
}

/** A request as the inbox routes, Needs you and the Run Trace show it. */
export interface InboxRequestView extends Omit<InboxOpen, 'sessionId' | 'projectId'> {
  id: string;
  status: InboxStatus;
  requestedAt: string;
  expiresAt: string;
  decidedBy?: string;
  decidedByName?: string;
  decidedVia?: InboxVia;
  decidedAt?: string;
  /** How many nudges went out (counts only: never the addresses or channel settings). */
  nudged?: { email: number; channels: number };
  /** Whether the caller may Approve or Deny (run access on the workflow, a signed-in person). */
  canDecide: boolean;
}

/** The fields a Needs you `approval` item carries when its wait is an inbox request (AP01 adds them, AP03 reads them). */
export interface InboxItemFields {
  requestId?: string;
  inboxStatus?: InboxStatus;
  tool?: string;
  agentName?: string;
  agentVersion?: number | 'draft';
  workflowVersion?: number;
  destination?: string;
  expiresAt?: string;
  canDecide?: boolean;
  /** C13: `judge` when the request is an AI Judge's; `judgeWhy` is the fixed fallback reason. */
  inboxKind?: InboxKind;
  judgeWhy?: FallbackReason;
}

/** What a waiting execution's `wait.data.inbox` holds (AP02 writes it, AP01 reads it in decideApproval and Needs you). */
export interface InboxWait {
  /** callId → request id. */
  ids: Record<string, string>;
  expiresAt: string;
}
export const INBOX_WAIT_KEY = 'inbox';

/** The mask that replaces a secret-looking value. */
export const MASK = '••••••';
/** Keys whose values are never shown, at any depth ("smtpPassword", "accessToken", "x-api-key"; not "maxTokens" or "compass"). */
export const SECRET_KEY = /pass(word|phrase|wd)|^pass$|secret|token$|api[-_ ]?key|authori[sz]ation|cookie|private[-_ ]?key|credential|bearer|session[-_ ]?id|signature/i;
/** A whole value shaped like an auth header ("Bearer eyJ…"), never a sentence that starts with the word. */
const BEARER = /^(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}$/i;
const MAX_SHOWN_CHARS = 4_000;

/** A copy of `value` with secret-looking keys and auth-header-looking strings masked and long strings cut. */
export function maskParams<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return (BEARER.test(value) ? MASK : value.length > MAX_SHOWN_CHARS ? `${value.slice(0, MAX_SHOWN_CHARS)}…` : value) as T;
  if (!value || typeof value !== 'object' || depth > 32) return value;
  if (Array.isArray(value)) return value.map((entry) => maskParams(entry, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = SECRET_KEY.test(key) && entry !== '' && entry != null ? MASK : maskParams(entry, depth + 1);
  return out as T;
}

/** The Run Trace's and Needs you's line while a request waits. `clock` formats an ISO time in the viewer's zone. */
export function waitingLine(requestedAt: string, expiresAt: string, clock: (iso: string) => string): string {
  return `Waiting for your approval since ${clock(requestedAt)} · expires ${clock(expiresAt)}`;
}

const VIA_WORDS: Record<InboxVia, string> = { inbox: 'in Needs you', 'run-trace': 'in the Run Trace', email: 'by email', expiry: '', cancel: '' };

/** The settled line (Run Trace, the tool call's `decidedLine`, the journal's decision row, Needs you's last word). */
export function settledLine(view: Pick<InboxRequestView, 'status' | 'tool' | 'decidedByName' | 'decidedBy' | 'decidedVia' | 'decidedAt' | 'kind'>, clock: (iso: string) => string): string {
  const who = view.decidedByName || view.decidedBy || 'someone';
  const at = view.decidedAt ? ` · ${clock(view.decidedAt)}` : '';
  const via = view.decidedVia ? VIA_WORDS[view.decidedVia] : '';
  switch (view.status) {
    case 'approved':
      return `Approved by ${who}${via ? ` ${via}` : ''}${at}`;
    case 'denied':
      return `Denied by ${who}${via ? ` ${via}` : ''}${at}`;
    case 'expired':
      if (view.kind === 'judge') return `Expired${view.decidedAt ? ` at ${clock(view.decidedAt)}` : ''}: nobody decided “${view.tool}” in time, so it was denied`;
      return `Expired${view.decidedAt ? ` at ${clock(view.decidedAt)}` : ''}: nobody approved “${view.tool}” in time, so it did not run`;
    case 'cancelled':
      if (view.kind === 'judge') return `Cancelled with the run: “${view.tool}” was not decided`;
      return `Cancelled with the run: “${view.tool}” did not run`;
    default:
      return view.kind === 'judge' ? `Waiting for a decision on “${view.tool}”` : `Waiting for approval of “${view.tool}”`;
  }
}

/** What the agent hears for a call the inbox did not let run (the tool result; the run goes on and the agent says so). */
export function refusedResult(status: 'denied' | 'expired' | 'cancelled', tool: string, who: string | undefined, minutes: number): string {
  if (status === 'denied') return `${who ?? 'A person'} denied “${tool}” in the approval inbox, so it did not run. Don't retry it; say what you would have done.`;
  if (status === 'expired') return `Nobody approved “${tool}” within ${expiryText(minutes)}, so it did not run. Don't retry it; say what you would have done.`;
  return `The run was cancelled while “${tool}” waited for approval, so it did not run.`;
}

/** The answer to a decision on a request that is no longer waiting: who won, and the HTTP status the routes answer. */
export function closedAnswer(view: Pick<InboxRequestView, 'status' | 'tool' | 'decidedByName' | 'decidedBy' | 'decidedAt' | 'expiresAt' | 'kind'>, clock: (iso: string) => string): { status: 409 | 410; message: string } {
  const who = view.decidedByName || view.decidedBy || 'someone';
  const at = view.decidedAt ? ` at ${clock(view.decidedAt)}` : '';
  const ended = view.kind === 'judge' ? 'was denied' : 'did not run';
  if (view.status === 'expired') return { status: 410, message: `This approval expired${view.decidedAt ? ` at ${clock(view.decidedAt)}` : ` at ${clock(view.expiresAt)}`}: “${view.tool}” ${ended}.` };
  if (view.status === 'cancelled') return { status: 409, message: `The run was cancelled: “${view.tool}” ${view.kind === 'judge' ? 'was not decided' : 'did not run'}.` };
  return { status: 409, message: `Already ${view.status === 'approved' ? 'approved' : 'denied'} by ${who}${at}.` };
}

/** The nudge's subject (mail, alert channel). */
export function nudgeSubject(tool: string, workflowName: string): string {
  return `Approval needed: “${tool}” in “${workflowName}”`;
}
