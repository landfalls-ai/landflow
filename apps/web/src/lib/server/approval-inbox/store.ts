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
  const minutes = expiryMinutes(process.env[EXPIRY_VARIABLE]);
  const fresh = new Date(now.getTime() + minutes * 60_000).toISOString();
  const ids: Record<string, string> = {};
  const created: InboxRow[] = [];
  let expiresAt = fresh;
  let kept = false;
  db().transaction(() => {
    for (const call of calls) {
      const existing = rowOfCall(call.executionId, call.callId);
      if (existing) {
        ids[call.callId] = existing.id;
        // A re-open keeps the expiry the request opened with: changing the variable never moves an open request.
        if (!kept) {
          expiresAt = existing.expires_at;
          kept = true;
        }
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
        expires_at: fresh,
        nudged: null,
        decided_by: null,
        decided_by_name: null,
        decided_via: null,
        decided_at: null,
      };
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
  const row = read(id);
  await handle.flush();
  const result = await handle.direct((client) =>
    client.query(`UPDATE approval_inbox SET status = $1, decided_by = $2, decided_by_name = $3, decided_via = $4, decided_at = $5 WHERE id = $6 AND status = 'waiting'`, [to, set.decided_by, set.decided_by_name, set.decided_via, at, id]),
  );
  if (result?.rowCount && row) {
    const next = { ...row, ...set } as InboxRow;
    handle.upsert('approval_inbox', next as unknown as Record<string, string | number | null>);
    return { won: true, row: next };
  }
  // Someone else settled it first: take their word into this main's copy.
  const theirs = await handle.direct((client) => client.query<InboxRow>('SELECT * FROM approval_inbox WHERE id = $1', [id]));
  const settled = theirs?.rows[0];
  if (settled) handle.upsert('approval_inbox', settled as unknown as Record<string, string | number | null>);
  return { won: false, row: settled ?? row };
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
  const record = executions.getExecution(row.execution_id);
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

/** Record who was nudged: counts only, never addresses. */
export function recordNudge(id: string, counts: { email: number; channels: number }): void {
  const row = rowById(id);
  if (!row) return;
  const previous = parseJson<{ email?: number; channels?: number }>(row.nudged, {});
  db().upsert('approval_inbox', { ...(row as unknown as Record<string, string | number | null>), nudged: JSON.stringify({ email: (previous.email ?? 0) + counts.email, channels: (previous.channels ?? 0) + counts.channels, at: new Date().toISOString() }) });
}

export const rowFor = rowOfCall;

/** The requests of an execution that still wait (Needs you reads these for a wait with `data.inbox`). */
export const waitingOfExecution = (executionId: string): InboxRow[] => db().all<InboxRow>("SELECT * FROM approval_inbox WHERE execution_id = ? AND status = 'waiting' ORDER BY requested_at, id", executionId);
