/**
 * Access requests (docs/access-requests.md#asking): a person asks for an entry for a duration with a reason; the installed
 * flow (templates/builtin-access.ts) asks the entry's approvers in Ask a Person; Apply Access Decision (grants.ts) grants only after
 * the server's own record of that run shows an approver other than the requester approved. The requester is always the session's
 * user (or, for a person without a Landflow account, their verified outside requester), never anything in a body.
 */
import { nanoid } from 'nanoid';
import { ACCESS_LIMITS, durationText, forDuration, shorterDurations, type AccessRequestView, type OutsideRequestView, type RequestStatus } from '../../shared/access';
import { recordAudit } from '../audit';
import { getUser } from '../auth/users';
import { database } from '../db';
import { decodeCursor, encodeCursor } from '../pagination';
import type { Actor } from '../projects/access';
import { cancelWaitingExecution, newExecutionId } from '../runner';
import { logger } from '../telemetry/logger';
import { entryData } from './catalog';
import { AccessError } from './errors';
import { mailRequester } from './notify';
import { outsideRequestView } from './outside/views';
import { auditActorOfRequester, displayName, outsideStanding, requesterOf, requesterOfActor, whoLine, type Requester } from './principal';
import { approversFor, auditActorOf, canAskFor, canCancelRequest, canOutsiderAsk, canSeeEntry, canSeeRequest, isRequesterUser, type EntryData } from './rules';
import { accessSettings, accountOf, claimRequest, insertRequest, parseJson, patchRequest, requestRow, saveAccount, type RequestRow } from './store';
import { targetKeyOf, validateGithubLogin } from './systems';
import { accessFlow, fireAccessRequest, stepNodesOf, type AccessRequestItem } from './trigger';
import { requestView } from './views';

export const LIVE_GRANT = ['pending', 'active', 'removing', 'revoke_failed', 'drift', 'failed'] as const;

export interface RequestInput {
  entryId: string;
  durationMinutes: number | null;
  reason: string;
  /** GitHub entries: the login to grant to (kept for next time). */
  account?: string;
  channel?: 'form' | 'chat';
}

const lengthOf = (minutes: number | null) => (minutes === null ? Infinity : minutes);

/**
 * The account a request is for: Google the person's own email (a Landflow user's, or an outside requester's verified one), GitHub their
 * login (given, or kept; unique across users and outside requesters), manual none.
 */
function accountFor(requester: Requester, entry: EntryData, given: string | undefined): string | undefined {
  if (entry.system === 'google-group') {
    if (!requester.email) throw new AccessError('Your account has no email address, so Google access cannot be granted to it', 400);
    return requester.email;
  }
  if (entry.system === 'manual') return undefined;
  const kept = accountOf(requester.id, 'github');
  const login = given?.trim() ? validateGithubLogin(given) : kept;
  if (!login) throw new AccessError('Give your GitHub username', 400, { field: 'account' });
  if (login !== kept) {
    saveGithubAs(requester, kept, login);
  }
  return login;
}

/** Save a GitHub username and audit it; when a Landflow user takes one an outside requester had typed, that requester's copy is cleared and the audit row says so. */
function saveGithubAs(requester: Requester, kept: string | undefined, login: string): void {
  const { displaced } = saveAccount(requester.id, 'github', login);
  recordAudit({ action: 'access.account.set', actor: auditActorOfRequester(requester), target: { type: 'user', id: requester.id }, project: null, summary: 'Saved a GitHub username for access requests', details: { from: kept ?? null, to: login, requesterKind: requester.kind, ...(displaced && { displacedOutsideRequester: displaced }) } });
}

/** The live grant (any entry) on this target for this account, if one exists. */
export function liveGrantOnTarget(system: EntryData['system'], config: Record<string, string>, account: string): string | undefined {
  return database().get<{ id: string }>(`SELECT id FROM access_grants WHERE target_key = ? AND lower(account) = lower(?) AND status IN (${LIVE_GRANT.map(() => '?').join(', ')})`, targetKeyOf(system, config), account, ...LIVE_GRANT)?.id;
}

/** What a person typed, on one line: control characters and line breaks become a space, so it can't add a line (or a heading) to a question. */
export const plain = (text: string): string => String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

