/**
 * Grants (docs/access-requests.md#grants-and-removal): what a decision turns into, and what takes it away.
 *
 * `applyDecision` is Apply Access Decision's whole job and trusts only the server: the request must be pending, started by this run
 * of the installed flow; the decision comes from the run's record; the decider is an active person who is an approver of that step now,
 * not the requester; the duration is one the entry offers and no longer than asked. Anything else records `failed` with the reason
 * and grants nothing. Removal is a conditional claim (store.ts `claimGrant`) so two processes never both remove one grant.
 */
import { nanoid } from 'nanoid';
import { durationText, type AccessDecision, type AccessGrantView } from '../../shared/access';
import { recordAudit } from '../audit';
import { findUserByEmail, getUser, normalizeEmail, type UserRecord } from '../auth/users';
import { database } from '../db';
import { isInstanceAdmin, type Actor } from '../projects/access';
import { liveExecution } from '../runner';
import { store } from '../store';
import { logger } from '../telemetry/logger';
import { entryData } from './catalog';
import { runAction } from './actions';
import { recordedDecisions, type RecordedStep } from './decision';
import { AccessActionError, AccessError } from './errors';
import { mailApprovers, mailRequester, type Subject } from './notify';
import { approversFor, auditActorOf, canMarkDone, canRetry, canRevoke, canSeeGrant, isActiveUser, type EntryData } from './rules';
import { liveGrantOnTarget } from './requests';
import { accessSettings, claimGrant, claimRequest, grantRow, insertGrant, parseJson, patchRequest, requestRow, type GrantRow, type RequestRow } from './store';
import { SYSTEMS, targetKeyOf } from './systems';
import { grantView, snapshotOf } from './views';

export const REMOVE_LEASE_MS = 10 * 60_000;
export const MAX_RETRY_MS = 60 * 60_000;
export const OVERDUE_MS = 24 * 3_600_000;

const lengthOf = (minutes: number | null) => (minutes === null ? Infinity : minutes);
const iso = (ms: number) => new Date(ms).toISOString();

export interface AppliedDecision {
  requestId: string;
  status: 'approved' | 'denied' | 'expired' | 'failed';
  grantId?: string;
  until?: string | null;
  note?: string;
  dryRun?: boolean;
}

export const EXAMPLE_REQUEST = 'areq_example';

const subjectOf = (row: RequestRow, entry: EntryData): Subject => ({
  requesterId: row.requester_id,
  requesterName: getUser(row.requester_id)?.name || getUser(row.requester_id)?.email || row.requester_id,
  entryName: entry.name,
  targetLabel: entry.target.label,
  duration: durationText(row.duration_minutes === null ? null : Number(row.duration_minutes)),
});

/** The active person a decision's `by` names (an email, or `email:<address>`), or undefined; Slack, timeout and unknown never name one. */
function deciderOf(by: string | undefined): UserRecord | undefined {
  if (!by || by === 'timeout' || by === 'unknown' || by.startsWith('slack:')) return undefined;
  const user = findUserByEmail(normalizeEmail(by.startsWith('email:') ? by.slice(6) : by));
  return user && !user.disabledAt ? user : undefined;
}

const channelOf = (by: string | undefined) => (by?.startsWith('email:') ? 'email' : by?.startsWith('slack:') ? 'slack' : by === 'timeout' ? 'timeout' : 'needs-you');

export interface ApplyOptions {
  /** The Ask a Person names in step order. */
  steps: string[];
}

