/**
 * Four-eyes publishing (Settings → Governance): when it is on, publishing, rolling back and (by default)
 * unpublishing a workflow need a second person. The publish and unpublish routes, legacy `active` saves, MCP tools
 * and Git sync go through `publishOrRequest()`, which either publishes (four-eyes off: exactly as before) or records
 * a request in `publish_requests` with the requester's note and a diff summary against what is live, and answers
 * 202. Approvers see pending requests (badge and list in the publish control, Settings → Governance) and approve or
 * reject them with a comment; approving calls `publishVersion()` / `unpublishWorkflow()` (lib/server/publish.ts), the
 * only code that publishes, with the requester as the publisher.
 *
 * Rules: an approver is a different, active user whose instance role is at least `fourEyes.approverRole` (`member`,
 * the instance's editor role, or `admin`); project roles can narrow that through `registerApproverCheck()` (the
 * projects module's hook). Nobody approves their own request. A request goes stale when the draft changes (publish
 * and rollback) or what is live changes (all kinds), checked on every workflow save and publication change and again
 * before approving. A newer request for the same workflow replaces a pending one. Every step is audited and approvers
 * (or the requester, for decisions) are notified (./notify). Plain server module (no Next.js imports): workers can
 * load it.
 */
import { nanoid } from 'nanoid';
import type { Workflow } from '@landflow/engine';
import type { PublishResult } from '../../shared/publish';
import type { PublishRequestDiff, PublishRequestedResponse, PublishRequestKind, PublishRequestList, PublishRequestStatus, PublishRequestView } from '../../shared/governance';
import { can } from '../../shared/auth';
import { recordAudit } from '../audit';
import { getUser, listUsers, userNames, type UserRecord } from '../auth/users';
import { database } from '../db';
import { parse } from '../db/rows';
import { onPublicationChanged, publishedVersionId } from '../publications';
import { publicationStatus, publishDraft, PublishError, publishVersion, unpublishWorkflow } from '../publish';
import { singleton } from '../singleton';
import { store } from '../store';
import { logger } from '../telemetry/logger';
import { diffWorkflows, getVersion, listVersions, recordVersion, summarizeDiff, versionFor } from '../versions';
import { notifyApprovers, notifyRequester } from './notify';
import { getGovernancePolicy, publishBlockedReason } from './policy';
import { ensureProjectApprovers, projectApproverLabel } from './project-approvers';
import { workflowRequiresFourEyes } from './scopes';

export class ApprovalError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface Row {
  id: string;
  workflow_id: string;
  kind: PublishRequestKind;
  status: PublishRequestStatus;
  version_id: string | null;
  draft_version_id: string | null;
  base_version_id: string | null;
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
  comment: string | null;
  data: string;
}

