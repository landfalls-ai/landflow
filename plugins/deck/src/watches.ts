/**
 * Watches: after a Dispatch the plugin keeps one open per unit, reads the pane's deck inbox, and when the unit's
 * completion arrives POSTs `{ unit, report, status }` to Report To, the run's resume URL, which a core Wait ("On Webhook
 * Call") is waiting on. Watches live in memory (a plugin restart loses them and the Wait times out).
 *
 * A message is classified by the deck's own **subject** (`dispatch completed`, `dispatch failed`, `dispatch ended`;
 * `dispatch started` and `dispatch report updated` are ignored) and matched to a unit by its sender label
 * (`the dispatch of "<unit>"`), both set by the deck, never by the unit. The body is the unit's text: it is carried, never
 * read to decide anything. The report keeps the deck's `[UNTRUSTED-WORKER-REPORT:` wrapper and every POST says
 * `trust: "untrusted"`. A reworded deck breaks the match; the README names the commit read and the tests pin today's text.
 *
 * Names must be unique across flows: the deck's inbox cannot tell two units with one name apart. The 50-watch cap is for
 * the whole plugin, shared by every flow that uses it.
 */
import { getTelemetry } from '@landflow/sdk';
import { DeckError, fetchInbox as deckFetchInbox, type DeckMessage } from './deck-cli';

export type { DeckMessage };

export const MAX_WATCHES = 50;
export const DEFAULT_TIMEOUT_MS = 2 * 3_600_000;
export const MAX_TIMEOUT_MS = 24 * 3_600_000;
const POLL_MS = 10_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const BUFFER_MAX = 200;
/** How long a timed_out report keeps being retried after the deadline. */
const TIMED_OUT_GRACE_MS = 10 * 60_000;
/** Consecutive refused or failed inbox reads (about a minute) before the runs are told. */
const UNREADABLE_AFTER = 6;
const WAITING_PATH = '/api/waiting/';

const FAILED_SUBJECTS = new Set(['dispatch failed', 'dispatch ended']);
const FENCE = /\[UNTRUSTED-WORKER-REPORT:[\s\S]*?:END-UNTRUSTED-WORKER-REPORT\]/;

export type WatchStatus = 'completed' | 'failed' | 'timed_out' | 'inbox_unreadable';

export interface Completion {
  /** Untrusted text: the deck's fenced report (completed), the deck's words (failed), the reason (inbox_unreadable) or empty. */
  report: string;
  status: WatchStatus;
}

/** Whether a message is about `unit`: the deck's sender label is `the dispatch of "<unit>"`. */
const about = (message: DeckMessage, unit: string) => message.from === `the dispatch of "${unit}"`;

/** The message's body: what is between the opener line and the closer, minus the deck's `Sent by:` provenance line. */
function bodyOf(text: string): string {
  return text
    .replace(/^\[dot-agent-deck message[^\]]*\]\s*/, '')
    .replace(/^Sent by: [^\n]*\n?/, '')
    .replace(/\s*\[end of dot-agent-deck message[^\]]*\]\s*$/, '')
    .trim();
}

/** The unit's completion in `messages`, if there is one, decided by the deck's subject alone. */
export function completionOf(messages: DeckMessage[], unit: string): Completion | undefined {
  for (const message of messages) {
    if (!about(message, unit)) continue;
    if (message.subject === 'dispatch completed') return { report: FENCE.exec(message.text)?.[0] ?? '', status: 'completed' };
    if (FAILED_SUBJECTS.has(message.subject)) return { report: bodyOf(message.text), status: 'failed' };
  }
  return undefined;
}

interface Watch {
  unit: string;
  reportTo: string;
  deadline: number;
  found?: Completion;
  /** Stop retrying the delivery at this time. */
  giveUpAt: number;
  tries: number;
  nextTryAt: number;
  /**
   * Inbox reads that started before this sequence number may hold the deck's mail about an earlier unit of the same name, so
   * messages about this unit from them are dropped. `Infinity` while the reservation is still draining.
   */
  minSeq: number;
}