/** Settle request `requestId` for run `executionId`: `outcome` is which Apply Access Decision branch ran. */
export async function applyDecision(requestId: string, executionId: string, outcome: 'approved' | 'rejected', options: ApplyOptions): Promise<AppliedDecision> {
  if (requestId === EXAMPLE_REQUEST) return { requestId, status: 'approved', dryRun: true, note: 'An example run: nothing was granted' };
  const row = requestRow(requestId);
  if (!row) throw new AccessError('Access request not found', 404);
  if (row.status !== 'pending') throw new AccessError(`This request is ${row.status}, not waiting for an answer`, 409);
  if (row.execution_id !== executionId) throw new AccessError('A request is applied only by the run it started', 409);
  const entry = snapshotOf(row);
  const subject = subjectOf(row, entry);
  const fail = async (note: string): Promise<AppliedDecision> => {
    const { won } = await claimRequest(requestId, 'pending', { status: 'failed', note });
    if (won) {
      recordAudit({ action: 'access.request.fail', target: { type: 'access_request', id: requestId, name: entry.name }, project: null, summary: `An access request failed: ${note}`, details: { from: 'pending', to: 'failed' } });
      void mailRequester.failed(subject, note);
    }
    return { requestId, status: 'failed', note };
  };

  const installed = accessSettings().workflowId;
  const question = parseJson<{ title: string; text: string; nodes: string[] } | undefined>(row.question, undefined);
  const run = await recordedDecisions(executionId, options.steps);
  if (!installed || row.workflow_id !== installed || run?.workflowId !== installed) return fail('The run is not the installed access flow, so nothing was granted');
  const steps = run.steps;

  if (outcome === 'rejected') {
    const rejection = steps.find((step): step is RecordedStep => Boolean(step) && step!.approved === false);
    if (!rejection) return fail('The run has no recorded answer, so nothing was granted');
    const timeout = rejection.by === 'timeout';
    const status = timeout ? 'expired' : 'denied';
    const decider = deciderOf(rejection.by);
    const decision: AccessDecision = { step: steps.indexOf(rejection) + 1, outcome: 'deny', by: decider?.id ?? rejection.by ?? 'unknown', ...(decider && { byName: decider.name || decider.email }), ...(rejection.comment && { comment: rejection.comment }), channel: channelOf(rejection.by), at: new Date().toISOString() };
    const { won } = await claimRequest(requestId, 'pending', { status, decisions: JSON.stringify([decision]), note: rejection.comment || (timeout ? 'Nobody answered in time' : null) });
    if (!won) throw new AccessError('This request was settled by someone else', 409);
    recordAudit({ action: timeout ? 'access.request.expire' : 'access.request.deny', actor: decider ? auditActorOf({ id: decider.id } as Actor) : undefined, target: { type: 'access_request', id: requestId, name: entry.name }, project: null, summary: timeout ? 'An access request expired with no answer' : 'Denied an access request', details: { from: 'pending', to: status } });
    void (timeout ? mailRequester.expired(subject) : mailRequester.denied(subject, rejection.comment));
    return { requestId, status };
  }

  // Approved: the flow lists as many steps as the entry has, each recorded by the node this request was filed with, answering the
  // question the server built; every step has an approval by a different current approver of it.
  if (!question) return fail('The request has no recorded question, so nothing was granted');
  if (options.steps.length !== entry.steps.length || question.nodes.length !== entry.steps.length) return fail(`The flow lists ${options.steps.length} approval step${options.steps.length === 1 ? '' : 's'} but this entry needs ${entry.steps.length}, so nothing was granted`);
  const asked = row.duration_minutes === null ? null : Number(row.duration_minutes);
  const used = new Set<string>();
  const decisions: AccessDecision[] = [];
  let minutes: number | null = asked;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) return fail(`The run has no recorded answer for step ${i + 1}${i > 0 ? ` (“${options.steps[i]}”)` : ''}: waiting for step ${i + 1}, so nothing was granted`);
    if (!step.approved) return fail('The run’s record says the request was rejected, so nothing was granted');
    if (step.nodeId !== question.nodes[i]) return fail(`Step ${i + 1} was not answered by the node this request was filed with, so nothing was granted`);
    if (i === 0 && (step.title !== question.title || step.originalText !== question.text)) return fail('The question the approver answered is not the one this request built (the flow was changed), so nothing was granted');
    if (i > 0 && step.originalText === undefined) return fail(`Step ${i + 1} has no recorded question, so nothing was granted`);
    const decider = deciderOf(step.by);
    if (!decider) return fail('The approval was not by a person Landflow knows (Slack, a timeout and unknown answers never grant), so nothing was granted');
    if (decider.id === row.requester_id) return fail('You can’t approve your own request, so nothing was granted');
    // The people it was filed with (including the fallback admins of that day), still active: not whoever became one since.
    const allowed = i === 0 ? parseJson<string[]>(row.approvers, []).filter((id) => id !== row.requester_id && isActiveUser(id)) : approversFor(entry, row.requester_id, i);
    if (!allowed.includes(decider.id)) return fail(`${decider.name || decider.email} is not an approver of this request, so nothing was granted`);
    if (used.has(decider.id)) return fail('Each step needs a different approver, so nothing was granted');
    used.add(decider.id);
    let chosen: number | null = asked;
    if (step.choice !== undefined) {
      const parsed = step.choice === 'unlimited' ? null : Number(step.choice);
      if (parsed !== null && !Number.isInteger(parsed)) return fail('The approved duration is not a duration this entry offers, so nothing was granted');
      chosen = parsed;
    }
    if (!entry.durations.includes(chosen)) return fail('The approved duration is not one this entry offers, so nothing was granted');
    if (lengthOf(chosen) > lengthOf(asked)) return fail('The approved duration is longer than asked, so nothing was granted');
    if (lengthOf(chosen) < lengthOf(minutes)) minutes = chosen;
    decisions.push({ step: i + 1, outcome: 'approve', by: decider.id, byName: decider.name || decider.email, ...(step.comment && { comment: step.comment }), channel: channelOf(step.by), at: new Date().toISOString(), durationMinutes: chosen });
  }
  if (!steps.length) return fail('The flow lists no approval step, so nothing was granted');
  const approver = decisions[decisions.length - 1]!;
  if (entry.system !== 'manual' && row.account) {
    const taken = liveGrantOnTarget(entry.system, entry.target.config, row.account);
    if (taken) return fail('That account already has this access, through another entry, so nothing was granted');
  }
  const claim = await claimRequest(requestId, 'pending', { status: 'approved', decisions: JSON.stringify(decisions), approved_minutes: minutes });
  if (!claim.won) throw new AccessError('This request was settled by someone else', 409);
  recordAudit({ action: 'access.request.approve', actor: { id: approver.by }, target: { type: 'access_request', id: requestId, name: entry.name }, project: null, summary: `Approved ${entry.name} for ${durationText(minutes)}`, details: { from: 'pending', to: 'approved', duration: durationText(minutes), asked: durationText(asked) } });
  let grant: GrantRow;
  try {
    grant = await createGrant(claim.row!, entry, minutes, decisions.map((d) => d.byName).join(', '));
  } catch (error) {
    // The table has the last word on one live grant per target and account (`access_grants_live_target`): a second one, however it got here, is refused.
    if (!/unique/i.test((error as Error).message)) throw error;
    const note = 'That account already has this access, through another entry, so nothing was granted';
    await claimRequest(requestId, 'approved', { status: 'failed', note });
    recordAudit({ action: 'access.request.fail', target: { type: 'access_request', id: requestId, name: entry.name }, project: null, summary: `An access request failed: ${note}`, details: { from: 'approved', to: 'failed' } });
    void mailRequester.failed(subject, note);
    return { requestId, status: 'failed', note };
  }
  return { requestId, status: 'approved', grantId: grant.id, until: grant.until, ...(grant.status === 'failed' && { note: grant.last_error ?? 'The grant failed' }) };
}