interface Data {
  workflowName?: string;
  versionNumber?: number;
  baseVersionNumber?: number;
  diff?: PublishRequestDiff;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Who may approve
// ---------------------------------------------------------------------------

/** A further say on who may approve a workflow's requests: false refuses, true or undefined leaves it to the rest. */
export type ApproverCheck = (user: UserRecord, workflowId: string) => boolean | undefined;

const approverChecks = () => singleton('four-eyes-approver-checks', () => new Set<ApproverCheck>());

/**
 * Hook for project roles: the projects module can require approvers to be editors (or more) of the workflow's
 * project. Instance roles apply first; any check answering false refuses. Returns the unregister function.
 */
export function registerApproverCheck(check: ApproverCheck): () => void {
  approverChecks().add(check);
  return () => approverChecks().delete(check);
}

/** Whether four-eyes publishing applies to `kind` now: on for the instance, or for `workflowId` by its own policy (./scopes). */
export function fourEyesApplies(kind: PublishRequestKind, workflowId?: string): boolean {
  const { fourEyes } = getGovernancePolicy();
  return (fourEyes.enabled || workflowRequiresFourEyes(workflowId)) && (kind !== 'unpublish' || fourEyes.unpublish);
}

/** Whether `user` may approve or reject requests for `workflowId` made by `requestedBy`. */
export function mayApprove(user: Pick<UserRecord, 'id' | 'role'> & { disabledAt?: string }, workflowId: string, requestedBy: string): boolean {
  if (!user || user.id === requestedBy || user.disabledAt) return false;
  // Projects say who approves their workflows' requests (./project-approvers.ts).
  ensureProjectApprovers();
  const { approverRole } = getGovernancePolicy().fourEyes;
  // `member` is the instance's editor role: owners, admins and members; `admin`: owners and admins.
  if (approverRole === 'admin' ? !can(user, 'settings:manage') : !['owner', 'admin', 'member'].includes(user.role)) return false;
  for (const check of approverChecks()) {
    try {
      if (check(user as UserRecord, workflowId) === false) return false;
    } catch (error) {
      logger.warn('a four-eyes approver check failed', { error });
      return false;
    }
  }
  return true;
}

/** Everyone who may approve a request (for notifications). */
export function approversFor(workflowId: string, requestedBy: string): UserRecord[] {
  return listUsers().filter((user) => mayApprove(user, workflowId, requestedBy));
}

// ---------------------------------------------------------------------------
// Rows and views
// ---------------------------------------------------------------------------

function rowOf(id: string): Row | undefined {
  return database().get<Row>('SELECT * FROM publish_requests WHERE id = ?', id);
}

function save(row: Row) {
  database().upsert('publish_requests', { ...row });
}

function view(row: Row, viewer?: Pick<UserRecord, 'id' | 'role'>, names = userNames()): PublishRequestView {
  const data = parse<Data>(row.data) ?? {};
  const workflowName = store.getWorkflow(row.workflow_id)?.name ?? data.workflowName ?? row.workflow_id;
  const pending = row.status === 'pending';
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowName,
    kind: row.kind,
    status: row.status,
    ...(row.version_id && { versionId: row.version_id }),
    ...(data.versionNumber !== undefined && { versionNumber: data.versionNumber }),
    ...(data.baseVersionNumber !== undefined && { baseVersionNumber: data.baseVersionNumber }),
    ...(row.note && { note: row.note }),
    ...(data.diff && { diff: data.diff }),
    requestedBy: row.requested_by,
    ...(names.get(row.requested_by) && { requestedByName: names.get(row.requested_by) }),
    requestedAt: row.requested_at,
    ...(row.decided_by && { decidedBy: row.decided_by }),
    ...(row.decided_by && names.get(row.decided_by) && { decidedByName: names.get(row.decided_by) }),
    ...(row.decided_at && { decidedAt: row.decided_at }),
    ...(row.comment && { comment: row.comment }),
    ...(data.reason && { reason: data.reason }),
    ...(viewer && {
      canApprove: pending && mayApprove(getUser(viewer.id) ?? viewer, row.workflow_id, row.requested_by),
      canCancel: pending && (viewer.id === row.requested_by || can(viewer, 'settings:manage')),
    }),
  };
}

function setStatus(row: Row, status: PublishRequestStatus, changes: { by?: string; comment?: string; reason?: string } = {}): Row {
  const data = parse<Data>(row.data) ?? {};
  const next: Row = {
    ...row,
    status,
    ...(changes.by !== undefined && { decided_by: changes.by }),
    decided_at: new Date().toISOString(),
    ...(changes.comment !== undefined && { comment: changes.comment || null }),
    data: JSON.stringify({ ...data, ...(changes.reason && { reason: changes.reason }) } satisfies Data),
  };
  save(next);
  return next;
}

const KIND_LABEL: Record<PublishRequestKind, string> = { publish: 'publish', rollback: 'rollback', unpublish: 'unpublish' };

