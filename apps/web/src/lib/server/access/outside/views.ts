/**
 * What an outside requester sees (docs/access-requests.md#outside-requesters-what-they-can-ask-and-see, C36 D-13): the entries open to
 * them, their own requests and their own grants, each built key by key from the row. Nothing is spread from a full view, so a field added to
 * the Access page's views can never reach an outsider by accident: no approver or their names, owners, credential, steps, decisions' `by`,
 * execution ids, the approvers' question, or other people's rows. Plain server module; imports no catalog or rules, only the rows.
 */
import { OUTSIDE_FAILED_NOTE, requestState, type OutsideEntryView, type OutsideGrantView, type OutsideRequestView } from '../../../shared/access';
import { grantOfRequest, parseJson, type GrantRow, type RequestRow } from '../store';
import { isSystem, targetLabel } from '../systems';
import type { EntryData } from '../rules';

export function outsideEntryView(entry: EntryData): OutsideEntryView {
  return {
    id: entry.id,
    name: entry.name,
    ...(entry.description && { description: entry.description }),
    system: entry.system,
    targetLabel: entry.target.label,
    durations: entry.durations,
    needsGithub: entry.system.startsWith('github'),
  };
}

const LIVE = ['active', 'removing', 'revoke_failed', 'drift', 'pending'];

/** `entryName`: the entry's name now (it may have been renamed or deleted since); the grant keeps only the target's label. */
export function outsideGrantView(row: GrantRow, entryName?: string): OutsideGrantView {
  const target = parseJson<{ config?: Record<string, string>; label?: string }>(row.target, {});
  const system = isSystem(row.system) ? row.system : 'manual';
  return {
    id: row.id,
    ...(row.request_id && { requestId: row.request_id }),
    entryId: row.entry_id,
    entryName: entryName ?? target.label ?? 'Deleted entry',
    ...(row.account && { account: row.account }),
    system,
    targetLabel: target.label ?? (target.config ? targetLabel(system, target.config) : row.system),
    status: row.status,
    ...(row.since && { since: row.since }),
    ...(row.status !== 'pending' && { until: row.until }),
    ...(row.ended_at && { endedAt: row.ended_at }),
    ...(row.ended_at && row.end_reason && { endReason: row.end_reason }),
    canGiveBack: LIVE.includes(row.status) && row.status !== 'removing',
  };
}

export function outsideRequestView(row: RequestRow, entryName?: string): OutsideRequestView {
  const snapshot = parseJson<Partial<EntryData> | undefined>(row.entry_snapshot, undefined);
  const grantRow = grantOfRequest(row.id);
  const grant = grantRow && outsideGrantView(grantRow, entryName ?? snapshot?.name);
  const decisions = parseJson<Array<{ outcome?: string }>>(row.decisions, []);
  const system = snapshot?.system && isSystem(snapshot.system) ? snapshot.system : 'manual';
  const name = entryName ?? snapshot?.name ?? 'Deleted entry';
  return {
    id: row.id,
    entryId: row.entry_id,
    entryName: name,
    system,
    targetLabel: snapshot?.target?.label ?? name,
    state: requestState({ status: row.status, grant: grantRow ? { status: grantRow.status } : null }),
    status: row.status,
    durationMinutes: row.duration_minutes === null ? null : Number(row.duration_minutes),
    ...(row.approved_minutes !== undefined && row.approved_minutes !== null && { approvedMinutes: Number(row.approved_minutes) }),
    ...(row.status === 'approved' && row.approved_minutes === null && decisions.length && { approvedMinutes: null }),
    reason: row.reason,
    channel: row.channel === 'chat' ? 'chat' : 'form',
    ...(row.account && { account: row.account }),
    // A denial's comment is for them; a failure's reason is not (it may name an approver or quote GitHub's or Google's message).
    ...(row.status === 'failed' ? { note: OUTSIDE_FAILED_NOTE } : row.note && { note: row.note }),
    ...(grant && { grant }),
    canCancel: row.status === 'pending',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