/** Make the grant for an approved request: automatic systems now, manual ones wait for a person. */
async function createGrant(request: RequestRow, entry: EntryData, minutes: number | null, approvedBy: string): Promise<GrantRow> {
  const now = Date.now();
  const stored = entryData(request.entry_id);
  const row: GrantRow = {
    id: `ag_${nanoid(10)}`,
    request_id: request.id,
    entry_id: request.entry_id,
    holder_id: request.requester_id,
    account: request.account,
    system: entry.system,
    target: JSON.stringify(entry.target),
    credential_id: stored?.system === entry.system ? (stored.credentialId ?? null) : null,
    status: 'pending',
    since: null,
    until: null,
    approved_by: approvedBy,
    already_had: 0,
    lease_until: null,
    attempts: 0,
    next_attempt_at: null,
    ended_at: null,
    ended_by: null,
    end_reason: minutes === null ? null : String(minutes),
    last_error: null,
    checked_at: null,
    overdue_noted: 0,
    remove_reason: null,
    remove_by: null,
    target_key: entry.system === 'manual' ? null : targetKeyOf(entry.system, entry.target.config),
    created_at: iso(now),
    updated_at: iso(now),
  };
  insertGrant(row);
  const subject = subjectOf(request, entry);
  if (entry.system === 'manual') {
    const instructions = entry.target.config.instructions ?? '';
    void mailRequester.waiting(subject);
    void mailApprovers.grantByHand(approversFor(entry, request.requester_id), subject, instructions);
    return row;
  }
  return activateGrant(row.id, minutes, 'pending');
}

