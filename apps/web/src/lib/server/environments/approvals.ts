/**
 * Four-eyes on promotion (Settings → Governance, "Four-eyes publishing"): with it on, promoting to another environment
 * is a request someone else approves, like a publish request, with the rules of ../governance/approvals.ts: nobody
 * approves their own request, and the approver must pass `mayApprove` for every workflow the promotion changes (so
 * the instance approver role and the projects' approver checks apply). Promotion is an owner or admin action, so its
 * approvers are other owners and admins.
 *
 * The request (`promotion_requests`, migration 1650) keeps what was asked for, the preview and the digest of what the
 * promotion would write (./promote.ts). Approving promotes with `expectDigest`: if the branches moved, a promoted
 * credential or table rows changed, or a setting did, it goes stale and has to be asked again. A newer request for
 * the same source and target replaces a pending one. Approvers are emailed (Settings → Governance "Email approvers",
 * with SMTP) and the governance alert channels hear about new requests; the requester hears the decision. Every step
 * is audited.
 */
import { nanoid } from 'nanoid';
import type { PromotionRequestStatus, PromotionRequestView, PromotionResult } from '../../shared/secrets';
import { can } from '../../shared/auth';
import { publicUrl } from '../alerts/message';
import { recordAudit } from '../audit';
import { mailConfigured, sendMail } from '../auth/mail';
import { getUser, listUsers, userNames, type UserRecord } from '../auth/users';
import { database } from '../db';
import { parse } from '../db/rows';
import { ApprovalError, fourEyesApplies, mayApprove } from '../governance/approvals';
import { sendNotice } from '../governance/notify';
import { getGovernancePolicy } from '../governance/policy';
import { store } from '../store';
import { logger } from '../telemetry/logger';
import { promoteEnvironment, StalePromotionError, type PromoteInput } from './promote';
import { currentEnvironment } from './settings';

interface Row {
  id: string;
  status: PromotionRequestStatus;
  source: string;
  target: string;
  digest: string;
  input: string;
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  comment: string | null;
  data: string;
}

/** What the request promotes (PromoteInput without the run-time fields). */
type Asked = Pick<PromoteInput, 'workflows' | 'prune' | 'force' | 'message' | 'rowTables' | 'credentials'>;

interface Data {
  preview: PromotionResult;
  reason?: string;
  commit?: string;
}

/** A stored preview stays under this size: past it, diffs are left out. */
const MAX_PREVIEW = 1_000_000;

/** Whether the instance asks every promotion for a second person (Settings → Governance). */
export const promotionApprovalRequired = () => fourEyesApplies('publish');

/**
 * Whether a previewed promotion needs a second person: the instance asks for four-eyes, or it changes a workflow whose
 * own policy or project asks for it (project settings `fourEyes`, the workflow's policy).
 */
export const promotionNeedsApproval = (preview: Pick<PromotionResult, 'entries'>): boolean =>
  promotionApprovalRequired() || preview.entries.some((e) => e.status !== 'unchanged' && store.getWorkflow(e.id) && fourEyesApplies('publish', e.id));

const rowOf = (id: string) => database().get<Row>('SELECT * FROM promotion_requests WHERE id = ?', id);
const save = (row: Row) => database().upsert('promotion_requests', { ...row });
const askedOf = (row: Row) => parse<Asked>(row.input) ?? {};
const dataOf = (row: Row): Data => parse<Data>(row.data) ?? ({ preview: { entries: [], files: [] } } as unknown as Data);

/** The workflows a request changes that exist here (their approver checks apply). */
const changedWorkflows = (row: Row) =>
  dataOf(row)
    .preview.entries.filter((e) => e.status !== 'unchanged' && store.getWorkflow(e.id))
    .map((e) => e.id);

/** Whether `user` may approve or reject `row`: someone else who manages settings and may approve each changed workflow. */
export function mayApprovePromotion(user: Pick<UserRecord, 'id' | 'role'> & { disabledAt?: string }, row: Pick<Row, 'requested_by'> & Partial<Row>): boolean {
  if (!user || user.id === row.requested_by || user.disabledAt || !can(user, 'settings:manage')) return false;
  const ids = row.data ? changedWorkflows(row as Row) : [];
  return ids.every((id) => mayApprove(user, id, row.requested_by));
}

