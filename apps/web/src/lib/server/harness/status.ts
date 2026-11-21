/**
 * The session status machine of the hook ingest (C04), pure. Claude Code sends each hook event on its own connection, so
 * a later event can arrive first (dot-agent-deck hit this: a late SessionStart reset a blocked card to idle). Every event
 * gets an order key; an event older than the session's last applied one is stored but never moves the status, and Error
 * and Blocked are left only by a newer prompt, tool use or session start.
 */
import type { HarnessStatus, StatusVerdict } from '@landflow/protocol/harnesses';

export const STALE_AFTER_MS = 30 * 60_000;
export const CLOSE_AFTER_MS = 24 * 3_600_000;

export interface OrderKey {
  /** `seq`: the client's `X-Landflow-Hook-Seq`; `time`: its timestamp header, else the server's receive time. */
  kind: 'seq' | 'time';
  /** `seq`: zero-padded to 20 digits so keys compare as strings; `time`: ISO. */
  value: string;
}

export const SEQ_HEADER = 'x-landflow-hook-seq';
export const TIME_HEADER = 'x-landflow-hook-time';

/** The order key of an event: the seq header, else the client's time header (ISO or epoch ms), else `receivedAt`. */
export function orderKeyOf(headers: Pick<Headers, 'get'>, receivedAt: Date): OrderKey {
  const seq = headers.get(SEQ_HEADER)?.trim();
  if (seq && /^\d{1,18}$/.test(seq)) return { kind: 'seq', value: seq.padStart(20, '0') };
  const time = headers.get(TIME_HEADER)?.trim();
  if (time) {
    const at = /^\d{10,16}$/.test(time) ? Number(time) : Date.parse(time);
    if (Number.isFinite(at)) return { kind: 'time', value: new Date(at).toISOString() };
  }
  return { kind: 'time', value: receivedAt.toISOString() };
}

/**
 * Whether an event is newer than the session's last applied one. A session's order kind is fixed by its first event; an
 * event of the other kind is never newer (it is stored and the status stays: documented limit).
 */
export function isNewer(session: { orderKind: string | null; lastOrder: string | null }, key: OrderKey): boolean {
  if (session.lastOrder === null || session.orderKind === null) return true;
  return session.orderKind === key.kind && key.value > session.lastOrder;
}

/** Events that may leave Error or Blocked (C04 FR-5), when newer. */
const LEAVES_STICKY = new Set(['UserPromptSubmit', 'PreToolUse', 'SessionStart']);

/**
 * The status after an event. `verdict` is what the registry says for the event (`undefined`: a name it does not list, which
 * changes nothing). `ended` always applies when newer: the session is over, whatever it was.
 */
export function nextStatus(current: HarnessStatus, verdict: StatusVerdict | undefined, eventName: string, newer: boolean): HarnessStatus {
  if (!newer || !verdict || verdict === 'keep') return current;
  if (verdict === 'ended') return 'ended';
  if ((current === 'error' || current === 'blocked') && !LEAVES_STICKY.has(eventName)) return current;
  return verdict;
}

/** What a viewer reads: a session that heard nothing for 30 minutes reads idle (stale), still open until 24 hours. */
export function readStatus(row: { status: HarnessStatus; lastEventAt: string; closedAt?: string | null }, now: number): { status: HarnessStatus; stale: boolean } {
  if (row.closedAt || row.status === 'ended' || row.status === 'error' || row.status === 'blocked') return { status: row.status, stale: false };
  const quiet = now - Date.parse(row.lastEventAt) >= STALE_AFTER_MS;
  return quiet ? { status: 'idle', stale: true } : { status: row.status, stale: false };
}
