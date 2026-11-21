/**
 * The tickets of approval requests (C12, docs/approval-inbox.md#tickets). An alert rule with the event `approval` may name a
 * ticket channel (ServiceNow, or a webhook that opens tickets): for each waiting request it watches, one ticket is opened per
 * (request, channel) and, when the request settles in Landflow, closed with a note. The alert ticker calls `sweepTickets` (from
 * nudge.ts) on the leader; every step is a conditional move of the row (`approval_tickets`, migration 2922), so two processes in a
 * leader hand-over never open or close a ticket twice, and a row survives a restart.
 *
 * - Opening retries at 1, 5 and 15 minutes and then every 15 until the ticket opens or the request settles (then the row is
 *   `skipped`). The run never waits for any of this: a down ticket system only delays the ticket.
 * - Closing tries three times (1, then 5 minutes apart), then the row is `failed` and an audit event says so.
 * - A ticket only notifies and links. Nothing a ticket system says is read as a decision, and nothing here calls a decision door.
 *   What a ticket holds is built in nudge.ts: the subject, fixed facts and the Needs you link, never a parameter, a judge's
 *   evidence or item text, or the emailed Approve and Deny links.
 * Plain server module (no Next.js import): workers load it.
 */
import { settledLine, type InboxTicket } from '../../shared/approval-inbox';
import { opensTickets, type AlertChannel, type AlertRule } from '../../shared/alerts';
import { closeTicket, openTicket, type TicketRef, type TicketRequest } from '../alerts/tickets';
import { watches } from '../alerts/rules';
import { alertStore } from '../alerts/store';
import { recordAudit } from '../audit';
import { database, type Database } from '../db';
import { redactText } from '../secrets/redact';
import { store } from '../store';
import { logger } from '../telemetry';
import { hostMetrics } from '../telemetry/metrics';
import { serverClock, viewOf, type InboxRow } from './store';

export type TicketState = 'opening' | 'open' | 'closing' | 'closed' | 'skipped' | 'failed';

export interface TicketRow {
  request_id: string;
  channel_id: string;
  rule_id: string;
  system: 'servicenow' | 'webhook';
  state: TicketState;
  external_id: string | null;
  external_key: string | null;
  external_url: string | null;
  attempts: number;
  next_at: string | null;
  last_error: string | null;
  opened_at: string | null;
  closed_at: string | null;
  created_at: string;
}

const MIN = 60_000;
/** Minutes to wait after the Nth failed attempt to open: 1, 5, 15, then 15 for ever. */
const OPEN_DELAYS = [1, 5, 15];
/** Minutes after the Nth failed attempt to close; the third failure gives up. */
const CLOSE_DELAYS = [1, 5];
const CLOSE_ATTEMPTS = 3;

const db = (): Database => database();
const asRow = (row: TicketRow) => row as unknown as Record<string, string | number | null>;
const iso = (ms: number) => new Date(ms).toISOString();
const openDelay = (attempts: number) => (OPEN_DELAYS[attempts - 1] ?? OPEN_DELAYS.at(-1)!) * MIN;

/** The expected state (and, for a leased step, the attempt count) of a row a move may change. */
export interface TicketExpect {
  state: TicketState | readonly TicketState[];
  attempts?: number;
}

const read = (handle: Database, requestId: string, channelId: string) => handle.get<TicketRow>('SELECT * FROM approval_tickets WHERE request_id = ? AND channel_id = ?', requestId, channelId);

/**
 * Change a row only if it still is as expected, and say whether this caller won. SQLite: one IMMEDIATE transaction. Postgres: a
 * conditional UPDATE through `direct` (so two processes cannot both take a step), then this main's copy follows. `handle` is for
 * tests (two processes' databases).
 */