function view(row: Row, viewer?: Pick<UserRecord, 'id' | 'role'>, names = userNames()): PromotionRequestView {
  const asked = askedOf(row);
  const data = dataOf(row);
  const pending = row.status === 'pending';
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    target: row.target,
    ...(asked.workflows?.length && { workflows: asked.workflows }),
    ...(asked.prune && { prune: true }),
    ...(asked.force && { force: true }),
    ...(asked.message && { message: asked.message }),
    ...(asked.rowTables && { rowTables: asked.rowTables }),
    ...(asked.credentials === false && { credentials: false }),
    preview: data.preview,
    requestedBy: row.requested_by,
    ...(names.get(row.requested_by) && { requestedByName: names.get(row.requested_by) }),
    requestedAt: row.requested_at,
    ...(row.decided_by && { decidedBy: row.decided_by }),
    ...(row.decided_by && names.get(row.decided_by) && { decidedByName: names.get(row.decided_by) }),
    ...(row.decided_at && { decidedAt: row.decided_at }),
    ...(row.comment && { comment: row.comment }),
    ...(data.reason && { reason: data.reason }),
    ...(data.commit && { commit: data.commit }),
    ...(viewer && {
      canApprove: pending && mayApprovePromotion(getUser(viewer.id) ?? viewer, row),
      canCancel: pending && (viewer.id === row.requested_by || can(viewer, 'settings:manage')),
    }),
  };
}

function setStatus(row: Row, status: PromotionRequestStatus, changes: { by?: string; comment?: string; reason?: string; commit?: string } = {}): Row {
  const data = dataOf(row);
  const next: Row = {
    ...row,
    status,
    ...(changes.by !== undefined && { decided_by: changes.by }),
    decided_at: new Date().toISOString(),
    ...(changes.comment !== undefined && { comment: changes.comment || null }),
    data: JSON.stringify({ ...data, ...(changes.reason && { reason: changes.reason }), ...(changes.commit && { commit: changes.commit }) } satisfies Data),
  };
  save(next);
  return next;
}

const describe = (row: Pick<Row, 'source' | 'target'>, asked: Asked) =>
  `${asked.workflows?.length ? `${asked.workflows.length} workflow${asked.workflows.length === 1 ? '' : 's'}` : 'all workflows'} from ${row.source} to ${row.target}`;

function audit(action: string, row: Row, extra: { summary: string; outcome?: 'success' | 'failure'; details?: Record<string, unknown> }) {
  const asked = askedOf(row);
  recordAudit({
    action,
    ...(extra.outcome && { outcome: extra.outcome }),
    target: { type: 'environment', id: row.target, name: row.target },
    summary: extra.summary,
    details: { requestId: row.id, source: row.source, target: row.target, workflows: asked.workflows?.length ?? 'all', requestedBy: row.requested_by, ...extra.details },
  });
}

const requestUrl = () => `${publicUrl()}/settings#environments`;

/** Email the approvers and tell the governance channels about a new request. Background; never throws. */
function notifyApprovers(request: PromotionRequestView, row: Row) {
  const who = request.requestedByName ?? request.requestedBy;
  const changed = request.preview.entries.filter((e) => e.status !== 'unchanged').length;
  const subject = `Approval needed: ${who} wants to promote ${request.source} to ${request.target}`;
  const text = [
    `${who} asked to promote ${describe(row, askedOf(row))}: ${changed} workflow change${changed === 1 ? '' : 's'}, ${request.preview.files.length} other file${request.preview.files.length === 1 ? '' : 's'}.`,
    ...(request.message ? [`Message: ${request.message}`] : []),
    '',
    `Review it: ${requestUrl()}`,
  ].join('\n');
  const { fourEyes } = getGovernancePolicy();
  const jobs: Promise<unknown>[] = [];
  if (fourEyes.notifyEmail && mailConfigured()) {
    const emails = new Set(listUsers().filter((u) => mayApprovePromotion(u, row) && u.email).map((u) => u.email));
    for (const to of emails) jobs.push(sendMail({ to, subject, text }));
  }
  for (const id of fourEyes.channelIds) jobs.push(sendNotice(id, { subject, text, event: 'promotion_request.created', payload: { request: { ...request, preview: undefined }, url: requestUrl() } }));
  void Promise.allSettled(jobs).then((results) => {
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed.length) logger.warn('could not notify every approver of a promotion request', { 'landflow.promotion_request.id': row.id, error: String(failed[0].reason?.message ?? failed[0].reason) });
  });
}