/**
 * Put the access in place (pending, or failed on a retry, -> active). `minutes` is how long it lasts from now; the grant row keeps it in
 * `end_reason` until it starts (a manual grant's Done reads it there).
 *
 * The first attempt checks the system once, before the first add, and stores whether the person already had the access (`already_had`,
 * with `checked_at` as the sign it was asked); no retry, and no pass that takes the grant over after a stopped process, ever works it out
 * again (a second add that says "already a member" would only be the first one's result). The claim is taken only when no unexpired lease
 * is held, so two attempts never add at once. A revoke that came while the add was in flight (`remove_reason`) is carried out the moment
 * the access is in place.
 */
async function activateGrant(id: string, minutes: number | null, from: 'pending' | 'failed', now = Date.now()): Promise<GrantRow> {
  const claim = await claimGrant(id, from, { status: 'pending', attempts: 0 }, { leaseMs: REMOVE_LEASE_MS, now, leaseFree: true });
  const grant = claim.row!;
  if (!claim.won) return grant;
  const request = grant.request_id ? requestRow(grant.request_id) : undefined;
  const entry = request ? snapshotOf(request) : entryData(grant.entry_id);
  const subject = request && entry ? subjectOf(request, entry) : undefined;
  try {
    const target = parseJson<{ config: Record<string, string> }>(grant.target, { config: {} });
    const act = { system: grant.system as never, config: target.config, credentialId: grant.credential_id, account: grant.account ?? '' };
    const first = grant.checked_at === null;
    let alreadyHad = Number(grant.already_had) === 1;
    if (first) {
      if (SYSTEMS[grant.system as keyof typeof SYSTEMS]?.checks) alreadyHad = (await runAction(act, 'check')).state !== 'none';
      await claimGrant(id, 'pending', { status: 'pending', already_had: alreadyHad ? 1 : 0, checked_at: iso(Date.now()) });
    }
    const result = await runAction(act, 'add');
    // A system with no check says it in the add's answer, the first time only.
    if (first && result.alreadyHad) alreadyHad = true;
    const until = minutes === null ? null : iso(now + minutes * 60_000);
    const done = await claimGrant(id, 'pending', { status: 'active', since: iso(now), until, already_had: alreadyHad ? 1 : 0, lease_until: null, last_error: null, end_reason: null });
    recordAudit({ action: 'access.grant.activate', target: { type: 'access_grant', id, name: entry?.name }, project: null, summary: `Granted ${entry?.name ?? 'access'} for ${durationText(minutes)}${alreadyHad ? ' (the person already had it)' : ''}`, details: { from: 'pending', to: 'active', until: until ?? 'unlimited' } });
    const active = done.row!;
    if (active.remove_reason) {
      // Taken back while it was being put in place: now it is in place, so it can be taken back.
      const removed = await removeGrant(id, active.remove_reason === 'given_back' ? 'given_back' : 'revoked', active.remove_by ?? undefined);
      return removed ?? active;
    }
    if (subject) void mailRequester.granted(subject, until);
    return active;
  } catch (error) {
    const message = error instanceof AccessActionError || error instanceof AccessError ? error.message : 'The grant failed';
    if (!(error instanceof AccessActionError) && !(error instanceof AccessError)) logger.warn('an access grant failed', { error: (error as Error).message });
    const failed = await claimGrant(id, 'pending', { status: 'failed', last_error: message, lease_until: null, end_reason: minutes === null ? null : String(minutes) });
    recordAudit({ action: 'access.grant.fail', target: { type: 'access_grant', id, name: entry?.name }, project: null, summary: `Could not grant ${entry?.name ?? 'access'}: ${message}`, details: { from: 'pending', to: 'failed', error: message } });
    // A revoke came while the add was in flight: the add may have worked at the system before it failed, so take it back now
    // (removeGrant leaves a person who had it before, and what the check never covered, alone).
    if (failed.row?.remove_reason) {
      const removed = await removeGrant(id, failed.row.remove_reason === 'given_back' ? 'given_back' : 'revoked', failed.row.remove_by ?? undefined, Date.now(), ['failed']);
      return removed ?? failed.row;
    }
    if (subject) void mailRequester.failed(subject, message);
    return failed.row!;
  }
}

