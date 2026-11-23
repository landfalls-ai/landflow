/**
 * Leased dynamic secrets (C30, docs/features/secrets-and-environments.md#dynamic-secrets). A `$secrets` reference to a
 * path under one of an OpenBao / Vault provider's dynamic mounts (`database/creds/report-reader`) is not read: the
 * first node of a run that needs it asks the store to issue a credential, and every later reference of the same run to
 * the same path gets that credential back (one user per run, not per node or item).
 *
 * Each issue is a row in `secret_leases`: the lease id and the issued values sealed (the values so a run resumed in
 * another process after a Wait reuses its user; both dropped when the lease ends), the run, when it was issued and when
 * it expires. The row's id is made from (run, provider, path), so two processes issuing for one run agree on a single
 * row: the second to insert revokes the credential it made and reads the first's. Leased values never enter the
 * value cache of ./service.ts and are remembered for redaction like every `$secrets` value.
 *
 * A lease ends in `revoked` (we removed it), `expired` (its time ran out first, the store removed it) or, after a
 * revoke failed for 24 hours, `revoke_failed`. A revoke that fails stays `active` and is retried with a backoff
 * (./lease-sweeper.ts); the run's end (`execution-reactions.ts`) and an admin's "Revoke now" both come through here.
 */
import { createHash } from 'node:crypto';
import { formatSecretReference } from '@landflow/engine';
import type { SecretLeaseState, SecretLeaseView } from '../../shared/secrets';
import { recordAudit } from '../audit';
import { credentials } from '../credentials/vault';
import { database, type Database } from '../db';
import { decodeCursor, encodeCursor } from '../pagination';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';
import type { SecretValue } from './providers';
import { redactText, rememberSecretValues } from './redact';
import { registerDynamicIssuer } from './resolve';
import { externalSecrets, SecretsError } from './service';

/** What a lease row binds its sealed columns to (and key rotation re-seals them under: credentials/rotate.ts). */
const VALUES_PURPOSE = 'secrets.lease';
const ID_PURPOSE = 'secrets.lease.id';

/** At most this many leases are open at once; the next node that needs one fails. */
export const MAX_ACTIVE_LEASES = 10_000;
/** A lease is renewed for at most an hour after it was issued. */
export const MAX_LEASE_MS = 3_600_000;
/** A revoke that fails this long is given up (`revoke_failed`). */
export const REVOKE_GIVE_UP_MS = 24 * 3_600_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;
/** A lease the store did not give a length for lives this long in our books. */
const FALLBACK_LEASE_SECONDS = 900;

export interface LeaseRow {
  id: string;
  execution_id: string;
  workflow_id: string | null;
  provider: string;
  path: string;
  lease_id: string | null;
  lease_values: string | null;
  state: SecretLeaseState;
  issued_at: string;
  expires_at: string;
  renewed_until: string | null;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  failing_since: string | null;
  dismissed_at: string | null;
  ended_at: string | null;
  ended_by: string | null;
}

export type LeaseEnder = 'finish' | 'sweeper' | 'admin';

const COLUMNS: Array<keyof LeaseRow> = [
  'id', 'execution_id', 'workflow_id', 'provider', 'path', 'lease_id', 'lease_values', 'state', 'issued_at', 'expires_at', 'renewed_until', 'attempts',
  'next_attempt_at', 'last_error', 'failing_since', 'dismissed_at', 'ended_at', 'ended_by',
];

const iso = (ms: number) => new Date(ms).toISOString();
const reference = (row: Pick<LeaseRow, 'provider' | 'path'>) => formatSecretReference({ provider: row.provider, name: row.path });

/** The row of a (run, provider, path): the same text always, so a second process claims the row the first made. */
export const leaseRowId = (executionId: string, provider: string, path: string) => `lease_${createHash('sha256').update(`${executionId}\u0000${provider}\u0000${path}`).digest('hex').slice(0, 32)}`;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** A row by id: this process's copy, and in Postgres mode (a copy per process) Postgres itself when the copy has none. */
async function readRow(id: string, db: Database = database()): Promise<LeaseRow | undefined> {
  const local = db.get<LeaseRow>('SELECT * FROM secret_leases WHERE id = ?', id);
  if (local || db.kind !== 'postgres') return local;
  const found = await db.direct((client) => client.query<LeaseRow>('SELECT * FROM secret_leases WHERE id = $1', [id]));
  const row = found?.rows[0];
  if (row) db.upsertLocal('secret_leases', row as unknown as Record<string, never>);
  return row;
}

