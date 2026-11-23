/** Rows as the page and the routes see them (the viewer's own `canDecide`, `canRevoke`, …). Plain server module. */
import { durationText, requestState, shorterDurations, type AccessDecision, type AccessGrantView, type AccessPerson, type AccessRequestView, type RequesterKind } from '../../shared/access';
import type { Actor } from '../projects/access';
import { entryData } from './catalog';
import { requesterOf } from './principal';
import { approversFor, canCancelRequest, canMarkDone, canRetry, canRevoke, type EntryData } from './rules';
import { grantOfRequest, parseJson, type GrantRow, type RequestRow } from './store';
import { isSystem, targetLabel } from './systems';

export const nameOf = (id: string | null | undefined): string => (id ? requesterOf(id)?.name || id : '');

/** Who a request or grant names: a user by name, an outside requester with their verified email and how it was proven (the viewer is an approver, an owner or an admin). */
export function personOf(id: string, kind: string | undefined): AccessPerson {
  const who = requesterOf(id);
  const outside = (kind as RequesterKind | undefined) === 'outside' || who?.kind === 'outside';
  return { id, name: who?.name || id, kind: outside ? 'outside' : 'user', ...(outside && who?.email && { email: who.email }), ...(outside && who?.verifiedBy && { verifiedBy: who.verifiedBy }) };
}

/** The entry as it was when asked (a request keeps the snapshot, so a later edit changes nothing in flight). */
export function snapshotOf(row: Pick<RequestRow, 'entry_snapshot'>): EntryData {
  return parseJson<EntryData>(row.entry_snapshot, undefined as never);
}

export function grantView(actor: Actor, row: GrantRow): AccessGrantView {
  const entry = entryData(row.entry_id);
  const target = parseJson<{ config?: Record<string, string>; label?: string }>(row.target, {});
  const system = isSystem(row.system) ? row.system : 'manual';
  const facts = { holderId: row.holder_id };
  const live = ['active', 'removing', 'revoke_failed', 'drift', 'pending'].includes(row.status);
  return {
    id: row.id,
    ...(row.request_id && { requestId: row.request_id }),
    entryId: row.entry_id,
    entryName: entry?.name ?? nameFromTarget(target),
    holder: personOf(row.holder_id, row.holder_kind),
    ...(row.account && { account: row.account }),
    system,
    targetLabel: target.label ?? (target.config ? targetLabel(system, target.config) : row.system),
    status: row.status,
    ...(row.since && { since: row.since }),
    ...(row.status !== 'pending' && { until: row.until }),
    ...(row.approved_by && { approvedBy: nameOf(row.approved_by) }),
    ...(row.ended_at && { endedAt: row.ended_at }),
    ...(row.end_reason && { endReason: row.end_reason }),
    ...(row.last_error && { lastError: row.last_error }),
    alreadyHad: Number(row.already_had) === 1,
    canRevoke: live && row.status !== 'removing' && canRevoke(actor, facts, entry),
    canMarkDone: (row.status === 'pending' || row.status === 'removing') && row.system === 'manual' && canMarkDone(actor, facts, entry),
    canRetry: (row.status === 'failed' || row.status === 'revoke_failed') && canRetry(actor, facts, entry),
  };
}
const nameFromTarget = (target: { label?: string }) => target.label ?? 'Deleted entry';

export function requestView(actor: Actor, row: RequestRow): AccessRequestView {
  const snapshot = snapshotOf(row);
  const approverIds = parseJson<string[]>(row.approvers, []);
  const grantRow = grantOfRequest(row.id);
  const grant = grantRow && grantView(actor, grantRow);
  const decisions = parseJson<AccessDecision[]>(row.decisions, []);
  const canDecide = row.status === 'pending' && row.requester_id !== actor.id && approverIds.includes(actor.id);
  const stored = canDecide ? parseJson<{ title?: string; text?: string } | undefined>(row.question, undefined) : undefined;
  const asked = row.duration_minutes === null ? null : Number(row.duration_minutes);
  // What the approver may allow: the asked time first, then the shorter ones the entry offered when it was asked (the server checks the answer again).
  const allowed = shorterDurations(snapshot?.durations ?? [asked], asked);
  const choices = canDecide ? (allowed.includes(asked) ? allowed : [asked, ...allowed]).map((m) => ({ value: m === null ? 'unlimited' : String(m), label: durationText(m) })) : undefined;
  return {
    id: row.id,
    entryId: row.entry_id,
    entryName: snapshot?.name ?? 'Deleted entry',
    system: snapshot?.system ?? 'manual',
    requester: personOf(row.requester_id, row.requester_kind),
    ...(row.account && { account: row.account, accountVerified: snapshot?.system === 'google-group' }),
    durationMinutes: row.duration_minutes === null ? null : Number(row.duration_minutes),
    reason: row.reason,
    channel: row.channel === 'chat' ? 'chat' : 'form',
    status: row.status,
    decisions,
    ...(row.approved_minutes !== undefined && row.approved_minutes !== null && { approvedMinutes: Number(row.approved_minutes) }),
    ...(row.status === 'approved' && row.approved_minutes === null && decisions.length && { approvedMinutes: null }),
    ...(row.note && { note: row.note }),
    ...(grant && { grant }),
    approverNames: approverIds.map(nameOf),
    canDecide,
    ...(stored?.title && stored.text && { question: { title: stored.title, text: stored.text } }),
    ...(choices && { choices }),
    canCancel: row.status === 'pending' && canCancelRequest(actor, { requesterId: row.requester_id }),
    createdAt: row.created_at,
    ...(row.execution_id && { executionId: row.execution_id }),
  };
}

export { requestState, approversFor };
