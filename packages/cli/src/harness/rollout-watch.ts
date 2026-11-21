/**
 * The Codex rollout watch (C05 FR-5, FR-6): `landflow harness watch codex` reads the rollout files (JSONL) of the Codex sessions
 * the person started under the watch, and reports one thing: that a provider limit stopped a turn. Codex runs no hook when a turn
 * dies on quota, so the rollout file is the only place the stop shows (a `task_complete` that carries
 * `codex_error_info: "usage_limit_exceeded"`).
 *
 * What it reads and sends is bounded on purpose. Only files created after the watch began are read (never an older session, never a
 * file it was not pointed at by Codex's own folder). The first read starts at most `firstReadBytes` before the end, later ticks read
 * at most `maxReadBytes`. What leaves the machine is one `quota_blocked` event per stopped turn: the session id, the kind of limit
 * and the provider's error message, never a prompt, a tool's output or a path. A turn is never timed out while Codex runs; it
 * ends on its `task_complete` (with or without an error), a `turn_aborted`, a newer turn, or the file being removed or replaced.
 *
 * Imports the protocol's classifier only (`@landflow/protocol/quota-block`), as the CLI may not import `apps/`.
 */
import { open, readdir, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyRecord, type BlockedKind } from '@landflow/protocol/quota-block';

/** The one event the watch sends: the Codex entry of the harness registry accepts this and nothing else. */
export interface QuotaBlockedEvent {
  hook_event_name: 'quota_blocked';
  session_id: string;
  kind: BlockedKind;
  message: string;
}

export interface RolloutWatchOptions {
  /** Codex's sessions folder (`$CODEX_HOME/sessions`). */
  dir: string;
  /** Epoch ms: only files created after it are read. */
  since: number;
  /** Delivers an event; a rejection is retried on a later tick (up to `RETRIES` times). */
  post: (event: QuotaBlockedEvent) => Promise<void>;
  /** Poll interval in ms (default 2000); 0 means no timer: the caller calls `tick()`. */
  tickMs?: number;
  /** The first read of a file starts this far before its end (default 64 KB). */
  firstReadBytes?: number;
  /** A tick reads at most this much of a file (default 256 KB). */
  maxReadBytes?: number;
  /** Told about an event that could not be delivered after its retries. */
  onGiveUp?: (error: unknown) => void;
}

export interface RolloutWatch {
  /** One poll: find new files, read what is new, deliver what was found. */
  tick(): Promise<void>;
  /** A last read of every open file (what Codex wrote before it exited), then closes them all. */
  stop(): Promise<void>;
  /** The number of events delivered so far. */
  readonly delivered: number;
  /** The files currently open (for tests and the status line). */
  readonly open: number;
}

export const FIRST_READ_BYTES = 64 * 1024;
export const MAX_READ_BYTES = 256 * 1024;
const TICK_MS = 2_000;
const RETRIES = 5;
/** A watch holds at most this many files open; a finished one is closed first. */
const MAX_OPEN = 50;
/** A folder dated further back than this before `since` cannot hold a file created after it (Codex names folders by date; slack for time zones). */
const DATE_SLACK_MS = 36 * 3_600_000;
const ROLLOUT = /^rollout-.*\.jsonl$/;
const SESSION_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

