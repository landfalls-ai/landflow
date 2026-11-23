/**
 * The rows of access requests (docs/access-requests.md): `access_entries`, `access_requests`, `access_grants`,
 * `access_accounts` (migration 2935), and the two claims every state change goes through.
 *
 * A claim is one conditional update, `UPDATE … WHERE id = ? AND status IN (…)`: SQLite inside its transaction, Postgres
 * through `db.direct` with this process's copy following (as the approval inbox's claim does, approval-inbox/store.ts), so
 * two processes that decide, expire or remove the same row move it once and the loser changes nothing.
 *
 * Plain server module (no Next.js import): the sweeper and the workers load it.
 */
import { database, type Database } from '../db';
import type { GrantStatus, RequestStatus } from '../../shared/access';
import { AccessError } from './errors';

export interface EntryRow {
  id: string;
  name: string;
  description: string | null;
  system: string;
  target: string;
  credential_id: string | null;
  durations: string;
  steps: string;
  owners: string;
  eligible: string | null;
  enabled: number;
  /** 1: open to outside requesters (migration 2937). */
  outside?: number;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RequestRow {
  id: string;
  entry_id: string;
  entry_version: number;
  entry_snapshot: string;
  requester_id: string;
  /** `user` or `outside` (migration 2937): which table names `requester_id`. */
  requester_kind?: string;
  account: string | null;
  duration_minutes: number | null;
  reason: string;
  channel: string;
  status: RequestStatus;
  approvers: string;
  workflow_id: string | null;
  execution_id: string | null;
  decisions: string | null;
  approved_minutes: number | null;
  note: string | null;
  /** What the server asked the approver (`{ title, text, nodes }`): Apply believes only an answer to this question. */
  question: string | null;
  created_at: string;
  updated_at: string;
}

export interface GrantRow {
  id: string;
  request_id: string | null;
  entry_id: string;
  holder_id: string;
  /** `user` or `outside` (migration 2937). */
  holder_kind?: string;
  account: string | null;
  system: string;
  target: string;
  credential_id: string | null;
  status: GrantStatus;
  since: string | null;
  until: string | null;
  approved_by: string | null;
  already_had: number;
  lease_until: string | null;
  attempts: number;
  next_attempt_at: string | null;
  ended_at: string | null;
  ended_by: string | null;
  end_reason: string | null;
  last_error: string | null;
  checked_at: string | null;
  overdue_noted: number;
  /** A revoke that came while the access was being put in place: removed the moment it is (`given_back` or `revoked`). */
  remove_reason: string | null;
  remove_by: string | null;
  /** `system|target` without the role: one live grant per target and account across entries. */
  target_key: string | null;
  created_at: string;
  updated_at: string;
}

type Row = Record<string, string | number | null>;
const asRow = (row: object) => row as Row;

export const parseJson = <T>(text: string | null | undefined, fallback: T): T => {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

// ---- entries ----------------------------------------------------------------------------------------------

export const entryRow = (id: string, handle: Database = database()): EntryRow | undefined => handle.get<EntryRow>('SELECT * FROM access_entries WHERE id = ?', id);
export const entryRows = (handle: Database = database()): EntryRow[] => handle.all<EntryRow>('SELECT * FROM access_entries ORDER BY name COLLATE NOCASE, id');
export const saveEntry = (row: EntryRow) => database().upsert('access_entries', asRow(row));
export const deleteEntry = (id: string) => database().delete('access_entries', { id });

// ---- requests ---------------------------------------------------------------------------------------------

export const requestRow = (id: string, handle: Database = database()): RequestRow | undefined => handle.get<RequestRow>('SELECT * FROM access_requests WHERE id = ?', id);
export const insertRequest = (row: RequestRow) => database().insertNew('access_requests', asRow(row));
/** Change columns of a request that is not racing anyone (the run's id after it starts, a note). Status moves go through `claimRequest`. */
export function patchRequest(id: string, patch: Partial<Omit<RequestRow, 'id' | 'status'>>): void {
  const row = requestRow(id);
  if (row) database().upsert('access_requests', asRow({ ...row, ...patch, updated_at: new Date().toISOString() }));
}

// ---- grants -----------------------------------------------------------------------------------------------

export const grantRow = (id: string, handle: Database = database()): GrantRow | undefined => handle.get<GrantRow>('SELECT * FROM access_grants WHERE id = ?', id);
export const grantOfRequest = (requestId: string, handle: Database = database()): GrantRow | undefined => handle.get<GrantRow>('SELECT * FROM access_grants WHERE request_id = ? ORDER BY created_at DESC LIMIT 1', requestId);
export const insertGrant = (row: GrantRow) => database().insertNew('access_grants', asRow(row));

// ---- accounts ---------------------------------------------------------------------------------------------

export const accountOf = (userId: string, system: string): string | undefined => database().get<{ handle: string }>('SELECT handle FROM access_accounts WHERE user_id = ? AND system = ?', userId, system)?.handle;
/** One login belongs to one person (whatever its case): the table says so too (`access_accounts_handle`). */
export function saveAccount(userId: string, system: string, handle: string): { displaced?: string } {
  const other = database().get<{ user_id: string }>('SELECT user_id FROM access_accounts WHERE system = ? AND lower(handle) = lower(?) AND user_id <> ?', system, handle, userId);
  // A login held only by someone who asked without a Landflow account (typed, never verified) is not a reason to refuse a Landflow user:
  // the user takes it, the outsider's copy is cleared (the caller audits who). Nobody else can take a Landflow user's.
  const displaces = Boolean(other?.user_id.startsWith('ext_')) && !userId.startsWith('ext_');
  if (other && !displaces) throw new AccessError('That username is already linked to someone else', 409, { field: 'account' });
  if (other) database().delete('access_accounts', { user_id: other.user_id, system });
  database().upsert('access_accounts', { user_id: userId, system, handle, updated_at: new Date().toISOString() });
  return other ? { displaced: other.user_id } : {};
}

// ---- claims -----------------------------------------------------------------------------------------------

type ClaimTable = 'access_requests' | 'access_grants';
const COLUMN = /^[a-z_]+$/;

/** Take what Postgres decided into this process's copy (read back with replication, else a copy-only write, never a queued stale row). */
async function adopt(handle: Database, table: ClaimTable, key: string, row: Row): Promise<void> {
  if (await handle.refresh(table, { id: key })) return;
  handle.upsertLocal(table, row);
}

/**
 * Move row `id` to `patch` when its `status` is one of `from`. `won` is false when it was not (then `row` is what it is now,
 * the winner's). `status` in `patch` is the move; `updated_at` is set here. `handle` is for tests (two processes' databases).
 */
async function claimRow<T extends { id: string; status: string }>(table: ClaimTable, id: string, from: readonly string[], patch: Partial<T>, handle: Database, leaseFreeAt?: string): Promise<{ won: boolean; row: T | undefined }> {
  const changes = { ...patch, updated_at: new Date().toISOString() } as Record<string, string | number | null>;
  const columns = Object.keys(changes);
  if (columns.some((column) => !COLUMN.test(column) || column === 'id')) throw new Error('A claim names only plain columns');
  const read = () => handle.get<T>(`SELECT * FROM ${table} WHERE id = ?`, id);
  if (handle.kind !== 'postgres') {
    return handle.transaction(() => {
      const row = read();
      if (!row) return { won: false, row: undefined };
      if (!from.includes(row.status)) return { won: false, row };
      const leased = (row as unknown as { lease_until?: string | null }).lease_until;
      if (leaseFreeAt && leased && leased > leaseFreeAt) return { won: false, row };
      const next = { ...row, ...changes } as T;
      handle.upsert(table, asRow(next));
      return { won: true, row: next };
    });
  }
  // A row just inserted must be in Postgres before a conditional update looks for it.
  await handle.flush();
  const set = columns.map((column, i) => `${column} = $${i + 1}`).join(', ');
  const values = columns.map((column) => changes[column]);
  const result = await handle.direct(async (client) => {
    const lease = leaseFreeAt ? ` AND (lease_until IS NULL OR lease_until <= $${columns.length + 3})` : '';
    const updated = await client.query<T>(`UPDATE ${table} SET ${set} WHERE id = $${columns.length + 1} AND status = ANY($${columns.length + 2})${lease} RETURNING *`, [...values, id, [...from], ...(leaseFreeAt ? [leaseFreeAt] : [])]);
    if (updated.rows[0]) {
      const payload = handle.keyNotice(table, [id]);
      if (payload) await client.query('SELECT pg_notify($1, $2)', ['landflow_changes', payload]);
    }
    return updated;
  });
  const won = result?.rows[0];
  if (won) {
    await adopt(handle, table, id, asRow(won));
    return { won: true, row: won };
  }
  const theirs = await handle.direct((client) => client.query<T>(`SELECT * FROM ${table} WHERE id = $1`, [id]));
  const settled = theirs?.rows[0];
  if (settled) await adopt(handle, table, id, asRow(settled));
  return { won: false, row: settled ?? read() };
}

/** Move a request from one of `from` to the status in `patch`, once. */
export function claimRequest(id: string, from: RequestStatus | readonly RequestStatus[], patch: Partial<Omit<RequestRow, 'id'>> & { status: RequestStatus }, handle: Database = database()) {
  return claimRow<RequestRow>('access_requests', id, Array.isArray(from) ? from : [from], patch, handle);
}

/**
 * Move a grant from one of `from` to the status in `patch`, once. A claim for work (removing, granting) passes `leaseMs`: the
 * row says who is working until then, so a process that stopped leaves a lease the hourly reconcile finds out.
 */
export function claimGrant(id: string, from: GrantStatus | readonly GrantStatus[], patch: Partial<Omit<GrantRow, 'id'>> & { status: GrantStatus }, options: { leaseMs?: number; now?: number; /** Only when nobody holds an unexpired lease on it. */ leaseFree?: boolean } = {}, handle: Database = database()) {
  const now = options.now ?? Date.now();
  const lease = options.leaseMs ? { lease_until: new Date(now + options.leaseMs).toISOString() } : {};
  return claimRow<GrantRow>('access_grants', id, Array.isArray(from) ? from : [from], { ...patch, ...lease }, handle, options.leaseFree ? new Date(now).toISOString() : undefined);
}

// ---- setup ------------------------------------------------------------------------------------------------

/** The settings key that names the installed flows (as the cap-raise flow's `ai_cap_raise`): only these handle requests. */
export const ACCESS_KEY = 'access_requests';

export interface AccessSettings {
  workflowId?: string;
  chatWorkflowId?: string;
  /** The project the flows live in: an entry's credential must be usable by it. */
  projectId?: string;
}

export function accessSettings(): AccessSettings {
  const raw = parseJson<Record<string, unknown>>(database().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', ACCESS_KEY)?.value, {});
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  return { ...(text(raw.workflowId) && { workflowId: text(raw.workflowId) }), ...(text(raw.chatWorkflowId) && { chatWorkflowId: text(raw.chatWorkflowId) }), ...(text(raw.projectId) && { projectId: text(raw.projectId) }) };
}

export const saveAccessSettings = (settings: AccessSettings) => database().upsert('settings', { key: ACCESS_KEY, value: JSON.stringify(settings) });
