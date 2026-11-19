/**
 * The approval inbox's record (table `approval_inbox`, migration 2907; docs/approval-inbox.md): one row per waiting tool call of
 * a run nobody watches. Whoever moves a row from `waiting` first wins: `claim` is one conditional update (SQLite: inside the
 * IMMEDIATE transaction; Postgres: `UPDATE … WHERE id = $n AND status = 'waiting'` through `db.direct`, then this main's copy, as
 * lib/server/mcp/approvals.ts does), so a call runs at most once and an expiry or a cancel can never be overtaken.
 *
 * Plain server module (no Next.js import): workers load it. Rows are kept for the audit of who decided; a deleted workflow keeps
 * its rows (only instance owners and admins read them then) and a transferred one is read through its new project, because
 * visibility is worked out from `workflow_id` at request time.
 */
import { randomUUID } from 'node:crypto';
import { closedAnswer, EXPIRY_VARIABLE, expiryMinutes, maskParams, type InboxOpen, type InboxRequestView, type InboxStatus, type InboxVia } from '../../shared/approval-inbox';
import { database, type Database } from '../db';
import { envString } from '../config';
import { logger } from '../telemetry/logger';
import { redactValue } from '../secrets/redact';
import { store as executions } from '../store';
import type { InboxOutcome } from './port';

export interface InboxRow {
  id: string;
  execution_id: string;
  call_id: string;
  workflow_id: string;
  workflow_name: string;
  workflow_version: number | null;
  node_id: string;
  node_name: string;
  agent_id: string;
  agent_name: string;
  agent_version: string | null;
  session_id: string;
  project_id: string | null;
  tool: string;
  params: string;
  destination: string | null;
  trigger_word: string;
  status: InboxStatus;
  requested_at: string;
  expires_at: string;
  nudged: string | null;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_via: InboxVia | null;
  decided_at: string | null;
}

const db = (): Database => database();
const SETTLED: readonly InboxStatus[] = ['approved', 'denied', 'expired', 'cancelled'];

const rowById = (id: string) => db().get<InboxRow>('SELECT * FROM approval_inbox WHERE id = ?', id);
const rowOfCall = (executionId: string, callId: string) => db().get<InboxRow>('SELECT * FROM approval_inbox WHERE execution_id = ? AND call_id = ?', executionId, callId);

/** The record of one request (undefined when it does not exist). */
export const requestRow = rowById;

/** A short clock for the messages the routes and the links answer (UTC: a server has no viewer's zone). */
export const serverClock = (iso: string): string => iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

/** "2026-11-19 14:12 UTC": the clock of a message that has no viewer. */
export const expiryClock = serverClock;