/**
 * What the approver reads. `who` is the "Who:" line an outside requester's question adds (outside requester, the verified address and how it
 * was proven), so an approver can't mistake a person without an account for a colleague of the same name; a Landflow user has none.
 */
export function summaryText(entry: EntryData, requesterName: string, minutes: number | null, reason: string, account: string | undefined, who?: string): string {
  // A GitHub username is typed by the requester; Google access always goes to their own verified email.
  const accountLine = account ? [`Account: ${plain(account)}${entry.system === 'google-group' ? '' : ' (unverified: typed by the requester)'}`] : [];
  // The requester's own words come last, quoted, behind a separator: nothing they type can look like one of the lines above.
  return [`${plain(requesterName)} asks for ${plain(entry.name)}`, `What: ${plain(entry.target.label)}`, `For: ${durationText(minutes)}`, ...(who ? [`Who: ${plain(who)}`] : []), ...accountLine, '--- the requester wrote:', `“${plain(reason)}”`].join('\n');
}

/** The question Ask a Person puts to the approvers, built here and nowhere else: Apply Access Decision compares the recorded one with it. */
export const questionFor = (entry: EntryData, requesterName: string, minutes: number | null, reason: string, account: string | undefined, who?: string) => ({
  title: `Give ${plain(requesterName)} ${plain(entry.name)} ${forDuration(minutes)}?`.trim(),
  text: summaryText(entry, requesterName, minutes, reason, account, who),
});

/** The name and the "Who:" line of a requester's question: an outside requester is their verified address, marked, with how it was proven. */
export const questionWho = (requester: Requester): { name: string; who?: string } => (requester.kind === 'outside' ? { name: displayName(requester), who: whoLine(requester) } : { name: requester.name });

/** A signed-in Landflow user files a request (the Access page, its chat). */
export const createRequest = (actor: Actor, input: RequestInput): Promise<AccessRequestView> => fileRequest(requesterOfActor(actor), input, actor) as Promise<AccessRequestView>;

/**
 * File a request for `requester`: a Landflow user (`actor` given: what they may see and ask for follows the C35 rules) or an outside
 * requester (an entry an admin opened to them, and only while they still stand: the feature on, domain allowed, not blocked, no Landflow
 * account on their address). Answers the full view for a user; use `fileOutsideRequest` for an outsider's own view.
 */