export async function moveTicket(requestId: string, channelId: string, expect: TicketExpect, set: Partial<TicketRow>, handle: Database = db()): Promise<TicketRow | undefined> {
  const states = Array.isArray(expect.state) ? (expect.state as readonly TicketState[]) : [expect.state as TicketState];
  if (handle.kind !== 'postgres') {
    return handle.transaction(() => {
      const row = read(handle, requestId, channelId);
      if (!row || !states.includes(row.state) || (expect.attempts !== undefined && Number(row.attempts) !== expect.attempts)) return undefined;
      const next = { ...row, ...set };
      handle.upsert('approval_tickets', asRow(next));
      return next;
    });
  }
  await handle.flush();
  const columns = Object.keys(set);
  const values: unknown[] = [requestId, channelId, states];
  let where = 'request_id = $1 AND channel_id = $2 AND state = ANY($3)';
  if (expect.attempts !== undefined) {
    values.push(expect.attempts);
    where += ` AND attempts = $${values.length}`;
  }
  const sets = columns.map((column, i) => `${column} = $${values.length + 1 + i}`).join(', ');
  const result = await handle.direct(async (client) => {
    const updated = await client.query<TicketRow>(`UPDATE approval_tickets SET ${sets} WHERE ${where} RETURNING *`, [...values, ...columns.map((column) => (set as Record<string, unknown>)[column])]);
    if (updated.rows[0]) {
      const payload = handle.keyNotice('approval_tickets', [requestId, channelId]);
      if (payload) await client.query('SELECT pg_notify($1, $2)', ['landflow_changes', payload]);
    }
    return updated;
  });
  const won = result?.rows[0];
  if (!won) return undefined;
  // This main's copy: the row as Postgres has it (read back, or copied when no other process replicates).
  if (!(await handle.refresh('approval_tickets', { request_id: requestId, channel_id: channelId }))) handle.upsertLocal('approval_tickets', asRow(won));
  return won;
}

/** What a ticket needs of a request, built in nudge.ts so that no parameter or evidence can reach it. */
export type TicketRequestOf = (row: InboxRow) => TicketRequest;

const outcome = (system: TicketRow['system'], what: 'opened' | 'open_failed' | 'closed' | 'close_failed' | 'skipped') => hostMetrics().approvalTickets.add(1, { system, outcome: what });

const audit = (action: 'approval.ticket.open' | 'approval.ticket.close' | 'approval.ticket.failed', row: TicketRow, request: InboxRow | undefined) =>
  recordAudit({
    action,
    actor: 'system',
    target: { type: 'approval', id: row.request_id, name: request?.tool },
    // Ids and counts only: never a parameter, a link or a credential.
    details: { channelId: row.channel_id, system: row.system, ...(row.external_id && { ticket: row.external_id }), ...(action === 'approval.ticket.failed' && row.last_error && { error: row.last_error.slice(0, 200) }) },
  });

const ref = (row: TicketRow): TicketRef => ({ system: row.system, id: row.external_id ?? '', key: row.external_key ?? row.external_id ?? '', ...(row.external_url && { url: row.external_url }) });

/**
 * One tick: make rows for new requests, open what is due, close what settled. `rules` are the rules that have the event
 * `approval`; `requestOf` builds what each ticket says. Never throws for one ticket's failure.
 */
export async function sweepTickets(now: number, rules: AlertRule[], channels: Map<string, AlertChannel>, requestOf: TicketRequestOf): Promise<void> {
  await createRows(now, rules, channels);
  await openDue(now, requestOf);
  await closeSettled(now);
}

async function createRows(now: number, rules: AlertRule[], channels: Map<string, AlertChannel>): Promise<void> {
  const ticketRules = rules.map((rule) => ({ rule, ids: rule.channelIds.filter((id) => channels.get(id) && opensTickets(channels.get(id)!)) })).filter((entry) => entry.ids.length);
  if (!ticketRules.length) return;
  for (const row of db().all<InboxRow>("SELECT * FROM approval_inbox WHERE status = 'waiting'")) {
    if (Date.parse(row.expires_at) <= now) continue;
    const record = await store.loadExecution(row.execution_id);
    if (!record) continue;
    for (const { rule, ids } of ticketRules) {
      if (!watches(rule, record, store.getWorkflow(row.workflow_id))) continue;
      for (const channelId of ids) {
        db().insertNew('approval_tickets', asRow({ request_id: row.id, channel_id: channelId, rule_id: rule.id, system: channels.get(channelId)!.kind === 'servicenow' ? 'servicenow' : 'webhook', state: 'opening', external_id: null, external_key: null, external_url: null, attempts: 0, next_at: iso(now), last_error: null, opened_at: null, closed_at: null, created_at: iso(now) }));
      }
    }
  }
}