interface Tracked {
  path: string;
  handle: FileHandle;
  ino: number | bigint;
  /** Where the next read starts. */
  pos: number;
  /** The text after the last newline, waiting for its end. */
  partial: string;
  /** The first read may start in the middle of a line: drop up to its first newline. */
  skipFirstLine: boolean;
  sessionId: string;
  rateLimitType?: string;
  /** The current turn has ended or been reported: nothing more is read from it until a newer turn starts. */
  turnOver: boolean;
  closed: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The record's type and its payload's type: `event_msg` / `task_complete`, `turn_context` / undefined. */
function kindOf(record: Record<string, unknown>): { type: string; inner: string } {
  const payload = isObject(record.payload) ? record.payload : {};
  return { type: typeof record.type === 'string' ? record.type : '', inner: typeof payload.type === 'string' ? payload.type : '' };
}

/** A record that starts a new turn: the turn's own context, its start, or the person's message. */
function startsTurn({ type, inner }: { type: string; inner: string }): boolean {
  return type === 'turn_context' || (type === 'event_msg' && (inner === 'task_started' || inner === 'user_message'));
}

/** Whether a folder of the date layout (`YYYY/MM/DD`) is too old to hold a file created after `since`. */
function tooOld(parts: string[], since: number): boolean {
  const [year, month, day] = parts.map(Number);
  if (!Number.isFinite(year)) return false;
  const end = day ? Date.UTC(year, (month ?? 1) - 1, day + 1) : month ? Date.UTC(year, month, 1) : Date.UTC(year + 1, 0, 1);
  return end < since - DATE_SLACK_MS;
}

async function* rolloutFiles(root: string, since: number, parts: string[] = []): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(join(root, ...parts), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && parts.length < 3 && /^\d+$/.test(entry.name) && !tooOld([...parts, entry.name], since)) yield* rolloutFiles(root, since, [...parts, entry.name]);
    else if (entry.isFile() && ROLLOUT.test(entry.name)) yield join(root, ...parts, entry.name);
  }
}

/** When the file was created: its birth time where the filesystem keeps one, else the last change (a file only counts if it began after `since`). */
const createdAt = (s: { birthtimeMs: number; ctimeMs: number }) => (s.birthtimeMs > 0 ? s.birthtimeMs : s.ctimeMs);