/**
 * Insert a new row unless the run already has one for the path. Resolves to whether this caller won and the row that
 * stands. SQLite: one IMMEDIATE transaction decides. Postgres mode: a copy per process, so the insert is made straight
 * on Postgres (`ON CONFLICT DO NOTHING`), whose row count says who won, and the copy follows.
 */
export async function claim(row: LeaseRow, db: Database = database()): Promise<{ won: boolean; row: LeaseRow }> {
  if (db.kind !== 'postgres') {
    return db.transaction(() => {
      const existing = db.get<LeaseRow>('SELECT * FROM secret_leases WHERE id = ?', row.id);
      if (existing) return { won: false, row: existing };
      db.insertNew('secret_leases', row as unknown as Record<string, never>);
      return { won: true, row };
    });
  }
  await db.flush();
  const values = COLUMNS.map((column) => row[column] ?? null);
  const outcome = await db.direct(async (client) => {
    const inserted = await client.query(`INSERT INTO secret_leases (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map((_c, i) => `$${i + 1}`).join(', ')}) ON CONFLICT (id) DO NOTHING`, values);
    if (inserted.rowCount) return undefined;
    return (await client.query<LeaseRow>('SELECT * FROM secret_leases WHERE id = $1', [row.id])).rows[0];
  });
  const winner = outcome ?? undefined;
  db.upsertLocal('secret_leases', (winner ?? row) as unknown as Record<string, never>);
  return winner ? { won: false, row: winner } : { won: true, row };
}

const save = (row: LeaseRow) => database().upsert('secret_leases', row as unknown as Record<string, never>);

const sealedValues = (row: LeaseRow): SecretValue => {
  try {
    return JSON.parse(credentials.openSecret(row.lease_values!, VALUES_PURPOSE)) as SecretValue;
  } catch {
    throw new SecretsError(`The run’s lease for ${reference(row)} can’t be read (its key changed?)`, 500);
  }
};

const openLeaseId = (row: LeaseRow): string | undefined => {
  if (!row.lease_id) return undefined;
  try {
    return credentials.openSecret(row.lease_id, ID_PURPOSE);
  } catch {
    return undefined;
  }
};