const parseJson = <T>(text: string | null | undefined, fallback: T): T => {
  try {
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
};

/** Open one request per call, once per (execution, call). `new` says which calls got a row now (only those are nudged). */
export function openRequests(calls: InboxOpen[], now = new Date()): { ids: Record<string, string>; expiresAt: string; minutes: number; created: InboxRow[] } {
  const minutes = expiryMinutes(envString(EXPIRY_VARIABLE));
  const fresh = new Date(now.getTime() + minutes * 60_000).toISOString();
  const ids: Record<string, string> = {};
  const created: InboxRow[] = [];
  let expiresAt = fresh;
  let kept = false;
  db().transaction(() => {
    // The kept expiry first: a new row in a batch that mixes it with an existing call shares the wait's `until`.
    for (const call of calls) {
      const existing = rowOfCall(call.executionId, call.callId);
      if (existing) {
        expiresAt = existing.expires_at;
        kept = true;
        break;
      }
    }
    for (const call of calls) {
      const existing = rowOfCall(call.executionId, call.callId);
      if (existing) {
        ids[call.callId] = existing.id;
        // A re-open keeps the expiry the request opened with: changing the variable never moves an open request.
        continue;
      }
      // The host's redaction (a `$secrets` value) first, then the mask (a key that names a secret): the row never holds either.
      const params = maskParams(redactValue(call.params ?? {}));
      const row: InboxRow = {
        id: randomUUID(),
        execution_id: call.executionId,
        call_id: call.callId,
        workflow_id: call.workflowId,
        workflow_name: call.workflowName,
        workflow_version: call.workflowVersion ?? null,
        node_id: call.nodeId,
        node_name: call.nodeName,
        agent_id: call.agentId,
        agent_name: call.agentName,
        agent_version: call.agentVersion === undefined ? null : String(call.agentVersion),
        session_id: call.sessionId,
        project_id: call.projectId ?? null,
        tool: call.tool,
        params: JSON.stringify(params),
        destination: call.destination ? String(redactValue(call.destination)) : null,
        trigger_word: call.trigger,
        status: 'waiting',
        requested_at: now.toISOString(),
        expires_at: expiresAt,
        nudged: null,
        decided_by: null,
        decided_by_name: null,
        decided_via: null,
        decided_at: null,
      };
      // Postgres mode: the replayed insert is `ON CONFLICT (id) DO NOTHING`, while the table is also UNIQUE (execution_id, call_id).
      // Two processes opening the same call before replication catches up would make the later batch a unique violation, not a
      // no-op. A call opens on the one process that runs it and a re-open comes much later, so this is accepted.
      if (db().insertNew('approval_inbox', row as unknown as Record<string, string | number | null>)) {
        ids[call.callId] = row.id;
        created.push(row);
      } else {
        // Another process inserted it between our read and write: it is theirs to nudge.
        const raced = rowOfCall(call.executionId, call.callId);
        if (raced) ids[call.callId] = raced.id;
      }
    }
  });
  return { ids, expiresAt, minutes, created };
}

/** Who settles a row, and where the word came from. */
export interface ClaimBy {
  by?: string;
  byName?: string;
  via?: InboxVia;
  at?: string;
}

const asRow = (row: InboxRow) => row as unknown as Record<string, string | number | null>;

/**
 * Take what Postgres decided into this process's copy without replaying a stale row: a replayed full row (`INSERT ... ON CONFLICT DO
 * UPDATE` of every column) could, when it reaches Postgres late, write an older status or nudge count over a newer one.
 * With replication the copy is read back (`refresh`) and the others are told by a key notice sent from the same connection
 * (`tell`, run inside `direct`). With one process and Postgres there is no other writer but two async tasks of this one can
 * finish out of order (a nudge's read, a claim's), so the copy takes only the columns that task changed (`status`: the decision,
 * `nudged`: the counts) onto the copy as it is at that moment, in one synchronous step: the row that is replayed always holds
 * both. SQLite and a missing copy write the row as given.
 */
async function adopt(handle: Database, row: InboxRow, columns: 'status' | 'nudged'): Promise<void> {
  if (await handle.refresh('approval_inbox', { id: row.id })) return;
  const local = handle.get<InboxRow>('SELECT * FROM approval_inbox WHERE id = ?', row.id);
  if (!local || handle.kind !== 'postgres') return void handle.upsert('approval_inbox', asRow(row));
  const taken = columns === 'status' ? { status: row.status, decided_by: row.decided_by, decided_by_name: row.decided_by_name, decided_via: row.decided_via, decided_at: row.decided_at } : { nudged: row.nudged };
  handle.upsert('approval_inbox', { ...asRow(local), ...taken });
}

/** Send the key notice for a row changed through `direct` (a no-op without replication). */
async function tell(handle: Database, client: { query(text: string, values?: unknown[]): Promise<unknown> }, id: string): Promise<void> {
  const payload = handle.keyNotice('approval_inbox', [id]);
  if (payload) await client.query('SELECT pg_notify($1, $2)', ['landflow_changes', payload]);
}

/**
 * Move a waiting request to `to`, once. `won` is false when it was no longer waiting (then `row` is the winner's). In Postgres
 * mode the conditional write is made there and this main's copy follows. `handle` is for tests (two processes' databases).
 */
export async function claim(id: string, to: Exclude<InboxStatus, 'waiting'>, who: ClaimBy = {}, handle: Database = db()): Promise<{ won: boolean; row: InboxRow | undefined }> {
  const at = who.at ?? new Date().toISOString();
  const set = { status: to, decided_by: who.by ?? null, decided_by_name: who.byName ?? null, decided_via: who.via ?? null, decided_at: at };
  const read = (key: string) => handle.get<InboxRow>('SELECT * FROM approval_inbox WHERE id = ?', key);
  if (handle.kind !== 'postgres') {
    return handle.transaction(() => {
      const row = read(id);
      if (!row) return { won: false, row: undefined };
      if (row.status !== 'waiting') return { won: false, row };
      const next = { ...row, ...set };
      handle.upsert('approval_inbox', next as unknown as Record<string, string | number | null>);
      return { won: true, row: next as InboxRow };
    });
  }
  await handle.flush();
  const result = await handle.direct(async (client) => {
    const updated = await client.query<InboxRow>(`UPDATE approval_inbox SET status = $1, decided_by = $2, decided_by_name = $3, decided_via = $4, decided_at = $5 WHERE id = $6 AND status = 'waiting' RETURNING *`, [to, set.decided_by, set.decided_by_name, set.decided_via, at, id]);
    if (updated.rows[0]) await tell(handle, client, id);
    return updated;
  });
  // The winner's row comes from Postgres (a stale copy, or none yet, must not decide who won or carry old `nudged` counts).
  const won = result?.rows[0];
  if (won) {
    await adopt(handle, won, 'status');
    return { won: true, row: won };
  }
  // Someone else settled it first: take their word into this main's copy.
  const theirs = await handle.direct((client) => client.query<InboxRow>('SELECT * FROM approval_inbox WHERE id = $1', [id]));
  const settled = theirs?.rows[0];
  if (settled) await adopt(handle, settled, 'status');
  return { won: false, row: settled ?? read(id) };
}

/** The record's state for one call of an execution. */
export function outcome(executionId: string, callId: string): InboxOutcome | undefined {
  const row = rowOfCall(executionId, callId);
  return row && outcomeOf(row);
}

export function outcomeOf(row: InboxRow): InboxOutcome {
  return {
    status: row.status,
    ...(row.decided_by && { by: row.decided_by }),
    ...(row.decided_by_name && { byName: row.decided_by_name }),
    ...(row.decided_via && { via: row.decided_via }),
    ...(row.decided_at && { at: row.decided_at }),
  };
}

/** The closed answer for a row that is not waiting (409 already decided, 410 expired, 409 cancelled). */
export function closedOf(row: InboxRow): { status: 409 | 410; message: string } {
  return closedAnswer(
    { status: row.status, tool: row.tool, decidedByName: row.decided_by_name ?? undefined, decidedBy: row.decided_by ?? undefined, decidedAt: row.decided_at ?? undefined, expiresAt: row.expires_at },
    serverClock,
  );
}

/** The request as the routes show it (`mayDecide`: access.ts works it out for the viewer). Nothing secret: `params` was masked when it was written and is masked again here. */
export function viewOf(row: InboxRow, mayDecide = false): InboxRequestView {
  const nudged = parseJson<{ email?: number; channels?: number } | undefined>(row.nudged, undefined);
  const version = row.agent_version === null ? undefined : row.agent_version === 'draft' ? 'draft' : Number(row.agent_version);
  return {
    id: row.id,
    status: row.status,
    executionId: row.execution_id,
    callId: row.call_id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    ...(row.workflow_version !== null && row.workflow_version !== undefined && { workflowVersion: Number(row.workflow_version) }),
    nodeId: row.node_id,
    nodeName: row.node_name,
    agentId: row.agent_id,
    agentName: row.agent_name,
    ...(version !== undefined && { agentVersion: version as number | 'draft' }),
    tool: row.tool,
    params: maskParams(parseJson<Record<string, unknown>>(row.params, {})),
    ...(row.destination && { destination: row.destination }),
    trigger: row.trigger_word,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    ...(row.decided_by && { decidedBy: row.decided_by }),
    ...(row.decided_by_name && { decidedByName: row.decided_by_name }),
    ...(row.decided_via && { decidedVia: row.decided_via }),
    ...(row.decided_at && { decidedAt: row.decided_at }),
    ...(nudged && { nudged: { email: Number(nudged.email ?? 0), channels: Number(nudged.channels ?? 0) } }),
    canDecide: mayDecide,
  };
}

/**
 * A `waiting` row whose run can no longer be waiting on it (the run is gone, cancelled, failed, finished, or waits on something
 * else) is `cancelled`: the lazy twin of the bus subscription, for a run another process cancelled or a crash. A run still
 * running (it is on its way into waiting) leaves its rows alone. Returns the row as it is now.
 */
export async function reconcile(row: InboxRow): Promise<InboxRow> {
  if (row.status !== 'waiting') return row;
  const record = await executions.loadExecution(row.execution_id);
  let gone = !record || record.status === 'canceled' || record.status === 'error' || record.status === 'success';
  if (record?.status === 'waiting') {
    const ids = (record.wait?.data?.inbox as { ids?: Record<string, string> } | undefined)?.ids;
    gone = Boolean(ids) && !Object.values(ids ?? {}).includes(row.id);
  }
  if (!gone) return row;
  const result = await claim(row.id, 'cancelled', { via: 'cancel' });
  return result.row ?? row;
}

/** A waiting row of this execution's, settled `cancelled` (the bus: a run cancelled while it waited). */
export async function cancelExecution(executionId: string): Promise<number> {
  let n = 0;
  for (const row of db().all<InboxRow>("SELECT * FROM approval_inbox WHERE execution_id = ? AND status = 'waiting'", executionId)) {
    if ((await claim(row.id, 'cancelled', { via: 'cancel' })).won) n++;
  }
  return n;
}

export const isSettled = (status: InboxStatus) => SETTLED.includes(status);

/**
 * Record who was nudged: counts only, never addresses. Only `nudged` is written, never the status columns: a nudge from a
 * stale copy must not undo a claim another process made meanwhile (SQLite: read and write in one transaction; Postgres: a
 * conditional UPDATE of the column, retried when another nudge got in between, and this main's copy follows the row read back).
 */
export async function recordNudge(id: string, counts: { email: number; channels: number }, handle: Database = db()): Promise<void> {
  const next = (text: string | null) => {
    const previous = parseJson<{ email?: number; channels?: number }>(text, {});
    return JSON.stringify({ email: (previous.email ?? 0) + counts.email, channels: (previous.channels ?? 0) + counts.channels, at: new Date().toISOString() });
  };
  if (handle.kind !== 'postgres') {
    handle.transaction(() => {
      const row = handle.get<InboxRow>('SELECT * FROM approval_inbox WHERE id = ?', id);
      if (row) handle.upsert('approval_inbox', { ...(row as unknown as Record<string, string | number | null>), nudged: next(row.nudged) });
    });
    return;
  }
  await handle.flush();
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await handle.direct((client) => client.query<InboxRow>('SELECT * FROM approval_inbox WHERE id = $1', [id]));
    const row = current?.rows[0];
    if (!row) return;
    const updated = await handle.direct(async (client) => {
      const result = await client.query<InboxRow>('UPDATE approval_inbox SET nudged = $1 WHERE id = $2 AND nudged IS NOT DISTINCT FROM $3 RETURNING *', [next(row.nudged), id, row.nudged]);
      if (result.rows[0]) await tell(handle, client, id);
      return result;
    });
    const fresh = updated?.rows[0];
    if (fresh) {
      await adopt(handle, fresh, 'nudged');
      return;
    }
  }
  logger.warn('approval inbox: a nudge count was not recorded (the row kept changing)', { 'landflow.approval_inbox.id': id });
}

export const rowFor = rowOfCall;

/** The requests of an execution that still wait (Needs you reads these for a wait with `data.inbox`). */
export const waitingOfExecution = (executionId: string): InboxRow[] => db().all<InboxRow>("SELECT * FROM approval_inbox WHERE execution_id = ? AND status = 'waiting' ORDER BY requested_at, id", executionId);