async function openDue(now: number, requestOf: TicketRequestOf): Promise<void> {
  for (const row of db().all<TicketRow>("SELECT * FROM approval_tickets WHERE state = 'opening' AND next_at <= ?", iso(now))) {
    try {
      const request = db().get<InboxRow>('SELECT * FROM approval_inbox WHERE id = ?', row.request_id);
      const channel = alertStore.channelForSending(row.channel_id);
      if (!request || request.status !== 'waiting' || !channel) {
        // The request settled before the ticket opened (or the channel is gone): nothing to open and nothing to say.
        if (await moveTicket(row.request_id, row.channel_id, { state: 'opening', attempts: Number(row.attempts) }, { state: 'skipped', next_at: null })) outcome(row.system, 'skipped');
        continue;
      }
      // Take this attempt first (a conditional step on the attempt count): the next attempt is already scheduled if this process dies.
      const attempts = Number(row.attempts) + 1;
      const leased = await moveTicket(row.request_id, row.channel_id, { state: 'opening', attempts: Number(row.attempts) }, { attempts, next_at: iso(now + openDelay(attempts)) });
      if (!leased) continue;
      try {
        const ticket = await openTicket(channel, requestOf(request));
        const opened = await moveTicket(row.request_id, row.channel_id, { state: 'opening', attempts }, { state: 'open', attempts: 0, next_at: null, last_error: null, external_id: ticket.id, external_key: ticket.key, external_url: ticket.url ?? null, opened_at: iso(now) });
        if (opened) {
          outcome(row.system, 'opened');
          audit('approval.ticket.open', opened, request);
        }
      } catch (error) {
        await moveTicket(row.request_id, row.channel_id, { state: 'opening', attempts }, { last_error: redactText((error as Error).message).slice(0, 200) });
        outcome(row.system, 'open_failed');
        logger.warn('approval ticket not opened', { 'landflow.approval.request': row.request_id, 'landflow.alert.channel': row.channel_id, error: (error as Error).message });
      }
    } catch (error) {
      logger.warn('approval ticket step failed', { 'landflow.approval.request': row.request_id, error: (error as Error).message });
    }
  }
}

async function closeSettled(now: number): Promise<void> {
  const due = db().all<TicketRow>("SELECT * FROM approval_tickets WHERE state = 'open' OR (state = 'closing' AND next_at <= ?)", iso(now));
  for (const row of due) {
    try {
      const request = db().get<InboxRow>('SELECT * FROM approval_inbox WHERE id = ?', row.request_id);
      if (request?.status === 'waiting') continue;
      const channel = alertStore.channelForSending(row.channel_id);
      const attempts = Number(row.attempts) + 1;
      const leased = await moveTicket(row.request_id, row.channel_id, { state: row.state, attempts: Number(row.attempts) }, { state: 'closing', attempts, next_at: iso(now + (CLOSE_DELAYS[attempts - 1] ?? CLOSE_DELAYS.at(-1)!) * MIN) });
      if (!leased) continue;
      try {
        if (!channel) throw new Error('The alert channel was deleted');
        // A request row that is gone counts as cancelled.
        const status = request?.status ?? 'cancelled';
        const line = request ? settledLine(viewOf(request), serverClock) : 'Cancelled: the request no longer exists';
        await closeTicket(channel, ref(row), { requestId: row.request_id, status, line });
        const closed = await moveTicket(row.request_id, row.channel_id, { state: 'closing', attempts }, { state: 'closed', next_at: null, last_error: null, closed_at: iso(now) });
        if (closed) {
          outcome(row.system, 'closed');
          audit('approval.ticket.close', closed, request);
        }
      } catch (error) {
        const last_error = redactText((error as Error).message).slice(0, 200);
        const gaveUp = attempts >= CLOSE_ATTEMPTS;
        const next = await moveTicket(row.request_id, row.channel_id, { state: 'closing', attempts }, { last_error, ...(gaveUp && { state: 'failed' as const, next_at: null }) });
        outcome(row.system, 'close_failed');
        if (gaveUp && next) audit('approval.ticket.failed', next, request);
        logger.warn('approval ticket not closed', { 'landflow.approval.request': row.request_id, 'landflow.alert.channel': row.channel_id, error: last_error });
      }
    } catch (error) {
      logger.warn('approval ticket step failed', { 'landflow.approval.request': row.request_id, error: (error as Error).message });
    }
  }
}

/** The tickets of a request as people see them: skipped ones are not shown, a close that failed still shows the open ticket. */
export function ticketsOf(requestId: string): InboxTicket[] {
  return db()
    .all<TicketRow>("SELECT * FROM approval_tickets WHERE request_id = ? AND state <> 'skipped' ORDER BY created_at, channel_id", requestId)
    .map((row): InboxTicket => {
      const shown: InboxTicket['state'] = row.state === 'opening' ? 'opening' : row.state === 'closed' ? 'closed' : row.external_id ? 'open' : 'failed';
      return { system: row.system, channel: row.channel_id, ...(shown !== 'opening' && row.external_id && { id: row.external_id }), ...(shown !== 'opening' && row.external_url && { url: row.external_url }), state: shown };
    });
}