/** What an API caller may see of a row: never the lease id or the values. */
export function leaseView(row: LeaseRow): SecretLeaseView {
  return {
    id: row.id,
    executionId: row.execution_id,
    ...(row.workflow_id && { workflowId: row.workflow_id }),
    provider: row.provider,
    path: row.path,
    state: row.state,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    ...(row.renewed_until && { renewedUntil: row.renewed_until }),
    attempts: Number(row.attempts) || 0,
    ...(row.last_error && { lastError: row.last_error }),
    ...(row.ended_at && { endedAt: row.ended_at }),
    ...(row.ended_by && { endedBy: row.ended_by }),
    ...(row.dismissed_at && { dismissed: true }),
  };
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

/** Parallel nodes of one run (and one process) wait for the one issue. */
const inflight = singleton('secret-leases-inflight', () => new Map<string, Promise<SecretValue>>());

/** The values of a lease that stands, or why the run can't have them any more. */
function reuse(row: LeaseRow, now: number): SecretValue {
  if (row.state === 'active' && Date.parse(row.expires_at) > now) return sealedValues(row);
  const why = row.state === 'active' ? 'expired' : row.state === 'revoke_failed' ? 'ended' : row.state;
  throw new SecretsError(`The run’s lease for ${reference(row)} ended (${why}) before this node asked for it: a run that waits past its lease can’t get a new user`, 409);
}

/**
 * The values of `ref` for a run: issued the first time, the same ones afterwards. Throws a SecretsError naming the
 * reference when the store refuses, when the run's lease has ended, or when too many leases are open.
 */
export function leasedSecret(ref: { provider: string; name: string }, run: { executionId: string; workflowId?: string }): Promise<SecretValue> {
  const id = leaseRowId(run.executionId, ref.provider, ref.name);
  let pending = inflight.get(id);
  if (!pending) {
    pending = obtain(id, ref, run).finally(() => inflight.delete(id));
    inflight.set(id, pending);
  }
  return pending;
}

async function obtain(id: string, ref: { provider: string; name: string }, run: { executionId: string; workflowId?: string }): Promise<SecretValue> {
  const existing = await readRow(id);
  if (existing) return reuse(existing, Date.now());
  const db = database();
  const open = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM secret_leases WHERE state = 'active'`)?.n ?? 0;
  if (Number(open) >= MAX_ACTIVE_LEASES) throw new SecretsError(`External secret ${formatSecretReference({ provider: ref.provider, name: ref.name })}: too many open leases (${MAX_ACTIVE_LEASES}); revoke some in Settings → External secrets`, 503);

  const issued = await externalSecrets.issue(ref.provider, ref.name);
  const now = Date.now();
  const row: LeaseRow = {
    id,
    execution_id: run.executionId,
    workflow_id: run.workflowId ?? null,
    provider: ref.provider,
    path: ref.name,
    lease_id: credentials.sealSecret(issued.leaseId, ID_PURPOSE),
    lease_values: credentials.sealSecret(JSON.stringify(issued.values), VALUES_PURPOSE),
    state: 'active',
    issued_at: iso(now),
    expires_at: iso(now + (issued.leaseSeconds > 0 ? issued.leaseSeconds : FALLBACK_LEASE_SECONDS) * 1000),
    renewed_until: null,
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    failing_since: null,
    dismissed_at: null,
    ended_at: null,
    ended_by: null,
  };
  // Remembered before anything can fail or return, so no value the store made can leave through a message.
  rememberSecretValues(issued.values);
  const claimed = await claim(row);
  if (!claimed.won) {
    // Another process issued for this run a moment earlier: end the credential we made and use theirs.
    await externalSecrets.revokeLease(ref.provider, issued.leaseId).catch((error: Error) => logger.warn('a duplicate lease could not be revoked; the store ends it at its TTL', { 'landflow.secrets.provider': ref.provider, error: error.message }));
    const values = reuse(claimed.row, now);
    rememberSecretValues(values);
    return values;
  }
  recordAudit({
    action: 'secrets.lease.issued',
    actor: 'system',
    target: { type: 'secret_lease', id: row.id, name: `${row.provider} ${row.path}` },
    project: null,
    summary: `Issued a leased secret from ${reference(row)} to run ${row.execution_id}`,
    details: { executionId: row.execution_id, workflowId: row.workflow_id, provider: row.provider, path: row.path, expiresAt: row.expires_at },
  });
  return issued.values;
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

/** Seconds a failed revoke waits for its next try: 30 s, then doubling, at most 30 minutes. */
export const backoffMs = (attempts: number) => Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);

const revoking = singleton('secret-leases-revoking', () => new Map<string, Promise<RevokeOutcome>>());

export type RevokeOutcome = 'revoked' | 'expired' | 'failed' | 'skipped';

/** End one lease at the store. Concurrent calls for a row (the run's end, the sweeper, an admin) share one attempt. */
export function revokeRow(row: LeaseRow, by: LeaseEnder, now = Date.now()): Promise<RevokeOutcome> {
  let pending = revoking.get(row.id);
  if (!pending) {
    pending = attemptRevoke(row.id, by, now).finally(() => revoking.delete(row.id));
    revoking.set(row.id, pending);
  }
  return pending;
}

const audit = (action: string, row: LeaseRow, by: LeaseEnder, outcome: 'success' | 'failure', details: Record<string, unknown> = {}) =>
  recordAudit({
    action,
    outcome,
    // A person's revoke is theirs (the request's actor); the rest is the system's.
    ...(by !== 'admin' && { actor: 'system' as const }),
    target: { type: 'secret_lease', id: row.id, name: `${row.provider} ${row.path}` },
    project: null,
    summary: `${action === 'secrets.lease.expired' ? 'Leased secret ran out' : action === 'secrets.lease.revoke_failed' ? 'Gave up revoking' : 'Revoked'} ${reference(row)} of run ${row.execution_id}`,
    details: { executionId: row.execution_id, workflowId: row.workflow_id, provider: row.provider, path: row.path, by, ...details },
  });

async function attemptRevoke(id: string, by: LeaseEnder, now: number): Promise<RevokeOutcome> {
  const row = await readRow(id);
  // A lease given up on is tried again only when an admin asks.
  if (!row || (row.state !== 'active' && !(row.state === 'revoke_failed' && by === 'admin'))) return 'skipped';
  const leaseId = openLeaseId(row);
  let result: 'revoked' | 'gone';
  try {
    result = leaseId ? await externalSecrets.revokeLease(row.provider, leaseId) : 'gone';
  } catch (error) {
    const attempts = (Number(row.attempts) || 0) + 1;
    const failingSince = row.failing_since ?? iso(now);
    const message = redactText((error as Error).message).slice(0, 300);
    const giveUp = row.state === 'active' && now - Date.parse(failingSince) >= REVOKE_GIVE_UP_MS;
    const next: LeaseRow = giveUp
      ? // Values are dropped; the lease id stays, so an admin can still try again once the store is back.
        { ...row, state: 'revoke_failed', lease_values: null, attempts, last_error: message, failing_since: failingSince, next_attempt_at: null, ended_at: iso(now), ended_by: by }
      : { ...row, attempts, last_error: message, failing_since: failingSince, next_attempt_at: row.state === 'active' ? iso(now + backoffMs(attempts)) : row.next_attempt_at };
    save(next);
    if (giveUp) audit('secrets.lease.revoke_failed', next, by, 'failure', { attempts, lastError: message });
    logger.warn('a leased secret could not be revoked', { 'landflow.secrets.provider': row.provider, 'landflow.execution.id': row.execution_id, attempts, give_up: giveUp });
    return 'failed';
  }
  // "No such lease" after its time ran out means the store removed it itself.
  const expired = result === 'gone' && Date.parse(row.expires_at) <= now;
  const next: LeaseRow = {
    ...row,
    state: expired ? 'expired' : 'revoked',
    lease_id: null,
    lease_values: null,
    next_attempt_at: null,
    last_error: null,
    ended_at: iso(now),
    ended_by: by,
  };
  save(next);
  audit(expired ? 'secrets.lease.expired' : 'secrets.lease.revoked', next, by, 'success', { attempts: next.attempts });
  return expired ? 'expired' : 'revoked';
}

export interface RevokeTally {
  revoked: number;
  failed: number;
}

const tally = (outcomes: RevokeOutcome[]): RevokeTally => ({ revoked: outcomes.filter((o) => o === 'revoked' || o === 'expired').length, failed: outcomes.filter((o) => o === 'failed').length });

/** End every open lease of a run (its end, an admin's "Revoke all"). An admin's call tries the given-up ones again too. */
export async function revokeRun(executionId: string, by: LeaseEnder, now = Date.now()): Promise<RevokeTally> {
  const states = by === 'admin' ? ['active', 'revoke_failed'] : ['active'];
  const rows = database().all<LeaseRow>(`SELECT * FROM secret_leases WHERE execution_id = ? AND state IN (${states.map(() => '?').join(', ')})`, executionId, ...states);
  return tally(await Promise.all(rows.map((row) => revokeRow(row, by, now))));
}

/** One lease, by an admin ("Revoke now"): the row as it stands after, and what the attempt did. A refusing store leaves it `active` with the reason. */
export async function revokeOne(id: string, by: 'admin', now = Date.now()): Promise<{ lease: SecretLeaseView; outcome: RevokeOutcome }> {
  const row = await readRow(id);
  if (!row) throw new SecretsError('Lease not found', 404);
  const outcome = await revokeRow(row, by, now);
  return { lease: leaseView((await readRow(id)) ?? row), outcome };
}

export async function revokeLease(id: string, by: 'admin', now = Date.now()): Promise<SecretLeaseView> {
  return (await revokeOne(id, by, now)).lease;
}

/** Set a `revoke_failed` lease aside: its banner goes, the row stays. */
export async function dismissLease(id: string): Promise<SecretLeaseView> {
  const row = await readRow(id);
  if (!row) throw new SecretsError('Lease not found', 404);
  if (row.state !== 'revoke_failed') throw new SecretsError('Only a lease that could not be revoked can be set aside', 409);
  const next = { ...row, dismissed_at: row.dismissed_at ?? new Date().toISOString() };
  save(next);
  recordAudit({
    action: 'secrets.lease.dismissed',
    target: { type: 'secret_lease', id: row.id, name: `${row.provider} ${row.path}` },
    project: null,
    summary: `Set aside the failed revoke of ${reference(row)}`,
    details: { executionId: row.execution_id, provider: row.provider, path: row.path },
  });
  return leaseView(next);
}

// ---------------------------------------------------------------------------
// Renew and expire (the sweeper's moves, kept with the rows they change)
// ---------------------------------------------------------------------------

/** A running run's lease about to end: extended by the provider's Lease TTL, never past an hour after it was issued. Resolves to whether it was. */
export async function renewRow(row: LeaseRow, now = Date.now()): Promise<boolean> {
  const leaseId = openLeaseId(row);
  const room = Math.floor((Date.parse(row.issued_at) + MAX_LEASE_MS - now) / 1000);
  if (!leaseId || row.state !== 'active' || room < 60) return false;
  try {
    const seconds = await externalSecrets.renewLease(row.provider, leaseId, room);
    if (seconds <= 0) return false;
    const until = iso(now + seconds * 1000);
    save({ ...row, expires_at: until, renewed_until: until, next_attempt_at: null });
    return true;
  } catch (error) {
    // Tried again on a backoff; the lease ends at its own time if the store never answers.
    const attempts = (Number(row.attempts) || 0) + 1;
    save({ ...row, attempts, last_error: redactText((error as Error).message).slice(0, 300), next_attempt_at: iso(now + backoffMs(attempts)) });
    return false;
  }
}

/** A lease whose time passed while its run still went (or waited): the store removed it itself. */
export function expireRow(row: LeaseRow, now = Date.now()): void {
  const next: LeaseRow = { ...row, state: 'expired', lease_id: null, lease_values: null, next_attempt_at: null, ended_at: iso(now), ended_by: 'sweeper' };
  save(next);
  audit('secrets.lease.expired', next, 'sweeper', 'success');
}

// ---------------------------------------------------------------------------
// Reads for the API
// ---------------------------------------------------------------------------

export interface LeaseFilter {
  state?: 'active' | 'ended' | 'revoke_failed';
  executionId?: string;
  limit?: number;
  cursor?: string;
}

/** Leases newest first, with a keyset cursor (issue time, then id). */
export function listLeases(filter: LeaseFilter = {}): { leases: SecretLeaseView[]; nextCursor?: string } {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.state === 'active') where.push(`state = 'active'`);
  else if (filter.state === 'ended') where.push(`state IN ('revoked', 'expired')`);
  else if (filter.state === 'revoke_failed') where.push(`state = 'revoke_failed'`);
  if (filter.executionId) (where.push('execution_id = ?'), params.push(filter.executionId));
  const at = filter.cursor ? decodeCursor(filter.cursor) : undefined;
  if (at) (where.push('(issued_at < ? OR (issued_at = ? AND id < ?))'), params.push(at.s, at.s, at.i));
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const rows = database().all<LeaseRow>(`SELECT * FROM secret_leases ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY issued_at DESC, id DESC LIMIT ?`, ...params, limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { leases: page.map(leaseView), ...(rows.length > limit && last && { nextCursor: encodeCursor({ s: last.issued_at, i: last.id }) }) };
}

/** Open leases, and the failed ones nobody set aside (the banner on the Leases section). */
export function leaseCounts(): { active: number; revokeFailed: number } {
  const row = database().get<{ active: number | null; failed: number | null }>(
    `SELECT SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN state = 'revoke_failed' AND dismissed_at IS NULL THEN 1 ELSE 0 END) AS failed FROM secret_leases`,
  );
  return { active: Number(row?.active) || 0, revokeFailed: Number(row?.failed) || 0 };
}

registerDynamicIssuer(leasedSecret);