export interface WatchesOptions {
  fetchInbox?: () => Promise<DeckMessage[]>;
  /** The host's own origin (where the plugin announced), the only origin Report To may name; undefined when announcing is off. */
  hostOrigin: () => string | undefined;
  now?: () => number;
  post?: typeof fetch;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export class Watches {
  private readonly open = new Map<string, Watch>();
  private buffer: DeckMessage[] = [];
  private nextFetchAt = 0;
  /** Counts inbox reads as they start (see Watch.minSeq). */
  private seq = 0;
  private unreadable = 0;
  private lastError = '';
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private readonly fetchInbox: () => Promise<DeckMessage[]>;
  private readonly now: () => number;
  private readonly post: typeof fetch;
  private readonly log: (message: string, fields?: Record<string, unknown>) => void;

  constructor(private readonly options: WatchesOptions) {
    this.fetchInbox = options.fetchInbox ?? deckFetchInbox;
    this.now = options.now ?? Date.now;
    this.post = options.post ?? fetch;
    this.log = options.log ?? (() => {});
  }

  get size(): number {
    return this.open.size;
  }

  /**
   * Reserves the unit's name and a place under the cap, **before** anything is dispatched, and clears what the deck may
   * still hold about that name: a completion of an earlier unit with the same name must never end this run. Throws a
   * DeckError for another origin, a repeated name or a full table. Call `release` when the dispatch then fails.
   */
  async reserve(unit: string, reportTo: string, timeoutMs: number): Promise<void> {
    const target = this.checkReportTo(reportTo);
    if (this.open.has(unit)) throw new DeckError(`A watch for "${unit}" is already open`, 'Unit names must be unique across flows while a unit is still running.');
    if (this.open.size >= MAX_WATCHES) throw new DeckError(`Too many open watches (at most ${MAX_WATCHES})`, 'The limit is shared by every flow that uses this plugin. Wait for a running unit to finish before dispatching another.');
    const clamped = Math.max(60_000, Math.min(timeoutMs, MAX_TIMEOUT_MS));
    const deadline = this.now() + clamped;
    // Registered first so a concurrent reserve of the same name or the 51st sees it; matching starts after the drain below.
    const watch: Watch = { unit, reportTo: target, deadline, giveUpAt: deadline, tries: 0, nextTryAt: 0, minSeq: Infinity };
    this.open.set(unit, watch);
    this.buffer = this.buffer.filter((m) => !about(m, unit));
    try {
      // Take what the deck holds now and drop what is about this name; mail for other units stays in the buffer. While this
      // runs the watch is draining (minSeq Infinity): a tick's read can not hand it a stale completion in the meantime.
      this.seq++;
      const stale = await this.fetchInbox();
      this.buffer = [...this.buffer, ...stale.filter((m) => !about(m, unit))].slice(-BUFFER_MAX);
      watch.minSeq = this.seq + 1;
    } catch (error) {
      // Fail closed: without a clean drain a stale completion could end this run, so the unit is not dispatched.
      this.open.delete(unit);
      this.log('deck inbox not readable while reserving', { 'deck.unit.name': unit, error: (error as Error).message });
      throw new DeckError(`Could not clear the deck inbox before dispatching "${unit}": ${(error as Error).message}`, 'Start the plugin from the pane that runs the deck, or leave Report To empty.');
    }
  }

  /** Gives a reservation back (the dispatch failed). */
  release(unit: string): void {
    this.open.delete(unit);
  }

  /**
 * Report To must be a resume URL under /api/waiting/. Only its path and signature are used: the plugin always posts to the
 * host it announced to (`LANDFLOW_REGISTRY_URL`), whatever origin the URL names, because the host may be reached by another
 * name from where the plugin runs (a container sees `host.docker.internal`, the run's URL says `localhost`). So a flow can
 * never make the plugin call anywhere else. Returns the address it will post to.
 */
  checkReportTo(reportTo: string): string {
    const bad = new DeckError('Report To must be this Landflow host\'s resume URL', 'Leave it as {{ $execution.resumeUrl }}. It must be an http(s) address under /api/waiting/ on the host the plugin announced to (LANDFLOW_REGISTRY_URL).');
    const hostOrigin = this.options.hostOrigin();
    if (!hostOrigin) throw new DeckError('Report To cannot be used: no host origin configured', 'The plugin has no Landflow host to report to (LANDFLOW_REGISTRY_URL=off). Start it with the host\'s URL, or leave Report To empty.');
    let url: URL;
    let host: URL;
    try {
      url = new URL(reportTo);
      host = new URL(hostOrigin);
    } catch {
      throw bad;
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.pathname.startsWith(WAITING_PATH) || url.pathname.length === WAITING_PATH.length) throw bad;
    return new URL(url.pathname + url.search, host).toString();
  }

  /** One pass: expire, read the inbox (at most every 10 s), deliver what is due. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const watch of this.open.values()) {
        if (!watch.found && now >= watch.deadline) {
          // The run is told, not left to its own Wait limit; Watch For is shorter than the Wait's by design (README).
          watch.found = { report: '', status: 'timed_out' };
          watch.giveUpAt = now + TIMED_OUT_GRACE_MS;
          watch.nextTryAt = 0;
          this.log('deck watch timed out', { 'deck.unit.name': watch.unit });
        } else if (watch.found && now >= watch.giveUpAt) {
          this.open.delete(watch.unit);
        }
      }
      if (this.open.size === 0) return;
      const waiting = [...this.open.values()].some((w) => !w.found);
      if (waiting && now >= this.nextFetchAt) {
        this.nextFetchAt = now + POLL_MS;
        const startedAt = ++this.seq;
        try {
          const fetched = await this.fetchInbox();
          // Mail about a unit whose reservation was cleared after this read started may be from an earlier unit of that name.
          const stale = (m: DeckMessage) => [...this.open.values()].some((w) => startedAt < w.minSeq && about(m, w.unit));
          this.buffer = [...this.buffer, ...fetched.filter((m) => !stale(m))].slice(-BUFFER_MAX);
          this.unreadable = 0;
        } catch (error) {
          this.unreadable++;
          this.lastError = (error as Error).message;
          this.log('deck inbox not readable', { error: this.lastError, 'deck.inbox.failures': this.unreadable });
          if (this.unreadable >= UNREADABLE_AFTER) {
            for (const watch of this.open.values()) {
              if (watch.found) continue;
              watch.found = { report: `The deck inbox could not be read: ${this.lastError}`, status: 'inbox_unreadable' };
              watch.giveUpAt = now + TIMED_OUT_GRACE_MS;
            }
            this.unreadable = 0;
          }
        }
      }
      // A completion fetched before its watch asked for it is still in the buffer; matched ones are delivered, not kept.
      for (const watch of this.open.values()) if (!watch.found && watch.minSeq !== Infinity) watch.found = completionOf(this.buffer, watch.unit);
      this.buffer = this.buffer.filter((m) => ![...this.open.values()].some((w) => w.found && about(m, w.unit)));
      for (const watch of [...this.open.values()]) if (watch.found && now >= watch.nextTryAt) await this.deliver(watch, now);
    } finally {
      this.ticking = false;
    }
  }

  private async deliver(watch: Watch, now: number): Promise<void> {
    try {
      const response = await this.post(watch.reportTo, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ unit: watch.unit, report: watch.found!.report, status: watch.found!.status, trust: 'untrusted' }),
        signal: AbortSignal.timeout(10_000),
        // A resume URL never redirects; a redirect is a failure, not a place to send the report.
        redirect: 'error',
      });
      // 409 "running, not waiting": the run has not reached its Wait yet (Dispatch returns first), so it is retried. Any other
      // 409 (a form or a tool-approval wait, a Wait set to another resume) never changes, so it stops.
      const notWaitingYet = response.status === 409 && /running, not waiting/i.test(await response.text().catch(() => ''));
      const retryable = response.status >= 500 || response.status === 408 || notWaitingYet || response.status === 429;
      if (response.ok || !retryable) {
        if (!response.ok) this.log('deck report refused by the host', { 'deck.unit.name': watch.unit, status: response.status });
        this.open.delete(watch.unit);
        return;
      }
    } catch (error) {
      this.log('deck report not delivered', { 'deck.unit.name': watch.unit, error: (error as Error).message });
    }
    watch.nextTryAt = now + Math.min(BACKOFF_START_MS * 2 ** watch.tries, BACKOFF_MAX_MS);
    watch.tries++;
  }

  /** Starts the 1 s loop (the timer never keeps the process alive). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 1_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.open.clear();
    this.buffer = [];
  }
}

/** The plugin's one table of watches; the host it reports to is the one it announced to (none when announcing is off). */
let shared: Watches | undefined;
export function sharedWatches(): Watches {
  shared ??= new Watches({
    hostOrigin: () => {
      const url = process.env.LANDFLOW_REGISTRY_URL;
      return url === 'off' ? undefined : url || 'http://127.0.0.1:3000';
    },
    log: (message, fields) => getTelemetry().logger.warn(message, fields),
  });
  shared.start();
  return shared;
}