/** Email the requester about a decision. Background; never throws. */
function notifyRequester(request: PromotionRequestView, notice: 'approved' | 'rejected' | 'failed') {
  if (!getGovernancePolicy().fourEyes.notifyEmail || !mailConfigured()) return;
  const requester = getUser(request.requestedBy);
  if (!requester?.email) return;
  const by = request.decidedByName ?? request.decidedBy ?? 'Someone';
  const route = `${request.source} → ${request.target}`;
  const subject = `${notice === 'approved' ? 'Approved' : notice === 'rejected' ? 'Rejected' : 'Promotion failed'}: promote ${route}`;
  const text = [
    `${by} ${notice === 'approved' ? 'approved' : notice === 'rejected' ? 'rejected' : 'approved, but the promotion failed for'} your request to promote ${route}.`,
    ...(request.comment ? [`Comment: ${request.comment}`] : []),
    ...(notice === 'failed' && request.reason ? [`Reason: ${request.reason}`] : []),
    ...(request.commit ? [`Commit: ${request.commit}`] : []),
    '',
    requestUrl(),
  ].join('\n');
  void sendMail({ to: requester.email, subject, text }).catch((error) => logger.warn('could not email the requester of a promotion request', { 'landflow.promotion_request.id': request.id, error: (error as Error).message }));
}

/** The preview to keep: without diffs when it is large. */
function stored(preview: PromotionResult): PromotionResult {
  if (JSON.stringify(preview).length <= MAX_PREVIEW) return preview;
  return { ...preview, entries: preview.entries.map(({ diff: _diff, ...e }) => e), files: preview.files.map(({ diff: _diff, ...f }) => f), warnings: [...preview.warnings, 'Diffs left out: the preview was too large to keep'] };
}

/**
 * Four-eyes on: preview the promotion and, when there is something to promote and no conflict stops it, record a
 * request instead. Returns the request, or (nothing to promote, or conflicts without `force`) the preview, as a
 * promotion that didn't happen.
 */
export async function requestPromotion(input: PromoteInput, requester: UserRecord): Promise<{ request: PromotionRequestView } | { result: PromotionResult }> {
  const preview = await promoteEnvironment({ ...input, dryRun: true, expectDigest: undefined });
  const changes = preview.entries.filter((e) => e.status !== 'unchanged').length + preview.files.length;
  if (!changes || (preview.conflicts && !input.force)) return { result: { ...preview, dryRun: false } };
  const source = preview.from.environment;
  const target = preview.to.environment;
  const asked: Asked = {
    ...(input.workflows?.length && { workflows: input.workflows }),
    ...(input.prune && { prune: true }),
    ...(input.force && { force: true }),
    ...(input.message?.trim() && { message: input.message.trim() }),
    ...(input.rowTables && { rowTables: input.rowTables }),
    ...(input.credentials === false && { credentials: false }),
  };
  const row: Row = {
    id: `prq_${nanoid(12)}`,
    status: 'pending',
    source,
    target,
    digest: preview.digest ?? '',
    input: JSON.stringify(asked),
    requested_by: requester.id,
    requested_at: new Date().toISOString(),
    decided_by: null,
    decided_at: null,
    comment: null,
    data: JSON.stringify({ preview: stored(preview) } satisfies Data),
  };
  const replaced = database().all<Row>('SELECT * FROM promotion_requests WHERE status = ? AND source = ? AND target = ?', 'pending', source, target);
  database().transaction(() => {
    for (const old of replaced) setStatus(old, 'canceled', { by: requester.id, reason: 'Replaced by a newer request' });
    save(row);
  });
  for (const old of replaced) audit('promotion_request.cancel', { ...old, status: 'canceled' }, { summary: 'Promotion request replaced by a newer one', details: { replacedBy: row.id } });
  audit('promotion_request.create', row, { summary: `Asked for approval to promote ${describe(row, asked)}`, details: { message: asked.message, conflicts: preview.conflicts } });
  const request = view(row, requester);
  try {
    notifyApprovers(request, row);
  } catch (error) {
    logger.warn('could not notify approvers of a promotion request', { error });
  }
  return { request };
}

/** Requests, newest first: pending by default, or with the given statuses. */
export function listPromotionRequests(options: { status?: PromotionRequestStatus[] | 'all'; limit?: number; viewer?: Pick<UserRecord, 'id' | 'role'> } = {}): PromotionRequestView[] {
  const statuses = options.status === 'all' ? undefined : (options.status ?? ['pending']);
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const where = statuses?.length ? `WHERE status IN (${statuses.map(() => '?').join(', ')})` : '';
  const names = userNames();
  return database()
    .all<Row>(`SELECT * FROM promotion_requests ${where} ORDER BY requested_at DESC, id DESC LIMIT ${limit}`, ...(statuses ?? []))
    .map((row) => view(row, options.viewer, names));
}

export function getPromotionRequest(id: string, viewer?: Pick<UserRecord, 'id' | 'role'>): PromotionRequestView | undefined {
  const row = rowOf(id);
  return row && view(row, viewer);
}