/** A pending grant whose lease ran out (a process stopped mid-grant): taken up again, keeping what was recorded. */
export const resumeGrant = (grant: GrantRow, now = Date.now()) => activateGrant(grant.id, grant.end_reason === null ? null : Number(grant.end_reason), 'pending', now);

/** The minutes a failed or manual-pending grant was approved for (kept in `end_reason` until it starts). */
const pendingMinutes = (grant: GrantRow): number | null => (grant.end_reason === null ? null : Number(grant.end_reason));

// ---- removal ----------------------------------------------------------------------------------------------

export type EndReason = 'expired' | 'given_back' | 'revoked';

/**
 * Take the access away. `from` is where the grant may be: active (now), revoke_failed (a retry) or removing with an expired lease (a
 * process stopped). Manual grants become `removing` and wait for a person (markDone); automatic ones are removed through the plugin,
 * unless the person already had the access before Landflow granted it, which is never taken back.
 */
export async function removeGrant(id: string, reason: EndReason, by: string | undefined, now = Date.now(), also: Array<GrantRow['status']> = []): Promise<GrantRow | undefined> {
  const current = grantRow(id);
  if (!current) return undefined;
  const from: Array<GrantRow['status']> = ['active', 'revoke_failed', 'drift', ...also];
  const stale = current.status === 'removing' && current.lease_until !== null && Date.parse(current.lease_until) <= now;
  if (stale) from.push('removing');
  const claim = await claimGrant(id, from, { status: 'removing', end_reason: reason, ended_by: by ?? null }, { leaseMs: REMOVE_LEASE_MS, now });
  if (!claim.won) return claim.row;
  const grant = claim.row!;
  const entry = entryData(grant.entry_id);
  const target = parseJson<{ config: Record<string, string>; label?: string }>(grant.target, { config: {} });
  const request = grant.request_id ? requestRow(grant.request_id) : undefined;
  const snapshot = request ? snapshotOf(request) : entry;
  const subject = request && snapshot ? subjectOf(request, snapshot) : undefined;
  const label = reason === 'expired' ? 'it ended' : reason === 'given_back' ? 'given back' : 'taken back';

  if (grant.system === 'manual') {
    if (subject && snapshot) void mailApprovers.removeByHand(entry ? approversFor(entry, grant.holder_id) : [], subject, snapshot.target.config.instructions ?? '');
    return grant;
  }
  // A grant that drifted (the person left outside Landflow) ends without a removal: whoever is in the group again now put them there.
  if (current.status === 'drift') return finishRemoval(grant, reason, by, 'The person had left outside Landflow before this ended, so nothing was removed', subject, label);
  // A grant that failed: with no check made (`checked_at` empty) the add never ran, so there is nothing of ours to take back; and where
  // Landflow can't check a member it can't tell the person's own access from what its failed add did, so it removes nothing.
  if (current.status === 'failed') {
    if (current.checked_at === null) return finishRemoval(grant, reason, by, 'It was never added (the check before it did not finish), so nothing was removed', subject, label);
    if (!SYSTEMS[grant.system as keyof typeof SYSTEMS]?.checks) return finishRemoval(grant, reason, by, 'Landflow could not tell what its failed add did here, so nothing was removed: check the system by hand', subject, label);
  }
  if (Number(grant.already_had) === 1) return finishRemoval(grant, reason, by, 'The person had this access before Landflow granted it, so it was not taken back', subject, label);
  try {
    await runAction({ system: grant.system as never, config: target.config, credentialId: grant.credential_id, account: grant.account ?? '' }, 'remove');
  } catch (error) {
    const message = error instanceof AccessActionError || error instanceof AccessError ? error.message : 'The removal failed';
    const attempts = Number(grant.attempts) + 1;
    const delay = Math.min(MAX_RETRY_MS, 60_000 * 2 ** (attempts - 1));
    const failed = await claimGrant(id, 'removing', { status: 'revoke_failed', attempts, last_error: message, next_attempt_at: iso(now + delay), lease_until: null });
    recordAudit({ action: 'access.grant.revoke_failed', target: { type: 'access_grant', id, name: snapshot?.name }, project: null, summary: `Could not remove ${snapshot?.name ?? 'access'}: ${message}`, details: { from: 'removing', to: 'revoke_failed', reason, attempts, error: message } });
    return failed.row;
  }
  return finishRemoval(grant, reason, by, undefined, subject, label);
}

