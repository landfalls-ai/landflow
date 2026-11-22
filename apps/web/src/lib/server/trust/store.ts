/**
 * C27: the trust store (docs/agents.md#changed-mcp-tools-are-held). A record says: this content, by hash, of this subject, was
 * approved by this person at this time. `subject_kind` is `mcp-tools` (one agent's MCP server config: `agent:<agentId>/<toolId>`)
 * or `marketplace-plugin` (`<marketplace>/<plugin>`). The newest approved record of a subject is the current one; older ones stay
 * for the audit. A pending record is a change nobody approved yet, written once per new hash.
 *
 * Every decision is audited in the same transaction with the subject, the hash and a one-line summary, never the snapshot's text
 * and never an endpoint's headers: a snapshot holds tool descriptions and schemas only.
 */
import type { JsonObject } from '@landflow/protocol';
import { auditedTransaction, recordAudit } from '../audit';
import { database, type Database } from '../db';
import type { Actor } from '../projects/access';

export type SubjectKind = 'mcp-tools' | 'marketplace-plugin';
export type TrustState = 'approved' | 'pending' | 'rejected' | 'revoked';

export interface TrustRecord {
  kind: SubjectKind;
  subjectId: string;
  hash: string;
  state: TrustState;
  snapshot?: JsonObject;
  summary?: string;
  decidedBy?: string;
  decidedAt?: string;
  firstSeenAt: string;
}

interface Row {
  subject_kind: string;
  subject_id: string;
  hash: string;
  state: string;
  snapshot: string | null;
  summary: string | null;
  decided_by: string | null;
  decided_at: string | null;
  first_seen_at: string;
}

const MAX_SUMMARY = 300;
const clip = (text: string | undefined) => (text && text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY - 1)}…` : text);
const nowIso = () => new Date().toISOString();
/** A LIKE pattern for "starts with": `%` and `_` in a subject id are escaped. */
const prefixPattern = (prefix: string) => `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function fromRow(row: Row): TrustRecord {
  return {
    kind: row.subject_kind as SubjectKind,
    subjectId: row.subject_id,
    hash: row.hash,
    state: row.state as TrustState,
    ...(row.snapshot && { snapshot: JSON.parse(row.snapshot) as JsonObject }),
    ...(row.summary && { summary: row.summary }),
    ...(row.decided_by && { decidedBy: row.decided_by }),
    ...(row.decided_at && { decidedAt: row.decided_at }),
    firstSeenAt: row.first_seen_at,
  };
}

/** The subject's newest approved record. */
export function currentApproval(kind: SubjectKind, subjectId: string, db: Database = database()): TrustRecord | undefined {
  const row = db.get<Row>(`SELECT * FROM trust_records WHERE subject_kind = ? AND subject_id = ? AND state = 'approved' ORDER BY decided_at DESC, first_seen_at DESC LIMIT 1`, kind, subjectId);
  return row && fromRow(row);
}

export function isApproved(kind: SubjectKind, subjectId: string, hash: string, db: Database = database()): boolean {
  return Boolean(db.get(`SELECT hash FROM trust_records WHERE subject_kind = ? AND subject_id = ? AND hash = ? AND state = 'approved'`, kind, subjectId, hash));
}

/** The record of one hash, in any state. */
export function recordOf(kind: SubjectKind, subjectId: string, hash: string, db: Database = database()): TrustRecord | undefined {
  const row = db.get<Row>('SELECT * FROM trust_records WHERE subject_kind = ? AND subject_id = ? AND hash = ?', kind, subjectId, hash);
  return row && fromRow(row);
}

/**
 * Note a change nobody approved. Written once per hash while it waits: a second run seeing the same change rewrites nothing. A hash whose
 * record is gone from the review (superseded when the server flapped, or an older approval the server rolled back to) is pending again with
 * a fresh first-seen time; a rejected hash stays rejected. The subject's other pending changes are superseded: one waits at a time.
 * Returns whether the record was (re)written.
 */
export function recordPending(kind: SubjectKind, subjectId: string, hash: string, snapshot: JsonObject, summary: string, db: Database = database()): boolean {
  const existing = recordOf(kind, subjectId, hash, db);
  if (existing?.state === 'pending' || existing?.state === 'rejected') return false;
  const row = { subject_kind: kind, subject_id: subjectId, hash, state: 'pending', snapshot: JSON.stringify(snapshot), summary: clip(summary) ?? null, decided_by: null, decided_at: null, first_seen_at: nowIso() };
  // An approved hash is only here when it is not the current approval (the caller compares with that), so it goes back to review.
  return db.transaction(() => {
    supersedePending(kind, subjectId, hash, db);
    if (existing) db.upsert('trust_records', row);
    else return db.insertNew('trust_records', row);
    return true;
  });
}

/** The subjects (distinct) that start with `subjectIdPrefix` and have a pending change. */
export function pendingSubjects(kind: SubjectKind, subjectIdPrefix: string, db: Database = database()): string[] {
  return db
    .all<{ subject_id: string }>(`SELECT DISTINCT subject_id FROM trust_records WHERE subject_kind = ? AND subject_id LIKE ? ESCAPE '\\' AND state = 'pending' ORDER BY subject_id`, kind, prefixPattern(subjectIdPrefix))
    .map((row) => row.subject_id);
}