export async function fileRequest(requester: Requester, input: RequestInput, actor?: Actor): Promise<AccessRequestView | OutsideRequestView> {
  const settings = accessSettings();
  const flow = accessFlow(settings.workflowId);
  if (!flow) throw new AccessError('An admin must set up access requests first', 409);
  const outside = requester.kind === 'outside';
  if (outside && !outsideStanding(requester)) throw new AccessError('Sign in again to ask for access', 401);
  const entry = entryData(input.entryId);
  if (!entry || (outside ? !canOutsiderAsk(entry) : !canSeeEntry(actor!, entry))) throw new AccessError('Access entry not found', 404);
  if (!outside && !canAskFor(actor!, entry)) throw new AccessError('This entry is switched off', 400);
  const minutes = input.durationMinutes === undefined ? undefined : input.durationMinutes;
  if (minutes === undefined || !entry.durations.includes(minutes)) throw new AccessError('Pick one of the durations this entry offers', 400, { field: 'durationMinutes' });
  const reason = String(input.reason ?? '').trim();
  const [min, max] = ACCESS_LIMITS.reasonChars;
  if (reason.length < min || reason.length > max) throw new AccessError(`Say why, in ${min} to ${max} characters`, 400, { field: 'reason' });

  const open = database().get<{ id: string }>(`SELECT id FROM access_requests WHERE entry_id = ? AND requester_id = ? AND status = 'pending'`, entry.id, requester.id);
  if (open) throw new AccessError('You already asked for this; wait for the answer or cancel it', 409, { existingId: open.id });
  const live = database().get<{ id: string }>(`SELECT id FROM access_grants WHERE entry_id = ? AND holder_id = ? AND status IN (${LIVE_GRANT.map(() => '?').join(', ')})`, entry.id, requester.id, ...LIVE_GRANT);
  if (live) throw new AccessError('You already have this access', 409, { existingId: live.id });

  // Nobody whose id or email is the requester's decides it (an outside requester's address may be an approver's).
  const approverIds = approversFor(entry, requester.id);
  if (!approverIds.length) throw new AccessError('Nobody but you can approve this. Ask an admin to add an approver.', 409);
  const stepNodes = stepNodesOf(flow.workflow);
  if (!stepNodes || stepNodes.length !== entry.steps.length) throw new AccessError('The installed access flow is not the one set-up made: an admin must set access requests up again', 409);
  const account = accountFor(requester, entry, input.account);
  if (account && entry.system !== 'manual') {
    const taken = liveGrantOnTarget(entry.system, entry.target.config, account);
    if (taken) throw new AccessError('That account already has this access, through another entry', 409, { existingId: taken });
  }
  const { name: requesterName, who } = questionWho(requester);
  const now = new Date().toISOString();
  const id = `areq_${nanoid(10)}`;
  const executionId = newExecutionId();
  const { credentialId: _credential, ...snapshot } = entry;
  const row: RequestRow = {
    id,
    entry_id: entry.id,
    entry_version: entry.version,
    entry_snapshot: JSON.stringify(snapshot),
    requester_id: requester.id,
    requester_kind: requester.kind,
    account: account ?? null,
    duration_minutes: minutes,
    reason,
    channel: input.channel === 'chat' ? 'chat' : 'form',
    status: 'pending',
    approvers: JSON.stringify(approverIds),
    workflow_id: flow.workflow.id,
    execution_id: executionId,
    decisions: null,
    approved_minutes: null,
    note: null,
    question: JSON.stringify({ ...questionFor(entry, requesterName, minutes, reason, account, who), nodes: stepNodes }),
    created_at: now,
    updated_at: now,
  };
  try {
    insertRequest(row);
  } catch (error) {
    // Two asks at once: the table lets one pending request through (`access_requests_open`).
    const existing = database().get<{ id: string }>(`SELECT id FROM access_requests WHERE entry_id = ? AND requester_id = ? AND status = 'pending'`, entry.id, requester.id);
    if (existing) throw new AccessError('You already asked for this; wait for the answer or cancel it', 409, { existingId: existing.id });
    throw error;
  }
  recordAudit({ action: 'access.request.create', actor: auditActorOfRequester(requester), target: { type: 'access_request', id, name: entry.name }, project: null, summary: `Asked for ${entry.name} ${forDuration(minutes)}`, details: { from: null, to: JSON.stringify({ entry: entry.name, duration: durationText(minutes), channel: row.channel }), requesterKind: requester.kind, ...(outside && { verifiedBy: requester.verifiedBy ?? null }) } });

  const item: AccessRequestItem = {
    requestId: id,
    entry: { id: entry.id, name: entry.name, system: entry.system, targetLabel: entry.target.label },
    requester: { id: requester.id, name: requesterName, email: requester.email ?? '' },
    ...(account && { account }),
    durationMinutes: minutes,
    durationText: durationText(minutes),
    reason,
    channel: row.channel as 'form' | 'chat',
    approvers: approverIds.map((approver) => getUser(approver)?.email).filter(Boolean).join(','),
    durationChoices: shorterDurations(entry.durations, minutes).map((m) => `${m === null ? 'unlimited' : m}: ${durationText(m)}`).join('\n'),
    summary: summaryText(entry, requesterName, minutes, reason, account, who),
    ...(() => {
      const question = questionFor(entry, requesterName, minutes, reason, account, who);
      return { askTitle: question.title, askText: question.text };
    })(),
  };
  try {
    const run = await fireAccessRequest(flow, item, executionId);
    if (run.executionId !== executionId) patchRequest(id, { execution_id: run.executionId });
    if (run.error) await failRequest(id, run.error);
  } catch (error) {
    logger.warn('the access flow could not start', { error: (error as Error).message });
    await failRequest(id, 'The access flow could not start');
  }
  return outside ? outsideRequestView(requestRow(id)!) : requestView(actor!, requestRow(id)!);
}

/** An outside requester files a request (the public page, its chat): their own view of it. */
export const fileOutsideRequest = (requester: Requester, input: RequestInput): Promise<OutsideRequestView> => fileRequest(requester, input) as Promise<OutsideRequestView>;