async function finishRemoval(grant: GrantRow, reason: EndReason, by: string | undefined, note: string | undefined, subject: Subject | undefined, label: string, now = Date.now()): Promise<GrantRow | undefined> {
  const status = reason === 'expired' ? 'expired' : 'revoked';
  const done = await claimGrant(grant.id, 'removing', { status, ended_at: iso(now), ended_by: by ?? null, end_reason: reason, lease_until: null, last_error: note ?? null, attempts: 0, next_attempt_at: null });
  recordAudit({ action: 'access.grant.revoke', actor: by ? { id: by } : undefined, target: { type: 'access_grant', id: grant.id }, project: null, summary: `Removed access (${reason})${note ? `: ${note}` : ''}`, details: { from: 'removing', to: status, reason, ...(note && { note }) } });
  if (subject) void mailRequester.removed(subject, label);
  return done.row;
}

// ---- people's actions -------------------------------------------------------------------------------------

function visibleGrant(actor: Actor, id: string): GrantRow {
  const row = grantRow(id);
  if (!row || !canSeeGrant(actor, { holderId: row.holder_id }, entryData(row.entry_id))) throw new AccessError('Access grant not found', 404);
  return row;
}

/** Give it back (the holder) or take it back (owners, approvers, admins). A manual grant waits for a person's Done. */
export async function revokeNow(actor: Actor, id: string): Promise<AccessGrantView> {
  const grant = visibleGrant(actor, id);
  const entry = entryData(grant.entry_id);
  if (!canRevoke(actor, { holderId: grant.holder_id }, entry)) throw new AccessError('Access grant not found', 404);
  const reason: EndReason = grant.holder_id === actor.id ? 'given_back' : 'revoked';
  if (grant.status === 'pending') {
    if (grant.system === 'manual') {
      // A manual grant nobody has done yet: nothing to remove.
      const { won } = await claimGrant(id, 'pending', { status: 'revoked', ended_at: iso(Date.now()), ended_by: actor.id, end_reason: 'revoked' });
      if (!won) throw new AccessError('This grant is already settled', 409);
      recordAudit({ action: 'access.grant.revoke', actor: auditActorOf(actor), target: { type: 'access_grant', id }, project: null, summary: 'Cancelled a grant nobody had done yet', details: { from: 'pending', to: 'revoked', reason: 'revoked' } });
      return grantView(actor, grantRow(id)!);
    }
    // An automatic grant being put in place: it can't be taken back before it is there, so it is marked and the add that is in flight
    // removes it the moment it lands. If the add finished first, the claim fails and it is removed as an active grant below.
    const marked = await claimGrant(id, 'pending', { status: 'pending', remove_reason: reason, remove_by: actor.id });
    if (marked.won) {
      recordAudit({ action: 'access.grant.revoke', actor: auditActorOf(actor), target: { type: 'access_grant', id }, project: null, summary: 'Asked to take a grant back as soon as it is in place', details: { from: 'pending', to: 'pending', reason } });
      return grantView(actor, marked.row!);
    }
    return revokeNowSettled(actor, id, reason);
  }
  if (grant.status === 'failed') {
    // The add may have worked at the system before it failed: take it back (a person who had it before is left as they were).
    const after = await removeGrant(id, reason, actor.id, Date.now(), ['failed']);
    return grantView(actor, after ?? grantRow(id)!);
  }
  return revokeNowSettled(actor, id, reason);
}

async function revokeNowSettled(actor: Actor, id: string, reason: EndReason): Promise<AccessGrantView> {
  const grant = grantRow(id)!;
  if (!['active', 'revoke_failed', 'drift'].includes(grant.status)) throw new AccessError(`This grant is ${grant.status}, so there is nothing to take back`, 409);
  const after = await removeGrant(id, reason, actor.id);
  if (!after || (after.status !== 'removing' && after.status !== 'revoked' && after.status !== 'expired' && after.status !== 'revoke_failed')) throw new AccessError('This grant changed while you asked: look again', 409);
  return grantView(actor, after);
}