/** The pending records of the subjects that start with `subjectIdPrefix`, oldest first. */
export function pendingFor(kind: SubjectKind, subjectIdPrefix: string, db: Database = database()): TrustRecord[] {
  return db
    .all<Row>(`SELECT * FROM trust_records WHERE subject_kind = ? AND subject_id LIKE ? ESCAPE '\\' AND state = 'pending' ORDER BY first_seen_at, subject_id`, kind, prefixPattern(subjectIdPrefix))
    .map(fromRow);
}

/** Approve `hash` of a subject (a new record, or a pending one): it becomes the current approval, and the subject's other pending changes are superseded. Audited as `trust.approve`. */
export function approve(actor: Pick<Actor, 'id'> | undefined, kind: SubjectKind, subjectId: string, hash: string, snapshot?: JsonObject, summary?: string, db: Database = database()): TrustRecord {
  return approveAs(actor, actor?.id, kind, subjectId, hash, snapshot, summary, db);
}

/**
 * The first view of a subject nobody snapshotted (an agent published before this existed, a server that did not answer at publish):
 * approved with no decider (`decided_by` null, the summary says why) and audited as the system, since no person decided it.
 */
export function approveFirstSeen(kind: SubjectKind, subjectId: string, hash: string, snapshot: JsonObject, summary: string, db: Database = database()): TrustRecord {
  return approveAs(undefined, undefined, kind, subjectId, hash, snapshot, summary, db);
}

function approveAs(auditActor: Pick<Actor, 'id'> | undefined, decidedBy: string | undefined, kind: SubjectKind, subjectId: string, hash: string, snapshot: JsonObject | undefined, summary: string | undefined, db: Database): TrustRecord {
  return auditedTransaction(() => {
    const existing = recordOf(kind, subjectId, hash, db);
    const at = nowIso();
    const row = {
      subject_kind: kind,
      subject_id: subjectId,
      hash,
      state: 'approved',
      snapshot: snapshot ? JSON.stringify(snapshot) : (existing?.snapshot ? JSON.stringify(existing.snapshot) : null),
      summary: clip(summary) ?? existing?.summary ?? null,
      decided_by: decidedBy ?? null,
      decided_at: at,
      first_seen_at: existing?.firstSeenAt ?? at,
    };
    db.upsert('trust_records', row);
    supersedePending(kind, subjectId, hash, db);
    recordAudit(
      { action: 'trust.approve', ...(auditActor && { actor: { id: auditActor.id } }), target: { type: kind, id: subjectId }, summary: `Approved ${kind} ${subjectId}`, details: { subject: subjectId, kind, hash, ...(row.summary && { summary: row.summary }) } },
      { required: true },
    );
    return fromRow(row);
  });
}

/** Settle the subject's pending changes other than `exceptHash`: the content they describe is gone or replaced. No audit (nobody decided). */
export function supersedePending(kind: SubjectKind, subjectId: string, exceptHash?: string, db: Database = database()): number {
  const rows = db.all<Row>(`SELECT * FROM trust_records WHERE subject_kind = ? AND subject_id = ? AND state = 'pending'`, kind, subjectId).filter((row) => row.hash !== exceptHash);
  for (const row of rows) db.upsert('trust_records', { subject_kind: row.subject_kind, subject_id: row.subject_id, hash: row.hash, state: 'revoked', decided_at: nowIso(), first_seen_at: row.first_seen_at });
  return rows.length;
}

/** Keep a pending change held: it stays out of the agent's reach and leaves the review list. Audited as `trust.reject`. */
export function reject(actor: Pick<Actor, 'id'> | undefined, kind: SubjectKind, subjectId: string, hash: string, db: Database = database()): void {
  auditedTransaction(() => {
    const existing = recordOf(kind, subjectId, hash, db);
    if (!existing || existing.state !== 'pending') return;
    db.upsert('trust_records', { subject_kind: kind, subject_id: subjectId, hash, state: 'rejected', decided_by: actor?.id ?? null, decided_at: nowIso(), first_seen_at: existing.firstSeenAt });
    recordAudit({ action: 'trust.reject', ...(actor && { actor: { id: actor.id } }), target: { type: kind, id: subjectId }, summary: `Kept ${kind} ${subjectId} held`, details: { subject: subjectId, kind, hash } }, { required: true });
  });
}

/** End every approval and pending change of the subjects that start with `subjectIdPrefix` (a deleted agent). Audited as `trust.revoke`; returns how many records changed. */
export function revokeSubject(actor: Pick<Actor, 'id'> | undefined, kind: SubjectKind, subjectIdPrefix: string, db: Database = database()): number {
  return auditedTransaction(() => {
    const rows = db.all<Row>(`SELECT * FROM trust_records WHERE subject_kind = ? AND subject_id LIKE ? ESCAPE '\\' AND state IN ('approved', 'pending')`, kind, prefixPattern(subjectIdPrefix));
    const at = nowIso();
    for (const row of rows) db.upsert('trust_records', { subject_kind: row.subject_kind, subject_id: row.subject_id, hash: row.hash, state: 'revoked', decided_by: actor?.id ?? null, decided_at: at, first_seen_at: row.first_seen_at });
    if (rows.length) recordAudit({ action: 'trust.revoke', ...(actor && { actor: { id: actor.id } }), target: { type: kind, id: subjectIdPrefix }, summary: `Revoked ${rows.length} ${kind} record${rows.length === 1 ? '' : 's'} of ${subjectIdPrefix}`, details: { subject: subjectIdPrefix, kind, records: rows.length } }, { required: true });
    return rows.length;
  });
}