/** Settle a pending request as failed, with the reason; audited, and the person told. */
export async function failRequest(id: string, note: string): Promise<void> {
  const { won, row } = await claimRequest(id, 'pending', { status: 'failed', note });
  if (!won || !row) return;
  recordAudit({ action: 'access.request.fail', target: { type: 'access_request', id }, project: null, summary: `An access request failed: ${note}`, details: { from: 'pending', to: 'failed' } });
  const entry = parseJson<EntryData>(row.entry_snapshot, undefined as never);
  if (entry) void mailRequester.failed({ requesterId: row.requester_id, requesterName: '', entryName: entry.name, targetLabel: entry.target.label, duration: durationText(row.duration_minutes === null ? null : Number(row.duration_minutes)) }, note);
}

export function getRequest(actor: Actor, id: string): AccessRequestView {
  const row = requestRow(id);
  if (!row || !canSeeRequest(actor, { requesterId: row.requester_id, approvers: parseJson<string[]>(row.approvers, []) }, entryData(row.entry_id))) throw new AccessError('Access request not found', 404);
  return requestView(actor, row);
}

export type RequestScope = 'mine' | 'decide' | 'all';

export interface RequestPage {
  items: AccessRequestView[];
  nextCursor?: string;
}

/** `mine`: the caller's; `decide`: the pending ones they decide now; `all`: everything they may see (admins: every request). */
export function listRequests(actor: Actor, options: { scope: RequestScope; status?: RequestStatus; limit: number; cursor?: string }): RequestPage {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.status) {
    where.push('status = ?');
    params.push(options.status);
  }
  if (options.scope === 'mine') {
    where.push('requester_id = ?');
    params.push(actor.id);
  }
  if (options.scope === 'decide') where.push(`status = 'pending'`);
  const at = options.cursor ? decodeCursor(options.cursor) : undefined;
  if (at) {
    where.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(at.s, at.s, at.i);
  }
  const items: AccessRequestView[] = [];
  let last: RequestRow | undefined;
  let more = false;
  const batch = 200;
  let offset = 0;
  // Visibility is per entry (owners, approvers), so filter rows after reading: page through until the limit is full.
  for (;;) {
    const rows = database().all<RequestRow>(`SELECT * FROM access_requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, ...params, batch, offset);
    for (const row of rows) {
      const facts = { requesterId: row.requester_id, approvers: parseJson<string[]>(row.approvers, []) };
      const visible = options.scope === 'mine' || canSeeRequest(actor, facts, entryData(row.entry_id));
      const wanted = options.scope === 'decide' ? facts.approvers.includes(actor.id) && row.requester_id !== actor.id : visible;
      if (!wanted) continue;
      if (items.length === options.limit) {
        more = true;
        break;
      }
      items.push(requestView(actor, row));
      last = row;
    }
    if (more || rows.length < batch) break;
    offset += batch;
  }
  return { items, ...(more && last && { nextCursor: encodeCursor({ s: last.created_at, i: last.id }) }) };
}

/** The requester (or an admin) withdraws a request while it waits; the waiting run stops so the question leaves Needs you. */
export async function cancelRequest(actor: Actor, id: string): Promise<AccessRequestView> {
  const row = requestRow(id);
  if (!row || !canCancelRequest(actor, { requesterId: row.requester_id })) throw new AccessError('Access request not found', 404);
  await cancelPending(row, auditActorOf(actor));
  return requestView(actor, requestRow(id)!);
}

/** Move a pending request to cancelled once, audited as `by`, and stop its waiting run. */
async function cancelPending(row: RequestRow, by: ReturnType<typeof auditActorOf>, extra: Record<string, unknown> = {}): Promise<void> {
  const { won, row: now } = await claimRequest(row.id, 'pending', { status: 'cancelled' });
  if (!won) throw new AccessError(`This request is already ${now?.status ?? 'settled'}`, 409);
  recordAudit({ action: 'access.request.cancel', actor: by, target: { type: 'access_request', id: row.id }, project: null, summary: 'Cancelled an access request', details: { from: 'pending', to: 'cancelled', requesterKind: row.requester_kind ?? 'user', ...extra } });
  if (row.execution_id) cancelWaitingExecution(row.execution_id);
}

/** An outside requester withdraws their own waiting request; anyone else's is a 404. */
export async function cancelOwnRequest(requester: Requester, id: string): Promise<OutsideRequestView> {
  const row = requestRow(id);
  if (!row || row.requester_id !== requester.id) throw new AccessError('Access request not found', 404);
  await cancelPending(row, auditActorOfRequester(requester));
  return outsideRequestView(requestRow(id)!, entryData(row.entry_id)?.name);
}

/** The requester's own requests, newest first (an outside requester's view: no approvers, ids of runs or decisions). */
export function listOwnRequests(requester: Requester, limit = 100): OutsideRequestView[] {
  const rows = database().all<RequestRow>('SELECT * FROM access_requests WHERE requester_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', requester.id, limit);
  return rows.map((row) => outsideRequestView(row, entryData(row.entry_id)?.name));
}

/**
 * Blocking an outside requester cancels what they are waiting on (C36 D-15: their grants stay until they end or are revoked on the Grants
 * tab). Returns how many were cancelled; each is audited as `by`.
 */
export async function cancelOpenRequestsOf(requesterId: string, by: ReturnType<typeof auditActorOf>): Promise<number> {
  const rows = database().all<RequestRow>(`SELECT * FROM access_requests WHERE requester_id = ? AND status = 'pending'`, requesterId);
  let cancelled = 0;
  for (const row of rows) {
    try {
      await cancelPending(row, by, { reason: 'blocked' });
      cancelled++;
    } catch (error) {
      if (!(error instanceof AccessError)) throw error; // settled by someone else meanwhile: nothing left to cancel
    }
  }
  return cancelled;
}

/**
 * An approver of the entry decides a waiting request from the Access page (POST /api/access/requests/:id/decision). The person is checked
 * here (one of the request's approvers, never the requester); the decision is then recorded exactly as Ask a Person's own answer, so the run's
 * record is what Apply Access Decision reads. A session user only: the route is session-only, and People Only refuses an API key and MCP again.
 */
export async function decideAccessRequest(actor: Actor, id: string, input: { approved: boolean; choice?: string; comment?: string }): Promise<AccessRequestView> {
  const row = requestRow(id);
  const approvers = row ? parseJson<string[]>(row.approvers, []) : [];
  if (!row || !canSeeRequest(actor, { requesterId: row.requester_id, approvers }, entryData(row.entry_id))) throw new AccessError('Access request not found', 404);
  const user = getUser(actor.id);
  // Not the requester: not by id, and not by email either (an outside requester's address may be an approver's).
  if (row.requester_id === actor.id || (user && isRequesterUser(user, row.requester_id))) throw new AccessError('You can’t decide your own request', 403);
  if (!approvers.includes(actor.id)) throw new AccessError('Only the approvers of this request decide it', 403);
  if (row.status !== 'pending') throw new AccessError(`This request is already ${row.status}`, 409);
  if (!row.execution_id) throw new AccessError('This request has no waiting question', 409);
  const by = user?.email || user?.name;
  if (!by) throw new AccessError('Your account has no email address to decide with', 400);
  const { decideApproval, ApprovalError } = await import('../approvals');
  try {
    await decideApproval(row.execution_id, 'confirm', input.approved, { by, byName: user?.name || by, principal: 'session', ...(input.choice !== undefined && { choice: input.choice }), ...(input.comment?.trim() && { comment: input.comment.trim() }) });
  } catch (error) {
    if (error instanceof ApprovalError) throw new AccessError(error.message, error.status);
    throw error;
  }
  return requestView(actor, requestRow(id)!);
}

/** The accounts access goes to: the kept GitHub username, and the Google account (a user's Landflow email, an outside requester's verified one). */
export function accountsOf(who: { id: string }): { github?: string; google?: string } {
  const github = accountOf(who.id, 'github');
  const google = requesterOf(who.id)?.email;
  return { ...(github && { github }), ...(google && { google }) };
}

/** The caller's own GitHub username for access requests (unique across users and outside requesters); a change is audited. */
export function setGithubAccount(who: { id: string }, login: string): { github?: string; google?: string } {
  const next = validateGithubLogin(login);
  const kept = accountOf(who.id, 'github');
  if (next !== kept) {
    saveGithubAs(requesterOfActor(who), kept, next);
  }
  return accountsOf(who);
}