export function watchRollouts(options: RolloutWatchOptions): RolloutWatch {
  const first = options.firstReadBytes ?? FIRST_READ_BYTES;
  const most = options.maxReadBytes ?? MAX_READ_BYTES;
  const tracked = new Map<string, Tracked>();
  /** Every path ever opened: a file replaced at the same path is not read again (AS-6). */
  const seen = new Set<string>();
  const queue: Array<{ event: QuotaBlockedEvent; tries: number }> = [];
  let delivered = 0;
  let stopped = false;
  let busy: Promise<void> = Promise.resolve();

  const close = async (file: Tracked) => {
    if (file.closed) return;
    file.closed = true;
    tracked.delete(file.path);
    await file.handle.close().catch(() => {});
  };

  /** Find files created since the watch began that it does not hold yet. */
  /** Make room for a new file: close the ones whose turn is over (idle) first; false when every open file is mid-turn. */
  async function room(): Promise<boolean> {
    if (tracked.size < MAX_OPEN) return true;
    for (const file of [...tracked.values()]) {
      if (file.turnOver) await close(file);
      if (tracked.size < MAX_OPEN) return true;
    }
    return false;
  }

  async function discover() {
    if (!(await room())) return;
    for await (const path of rolloutFiles(options.dir, options.since)) {
      if (seen.has(path)) continue;
      let info;
      try {
        info = await stat(path);
      } catch {
        continue;
      }
      if (createdAt(info) < options.since) {
        // Created before the watch: never read, and never looked at again.
        seen.add(path);
        continue;
      }
      seen.add(path);
      let handle: FileHandle;
      try {
        handle = await open(path, 'r');
      } catch {
        continue;
      }
      // The path may have been swapped between the stat and the open: only the file that was checked is read.
      if ((await handle.stat().catch(() => undefined))?.ino !== info.ino) {
        await handle.close().catch(() => {});
        continue;
      }
      // Without a birth time (Linux often has none) the change time stood in for it, and a session resumed after the watch began
      // looks new: its old content is not read at all, only what is written from now on.
      const start = info.birthtimeMs > 0 ? Math.max(0, info.size - first) : info.size;
      tracked.set(path, { path, handle, ino: info.ino, pos: start, partial: '', skipFirstLine: start > 0, sessionId: SESSION_ID.exec(path)?.[1] ?? '', turnOver: false, closed: false });
      if (!(await room())) return;
    }
  }

  /** Read what is new in one file (at most `most` bytes), and say whether the file is gone or replaced. */
  async function read(file: Tracked): Promise<void> {
    let current: { ino: number | bigint; size: number } | undefined;
    try {
      current = await stat(file.path);
    } catch {
      current = undefined; // removed
    }
    const replaced = !current || current.ino !== file.ino;
    // An open handle still reads the old file after it is removed or replaced: read what it held, then close.
    const size = replaced ? (await file.handle.stat().catch(() => undefined))?.size ?? file.pos : (current as { size: number }).size;
    // The file shrank (truncated in place): start again from its new end.
    if (size < file.pos) file.pos = Math.max(0, size - first);
    const want = Math.min(most, size - file.pos);
    if (want > 0) {
      const buffer = Buffer.alloc(want);
      const { bytesRead } = await file.handle.read(buffer, 0, want, file.pos);
      file.pos += bytesRead;
      consume(file, buffer.subarray(0, bytesRead).toString('utf8'));
    }
    if (replaced && file.pos >= size) await close(file);
  }

  function consume(file: Tracked, text: string) {
    let buffer = file.partial + text;
    if (file.skipFirstLine) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) {
        file.partial = buffer.length > most ? '' : buffer;
        return;
      }
      buffer = buffer.slice(newline + 1);
      file.skipFirstLine = false;
    }
    const lines = buffer.split('\n');
    file.partial = lines.pop() ?? '';
    // A line with no end that is longer than any record Codex writes is not waited for.
    if (file.partial.length > most) file.partial = '';
    for (const line of lines) if (line.trim()) handle(file, line);
  }

  function handle(file: Tracked, line: string) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObject(record)) return;
    const kind = kindOf(record);
    const payload = isObject(record.payload) ? record.payload : {};
    if (kind.type === 'session_meta' && typeof payload.id === 'string' && payload.id.length <= 200) file.sessionId = payload.id;
    if (startsTurn(kind)) file.turnOver = false;
    // The limit type the last token_count named: it says whether credits ran out when the turn's error arrives.
    if (kind.type === 'event_msg' && kind.inner === 'token_count') {
      const limits = isObject(payload.rate_limits) ? payload.rate_limits : undefined;
      const named = typeof limits?.rate_limit_reached_type === 'string' ? limits.rate_limit_reached_type : undefined;
      if (named) file.rateLimitType = named;
    }
    // A record stamped before the watch began is history (a resumed session): never classified, so an old limit is not sent again.
    const stamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN;
    if (Number.isFinite(stamp) && stamp < options.since) return;
    if (file.turnOver) return;
    const verdict = classifyRecord(record, { ...(file.rateLimitType && { rateLimitType: file.rateLimitType }) });
    if (verdict.blocked) {
      // Without a session id there is nothing to bind the event to: the file name carries Codex's own.
      if (file.sessionId) queue.push({ event: { hook_event_name: 'quota_blocked', session_id: file.sessionId, kind: verdict.kind, message: verdict.message }, tries: 0 });
      file.turnOver = true;
      return;
    }
    if (kind.type === 'event_msg' && (kind.inner === 'task_complete' || kind.inner === 'turn_aborted')) file.turnOver = true;
  }

  async function deliver() {
    for (const item of queue.splice(0)) {
      try {
        await options.post(item.event);
        delivered++;
      } catch (error) {
        if (item.tries + 1 >= RETRIES) options.onGiveUp?.(error);
        else queue.push({ event: item.event, tries: item.tries + 1 });
      }
    }
  }

  async function run() {
    if (stopped) return;
    await discover();
    for (const file of [...tracked.values()]) await read(file).catch(() => close(file));
    await deliver();
  }

  // One poll at a time: a slow post never overlaps the next tick.
  const tick = () => (busy = busy.then(run, run));
  const timer = (options.tickMs ?? TICK_MS) > 0 ? setInterval(() => void tick(), options.tickMs ?? TICK_MS) : undefined;
  timer?.unref?.();

  return {
    tick,
    async stop() {
      if (timer) clearInterval(timer);
      await busy.catch(() => {});
      // What Codex wrote just before it exited (a session it began in its last moments too): read it, deliver it, close.
      await discover().catch(() => {});
      for (const file of [...tracked.values()]) {
        await read(file).catch(() => {});
        await close(file);
      }
      await deliver();
      // What could not be delivered by now is dropped: say so once per event.
      for (const _lost of queue.splice(0)) options.onGiveUp?.(new Error('the watch stopped before the event could be delivered'));
      stopped = true;
    },
    get delivered() {
      return delivered;
    },
    get open() {
      return tracked.size;
    },
  };
}