function pendingRow(id: string): Row {
  const row = rowOf(id);
  if (!row) throw new ApprovalError('Promotion request not found', 404);
  if (row.status !== 'pending') throw new ApprovalError(`This request is ${row.status === 'stale' ? 'out of date' : `already ${row.status}`}`, 409);
  if (row.source !== currentEnvironment()) throw new ApprovalError(`This request promotes from ${row.source}: decide it on that environment’s instance`, 409);
  return row;
}

/** Approve and promote. The approver must be someone else allowed to approve; the promotion must still write what was previewed. */
export async function approvePromotion(id: string, approver: UserRecord, comment?: string): Promise<{ request: PromotionRequestView; result: PromotionResult }> {
  const row = pendingRow(id);
  if (approver.id === row.requested_by) throw new ApprovalError('You can’t approve your own request: someone else has to', 403);
  if (!mayApprovePromotion(approver, row)) throw new ApprovalError('Only an owner or admin other than the requester, allowed to approve its workflows, can approve this', 403);
  // Claim it first, so a second approver (or a double click) can't promote it twice.
  const claimed = database().transaction(() => {
    const fresh = rowOf(id);
    if (fresh?.status !== 'pending') return undefined;
    return setStatus(fresh, 'approved', { by: approver.id, comment: comment?.trim() ?? '' });
  });
  if (!claimed) throw new ApprovalError('This request was decided meanwhile', 409);
  const asked = askedOf(row);
  const names = userNames();
  const by = `${names.get(row.requested_by) ?? row.requested_by}, approved by ${approver.name || approver.email}`;
  let result: PromotionResult;
  try {
    result = await promoteEnvironment({ ...asked, source: row.source, target: row.target, by, expectDigest: row.digest });
    if (!result.promoted) throw new StalePromotionError(result.conflicts ? 'The target changed a workflow since the request' : 'There is nothing left to promote');
  } catch (error) {
    const message = (error as Error).message;
    const stale = error instanceof StalePromotionError;
    const next = setStatus(claimed, stale ? 'stale' : 'failed', { reason: message });
    audit(stale ? 'promotion_request.stale' : 'promotion_request.approve', next, { outcome: stale ? undefined : 'failure', summary: stale ? `Promotion request went stale: ${message}` : `Approved, but could not promote: ${message}`, details: { comment, error: message } });
    if (!stale) notifyRequester(view(next), 'failed');
    throw new ApprovalError(stale ? `This request is out of date: ${message}. Ask again.` : message, stale ? 409 : ((error as { status?: number }).status ?? 500));
  }
  const done = setStatus(claimed, 'approved', { commit: result.commit });
  audit('promotion_request.approve', done, { summary: `Approved the promotion ${row.source} → ${row.target}${comment?.trim() ? `: ${comment.trim()}` : ''}`, details: { comment, commit: result.commit } });
  const request = view(done, approver);
  notifyRequester(request, 'approved');
  return { request, result };
}

/** Reject with a comment. Approvers only (the requester withdraws instead). */
export function rejectPromotion(id: string, user: UserRecord, comment?: string): PromotionRequestView {
  const row = pendingRow(id);
  if (user.id === row.requested_by) throw new ApprovalError('Withdraw your own request instead of rejecting it', 403);
  if (!mayApprovePromotion(user, row)) throw new ApprovalError('You can’t decide on this request', 403);
  const next = setStatus(row, 'rejected', { by: user.id, comment: comment?.trim() ?? '' });
  audit('promotion_request.reject', next, { summary: `Rejected the promotion ${row.source} → ${row.target}${comment?.trim() ? `: ${comment.trim()}` : ''}`, details: { comment } });
  const request = view(next, user);
  notifyRequester(request, 'rejected');
  return request;
}

/** Withdraw a pending request: the requester, or an owner or admin. */
export function cancelPromotion(id: string, user: Pick<UserRecord, 'id' | 'role'>): PromotionRequestView {
  const row = rowOf(id);
  if (!row) throw new ApprovalError('Promotion request not found', 404);
  if (row.status !== 'pending') throw new ApprovalError(`This request is already ${row.status}`, 409);
  if (user.id !== row.requested_by && !can(user, 'settings:manage')) throw new ApprovalError('Only the requester or an admin can withdraw this request', 403);
  const next = setStatus(row, 'canceled', { by: user.id });
  audit('promotion_request.cancel', next, { summary: `Withdrew the promotion request ${row.source} → ${row.target}` });
  return view(next, user);
}