/** A manual grant: pending -> active from now (the approver did it by hand), removing -> ended (they removed it). */
export async function markDone(actor: Actor, id: string): Promise<AccessGrantView> {
  const grant = visibleGrant(actor, id);
  if (grant.system !== 'manual' || !canMarkDone(actor, { holderId: grant.holder_id }, entryData(grant.entry_id))) throw new AccessError(grant.holder_id === actor.id && grant.system === 'manual' ? 'Someone else has to mark it done' : 'Access grant not found', grant.holder_id === actor.id ? 403 : 404);
  const now = Date.now();
  if (grant.status === 'pending') {
    const minutes = pendingMinutes(grant);
    const until = minutes === null ? null : iso(now + minutes * 60_000);
    const { won, row } = await claimGrant(id, 'pending', { status: 'active', since: iso(now), until, end_reason: null });
    if (!won) throw new AccessError('This grant is already settled', 409);
    recordAudit({ action: 'access.grant.activate', actor: auditActorOf(actor), target: { type: 'access_grant', id }, project: null, summary: `Marked a manual grant done (${durationText(minutes)})`, details: { from: 'pending', to: 'active', until: until ?? 'unlimited' } });
    const request = grant.request_id ? requestRow(grant.request_id) : undefined;
    if (request) void mailRequester.granted(subjectOf(request, snapshotOf(request)), until);
    return grantView(actor, row!);
  }
  if (grant.status === 'removing') {
    const reason = (grant.end_reason as EndReason) ?? 'expired';
    const request = grant.request_id ? requestRow(grant.request_id) : undefined;
    const after = await finishRemoval(grant, reason, actor.id, undefined, request ? subjectOf(request, snapshotOf(request)) : undefined, reason === 'expired' ? 'it ended' : 'taken back');
    return grantView(actor, after!);
  }
  throw new AccessError(`This grant is ${grant.status}, so there is nothing to mark done`, 409);
}

/** A failed grant: try again (an owner, an approver or an admin). A failed removal: remove again. */
export async function retryGrant(actor: Actor, id: string): Promise<AccessGrantView> {
  const grant = visibleGrant(actor, id);
  if (!canRetry(actor, { holderId: grant.holder_id }, entryData(grant.entry_id)) || !['failed', 'revoke_failed'].includes(grant.status)) {
    if (grant.holder_id === actor.id) throw new AccessError('Someone else has to retry it', 403);
    throw new AccessError(['failed', 'revoke_failed'].includes(grant.status) ? 'Access grant not found' : `This grant is ${grant.status}, so there is nothing to retry`, ['failed', 'revoke_failed'].includes(grant.status) ? 404 : 409);
  }
  if (grant.remove_reason) throw new AccessError('This grant was asked to be taken back, so it is not tried again', 409);
  if (grant.status === 'revoke_failed') {
    const reason = (grant.end_reason as EndReason) ?? 'revoked';
    const after = await removeGrant(id, ['expired', 'given_back', 'revoked'].includes(reason) ? reason : 'revoked', actor.id);
    return grantView(actor, after ?? grantRow(id)!);
  }
  const after = await activateGrant(id, pendingMinutes(grant), 'failed');
  return grantView(actor, after);
}

export type GrantScope = 'mine' | 'all';

/** `mine`: the caller's own; `all`: every grant they may see (admins: all). */
export function listGrants(actor: Actor, options: { scope: GrantScope; status?: string; limit?: number }): AccessGrantView[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.scope === 'mine') {
    where.push('holder_id = ?');
    params.push(actor.id);
  }
  if (options.status) {
    where.push('status = ?');
    params.push(options.status);
  }
  const rows = database().all<GrantRow>(`SELECT * FROM access_grants ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`, ...params, 500);
  const out: AccessGrantView[] = [];
  for (const row of rows) {
    if (options.scope === 'all' && !isInstanceAdmin(actor) && !canSeeGrant(actor, { holderId: row.holder_id }, entryData(row.entry_id))) continue;
    out.push(grantView(actor, row));
    if (out.length >= (options.limit ?? 200)) break;
  }
  return out;
}