function audit(action: string, row: Row, extra: { summary: string; outcome?: 'success' | 'failure'; details?: Record<string, unknown>; system?: boolean }) {
  const data = parse<Data>(row.data) ?? {};
  recordAudit({
    action,
    ...(extra.outcome && { outcome: extra.outcome }),
    ...(extra.system && { actor: 'system' as const }),
    target: { type: 'workflow', id: row.workflow_id, ...((store.getWorkflow(row.workflow_id)?.name ?? data.workflowName) && { name: store.getWorkflow(row.workflow_id)?.name ?? data.workflowName }) },
    summary: extra.summary,
    details: { requestId: row.id, kind: row.kind, versionId: row.version_id, versionNumber: data.versionNumber, requestedBy: row.requested_by, ...extra.details },
  });
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

/** The draft: the version matching the saved workflow, else the newest. */
function draftVersionId(workflow: Workflow): string | undefined {
  return (versionFor(workflow) ?? listVersions(workflow.id)[0])?.id;
}

function staleReason(row: Row): string | undefined {
  const workflow = store.getWorkflow(row.workflow_id);
  if (!workflow) return 'The workflow was deleted';
  if ((publishedVersionId(row.workflow_id) ?? null) !== (row.base_version_id ?? null)) return 'What is live changed after the request was made';
  if (row.kind !== 'unpublish' && (draftVersionId(workflow) ?? null) !== (row.draft_version_id ?? null)) return 'The draft changed after the request was made';
  return undefined;
}

/** Mark pending requests (of `workflowId`, or all) that went stale. Returns how many did. */
export function refreshStale(workflowId?: string): number {
  let count = 0;
  try {
    const rows = workflowId
      ? database().all<Row>('SELECT * FROM publish_requests WHERE workflow_id = ? AND status = ?', workflowId, 'pending')
      : database().all<Row>('SELECT * FROM publish_requests WHERE status = ?', 'pending');
    for (const row of rows) {
      const reason = staleReason(row);
      if (!reason) continue;
      const next = setStatus(row, 'stale', { reason });
      audit('publish_request.stale', next, { summary: `Publish request went stale: ${reason}`, system: true, details: { reason } });
      count++;
    }
  } catch (error) {
    logger.warn('could not check publish requests for staleness', { error });
  }
  return count;
}

const listening = () => singleton('four-eyes-listeners', () => ({ started: false, queued: false }));

/** Re-check pending requests after saves and publication changes. Idempotent. */
export function startFourEyes() {
  const state = listening();
  if (state.started) return;
  state.started = true;
  store.onWorkflowsChanged(() => {
    if (state.queued) return;
    state.queued = true;
    queueMicrotask(() => {
      state.queued = false;
      if (database().get<{ n: number }>('SELECT COUNT(*) AS n FROM publish_requests WHERE status = ?', 'pending')?.n) refreshStale();
    });
  });
  onPublicationChanged((workflowId) => refreshStale(workflowId));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function getRequest(id: string, viewer?: Pick<UserRecord, 'id' | 'role'>): PublishRequestView | undefined {
  startFourEyes();
  const row = rowOf(id);
  if (row?.status === 'pending') refreshStale(row.workflow_id);
  const fresh = rowOf(id);
  return fresh && view(fresh, viewer);
}

/** Requests, newest first: pending by default, or of one workflow, or with the given statuses. */
export function listRequests(options: { workflowId?: string; status?: PublishRequestStatus[] | 'all'; limit?: number; viewer?: Pick<UserRecord, 'id' | 'role'> } = {}): PublishRequestView[] {
  startFourEyes();
  refreshStale(options.workflowId);
  const statuses = options.status === 'all' ? undefined : (options.status ?? ['pending']);
  const clauses: string[] = [];
  const params: string[] = [];
  if (options.workflowId) {
    clauses.push('workflow_id = ?');
    params.push(options.workflowId);
  }
  if (statuses?.length) {
    clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const names = userNames();
  return database()
    .all<Row>(`SELECT * FROM publish_requests ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY requested_at DESC, id DESC LIMIT ${limit}`, ...params)
    .map((row) => view(row, options.viewer, names));
}

/** GET /api/publish-requests: the requests and the badge count for `viewer`. */
export function requestList(options: Parameters<typeof listRequests>[0] = {}): PublishRequestList {
  const { fourEyes } = getGovernancePolicy();
  const requests = listRequests(options);
  const pending = options.status === undefined && !options.workflowId ? requests : listRequests({ viewer: options.viewer });
  return {
    requests,
    // One workflow's list: on when its own policy asks for four-eyes too.
    fourEyes: { enabled: fourEyes.enabled || workflowRequiresFourEyes(options.workflowId), approverRole: fourEyes.approverRole, unpublish: fourEyes.unpublish },
    approvable: pending.filter((r) => r.canApprove).length,
  };
}

/** Pending requests `user` may approve (the sidebar badge). */
export function approvableCount(user: Pick<UserRecord, 'id' | 'role'>): number {
  return listRequests({ viewer: user }).filter((r) => r.canApprove).length;
}

// ---------------------------------------------------------------------------
// Requesting
// ---------------------------------------------------------------------------

function diffOf(base: Workflow | undefined, target: Workflow): PublishRequestDiff {
  const diff = diffWorkflows(base, target);
  return {
    summary: summarizeDiff(diff, !base),
    nodesAdded: diff.nodesAdded,
    nodesRemoved: diff.nodesRemoved,
    nodesChanged: diff.nodesChanged,
    connectionsChanged: diff.connectionsAdded + diff.connectionsRemoved,
    settingsChanged: diff.settingsChanged,
  };
}

export interface PublishAsk {
  workflowId: string;
  /** publish (or rollback, when it is an older version) or unpublish. */
  action: 'publish' | 'unpublish';
  /** The version to publish (default: the saved draft). */
  versionId?: string;
  note?: string;
  by?: string;
}

/** Record a publish request (four-eyes on). Throws ApprovalError when there is nothing to ask for. */
export function requestPublish(ask: PublishAsk): PublishRequestView {
  startFourEyes();
  const workflow = store.getWorkflow(ask.workflowId);
  if (!workflow) throw new ApprovalError('Workflow not found', 404);
  const by = ask.by ?? 'system';
  const live = publishedVersionId(workflow.id);
  const liveVersion = live ? getVersion(workflow.id, live) : undefined;
  const draft = draftVersionId(workflow);
  let kind: PublishRequestKind = 'unpublish';
  let versionId: string | undefined;
  let data: Data = { workflowName: workflow.name, ...(liveVersion && { baseVersionNumber: liveVersion.number }) };
  if (ask.action === 'unpublish') {
    if (!live && !workflow.active) throw new ApprovalError('This workflow isn’t published', 409);
    data = { ...data, diff: { summary: 'Stops its production triggers', nodesAdded: [], nodesRemoved: [], nodesChanged: [], connectionsChanged: 0, settingsChanged: false } };
  } else {
    const summary = ask.versionId ? listVersions(workflow.id).find((v) => v.id === ask.versionId) : (versionFor(workflow) ?? recordVersion(workflow));
    if (!summary) throw new ApprovalError(ask.versionId ? 'Version not found' : 'This workflow has no saved version to publish: save it first', ask.versionId ? 404 : 409);
    const version = getVersion(workflow.id, summary.id);
    if (!version) throw new ApprovalError('Version not found', 404);
    if (live === version.id) throw new ApprovalError(`Version ${version.number} is already published`, 409);
    const blocked = publishBlockedReason(version.workflow);
    if (blocked) throw new ApprovalError(blocked, 422);
    const newest = listVersions(workflow.id)[0];
    kind = newest && version.number < newest.number ? 'rollback' : 'publish';
    versionId = version.id;
    data = { ...data, versionNumber: version.number, diff: diffOf(liveVersion?.workflow, version.workflow) };
  }
  const now = new Date().toISOString();
  const row: Row = {
    id: `pr_${nanoid(12)}`,
    workflow_id: workflow.id,
    kind,
    status: 'pending',
    version_id: versionId ?? null,
    // A request for the draft goes stale when the draft changes; one for an older version too (it was judged against it).
    draft_version_id: (ask.action === 'publish' && !ask.versionId ? versionId : draft) ?? null,
    base_version_id: live ?? null,
    requested_by: by,
    requested_at: now,
    decided_by: null,
    decided_at: null,
    note: ask.note?.trim() || null,
    comment: null,
    data: JSON.stringify(data),
  };
  const replaced = database().all<Row>('SELECT * FROM publish_requests WHERE workflow_id = ? AND status = ?', workflow.id, 'pending');
  database().transaction(() => {
    for (const old of replaced) setStatus(old, 'canceled', { by, reason: 'Replaced by a newer request' });
    save(row);
  });
  for (const old of replaced) audit('publish_request.cancel', { ...old, status: 'canceled' }, { summary: `Publish request replaced by a newer one`, details: { replacedBy: row.id } });
  audit('publish_request.create', row, { summary: `Asked for approval to ${KIND_LABEL[kind]} “${workflow.name}”${data.versionNumber !== undefined ? ` (version ${data.versionNumber})` : ''}`, details: { note: row.note, diff: data.diff?.summary } });
  const request = view(row);
  const { fourEyes } = getGovernancePolicy();
  try {
    notifyApprovers(request, { email: fourEyes.notifyEmail, channelIds: fourEyes.channelIds, approverIds: approversFor(workflow.id, by).map((u) => u.id) });
  } catch (error) {
    logger.warn('could not notify approvers', { error });
  }
  return request;
}

export type PublishOutcome = ({ approvalRequired?: false } & PublishResult) | PublishRequestedResponse;

/**
 * Publish, roll back or unpublish, or (four-eyes on) ask for approval to. The one entry point for people and tools;
 * approvals and boot-time repairs call lib/server/publish.ts directly. PublishError and ApprovalError carry a status.
 */
export async function publishOrRequest(ask: PublishAsk): Promise<PublishOutcome> {
  const kind: PublishRequestKind = ask.action === 'unpublish' ? 'unpublish' : 'publish';
  if (!fourEyesApplies(kind, ask.workflowId)) {
    if (ask.action === 'unpublish') return unpublishWorkflow(ask.workflowId, ask.by, ask.note);
    return ask.versionId ? publishVersion(ask.workflowId, ask.versionId, ask.by, ask.note) : publishDraft(ask.workflowId, ask.by, ask.note);
  }
  // Nothing to ask for: the version is live already, or there is nothing to unpublish.
  const workflow = store.getWorkflow(ask.workflowId);
  const live = publishedVersionId(ask.workflowId);
  const target = ask.action === 'publish' ? (ask.versionId ?? (workflow && versionFor(workflow)?.id)) : undefined;
  if (workflow && (ask.action === 'publish' ? target !== undefined && target === live : !live && !workflow.active)) return { ...(await publicationStatus(ask.workflowId)), triggerErrors: [] };
  const request = requestPublish(ask);
  return { ...(await publicationStatus(ask.workflowId)), approvalRequired: true, request: view(rowOf(request.id)!, ask.by ? getUser(ask.by) : undefined), triggerErrors: [] };
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

function pendingRow(id: string): Row {
  startFourEyes();
  const row = rowOf(id);
  if (!row) throw new ApprovalError('Publish request not found', 404);
  if (row.status !== 'pending') throw new ApprovalError(`This request is ${row.status === 'stale' ? 'out of date' : `already ${row.status}`}`, 409);
  const reason = staleReason(row);
  if (reason) {
    const next = setStatus(row, 'stale', { reason });
    audit('publish_request.stale', next, { summary: `Publish request went stale: ${reason}`, system: true, details: { reason } });
    throw new ApprovalError(`This request is out of date: ${reason}. Ask again.`, 409);
  }
  return row;
}

/** Approve and publish (or unpublish). The approver must be someone else allowed to approve. */
export async function approveRequest(id: string, approver: UserRecord, comment?: string): Promise<{ request: PublishRequestView; result: PublishResult }> {
  const row = pendingRow(id);
  if (approver.id === row.requested_by) throw new ApprovalError('You can’t approve your own request: someone else has to', 403);
  if (!mayApprove(approver, row.workflow_id, row.requested_by)) {
    const role = projectApproverLabel(row.workflow_id) ?? (getGovernancePolicy().fourEyes.approverRole === 'admin' ? 'an owner or admin' : 'a builder (member, admin or owner)');
    throw new ApprovalError(`Only ${role} other than the requester can approve this`, 403);
  }
  // Claim it first, so a second approver (or a double click) can't publish it twice.
  const claimed = database().transaction(() => {
    const fresh = rowOf(id);
    if (fresh?.status !== 'pending') return undefined;
    return setStatus(fresh, 'approved', { by: approver.id, comment: comment?.trim() ?? '' });
  });
  if (!claimed) throw new ApprovalError('This request was decided meanwhile', 409);
  const approverName = approver.name || approver.email;
  const note = [row.note, `approved by ${approverName}`].filter(Boolean).join(' — ');
  let result: PublishResult;
  try {
    result = row.kind === 'unpublish' ? await unpublishWorkflow(row.workflow_id, row.requested_by, note) : await publishVersion(row.workflow_id, row.version_id!, row.requested_by, note);
  } catch (error) {
    const message = (error as Error).message;
    const failed = setStatus(claimed, 'failed', { reason: message });
    audit('publish_request.approve', failed, { outcome: 'failure', summary: `Approved, but could not ${KIND_LABEL[row.kind]}: ${message}`, details: { comment, error: message } });
    notifyRequester(view(failed), 'failed', { email: getGovernancePolicy().fourEyes.notifyEmail });
    throw new ApprovalError(message, error instanceof PublishError ? error.status : 500);
  }
  audit('publish_request.approve', claimed, { summary: `Approved the request to ${KIND_LABEL[row.kind]}${comment?.trim() ? `: ${comment.trim()}` : ''}`, details: { comment } });
  const request = view(rowOf(id) ?? claimed, approver);
  notifyRequester(request, 'approved', { email: getGovernancePolicy().fourEyes.notifyEmail });
  return { request, result };
}

/** Reject with a comment. Approvers only (the requester withdraws instead). */
export function rejectRequest(id: string, user: UserRecord, comment?: string): PublishRequestView {
  const row = pendingRow(id);
  if (user.id === row.requested_by) throw new ApprovalError('Withdraw your own request instead of rejecting it', 403);
  if (!mayApprove(user, row.workflow_id, row.requested_by)) throw new ApprovalError('You can’t decide on this request', 403);
  const next = setStatus(row, 'rejected', { by: user.id, comment: comment?.trim() ?? '' });
  audit('publish_request.reject', next, { summary: `Rejected the request to ${KIND_LABEL[row.kind]}${comment?.trim() ? `: ${comment.trim()}` : ''}`, details: { comment } });
  const request = view(next, user);
  notifyRequester(request, 'rejected', { email: getGovernancePolicy().fourEyes.notifyEmail });
  return request;
}

/** Withdraw a pending request: the requester, or an owner or admin. */
export function cancelRequest(id: string, user: Pick<UserRecord, 'id' | 'role'>): PublishRequestView {
  startFourEyes();
  const row = rowOf(id);
  if (!row) throw new ApprovalError('Publish request not found', 404);
  if (row.status !== 'pending') throw new ApprovalError(`This request is already ${row.status}`, 409);
  if (user.id !== row.requested_by && !can(user, 'settings:manage')) throw new ApprovalError('Only the requester or an admin can withdraw this request', 403);
  const next = setStatus(row, 'canceled', { by: user.id });
  audit('publish_request.cancel', next, { summary: `Withdrew the request to ${KIND_LABEL[row.kind]}` });
  return view(next, user);
}

// ---------------------------------------------------------------------------
// Saves that switch `active`
// ---------------------------------------------------------------------------

export interface HeldActivation<T> {
  /** What to save: `active` as it was when the change is held. */
  workflow: T;
  /** The publish or unpublish to ask for after the save (four-eyes on). */
  held?: 'publish' | 'unpublish';
  /** Why activation was refused (nodes the policy doesn't allow). */
  blocked?: string;
}

/**
 * A save that turns `active` on or off (older clients, the API, MCP tools, imports) publishes or unpublishes through
 * the store. With four-eyes on that is held (the save keeps the current state; ask with `requestHeld` after saving),
 * and a workflow with nodes the policy doesn't allow isn't activated. Policies off: `next` unchanged.
 */
export function holdActivation<T extends Pick<Workflow, 'active' | 'nodes'>>(next: T, existing: Pick<Workflow, 'active'> | undefined): HeldActivation<T> {
  const was = Boolean(existing?.active);
  const wants = next.active === undefined ? was : Boolean(next.active);
  if (wants === was) return { workflow: next };
  if (wants) {
    const blocked = publishBlockedReason(next);
    if (blocked) return { workflow: { ...next, active: was }, blocked };
    if (fourEyesApplies('publish', (next as { id?: string }).id)) return { workflow: { ...next, active: was }, held: 'publish' };
  } else if (fourEyesApplies('unpublish', (next as { id?: string }).id)) {
    return { workflow: { ...next, active: was }, held: 'unpublish' };
  }
  return { workflow: next };
}

/** After a save `holdActivation` held: record the request. Returns it, or the reason it couldn't be asked for. */
export function requestHeld(held: HeldActivation<unknown>['held'], workflowId: string, by?: string, note?: string): { request?: PublishRequestView; error?: string } {
  if (!held) return {};
  try {
    return { request: requestPublish({ workflowId, action: held, by, note }) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}
