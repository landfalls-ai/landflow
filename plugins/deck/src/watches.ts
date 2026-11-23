/**
 * Watches: after a Dispatch the plugin keeps one open per unit, reads the pane's deck inbox, and when the unit's
 * completion arrives POSTs `{ unit, report, status }` to Report To, the run's resume URL, which a core Wait ("On Webhook
 * Call") is waiting on. Watches live in memory (a plugin restart loses them and the Wait times out).
 *
 * Completion is matched on the deck's documented words (dispatch_return.rs: the message opens
 * `dispatch: a unit you dispatched has completed`, its sender label names the unit, the report sits between
 * `[UNTRUSTED-WORKER-REPORT:` and `:END-UNTRUSTED-WORKER-REPORT]`). A reworded deck breaks the match; the README names the
 * commit read and the tests pin today's text.
 */
import { DeckError, fetchInbox as deckFetchInbox, type DeckMessage } from './deck-cli';

export type { DeckMessage };

export const MAX_WATCHES = 50;
export const DEFAULT_TIMEOUT_MS = 2 * 3_600_000;
export const MAX_TIMEOUT_MS = 24 * 3_600_000;
const POLL_MS = 10_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const BUFFER_MAX = 200;

const COMPLETED = 'dispatch: a unit you dispatched has completed';
const UPDATE = 'dispatch: a unit you dispatched sent an update';
const SPAWNED = 'dispatch: spawned isolated';
const FENCE = /\[UNTRUSTED-WORKER-REPORT:\s*([\s\S]*?)\s*:END-UNTRUSTED-WORKER-REPORT\]/;

export interface Completion {
  report: string;
  status: 'completed' | 'failed';
}

/** Whether a message is about `unit`: its sender label is `the dispatch of "<unit>"`. */
const about = (message: DeckMessage, unit: string) => message.from.includes(`"${unit}"`) || message.from.endsWith(`dispatch:${unit}`);

/**
 * The unit's completion in `messages`, if there is one. A `dispatch:` message about the unit that is neither the spawn
 * reply, nor an update, nor a completion is the deck refusing or failing the dispatch: a failed unit, with its words.
 */
export function completionOf(messages: DeckMessage[], unit: string): Completion | undefined {
  for (const message of messages) {
    if (!about(message, unit)) continue;
    const text = message.text;
    if (text.includes(UPDATE) || text.includes(SPAWNED)) continue;
    if (text.includes(COMPLETED)) return { report: FENCE.exec(text)?.[1] ?? '', status: 'completed' };
    if (/\bdispatch:/.test(text)) return { report: text.replace(/^\[dot-agent-deck message[^\]]*\]\s*/, '').replace(/\s*\[end of dot-agent-deck message[^\]]*\]\s*$/, '').trim(), status: 'failed' };
  }
  return undefined;
}

interface Watch {
  unit: string;
  reportTo: string;
  deadline: number;
  found?: Completion;
  tries: number;
  nextTryAt: number;
}

export interface WatchesOptions {
  fetchInbox?: () => Promise<DeckMessage[]>;
  /** The host's own origin (where the plugin announced), the only origin Report To may name. */
  hostOrigin: () => string;
  now?: () => number;
  post?: typeof fetch;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Same origin, with the loopback names counted as one (a host announced on 127.0.0.1 hands out localhost URLs). */
function sameOrigin(a: URL, b: URL): boolean {
  if (a.protocol !== b.protocol || a.port !== b.port) return false;
  return a.hostname === b.hostname || (LOOPBACK.has(a.hostname) && LOOPBACK.has(b.hostname));
}

export class Watches {
  private readonly open = new Map<string, Watch>();
  private buffer: DeckMessage[] = [];
  private nextFetchAt = 0;
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

  /** Checks Report To and opens a watch. Throws a DeckError for another origin, a repeated unit or a full table. */
  add(unit: string, reportTo: string, timeoutMs: number): void {
    this.checkReportTo(reportTo);
    if (this.open.has(unit)) throw new DeckError(`A watch for "${unit}" is already open`, 'Unit names must be unique while a unit is still running.');
    if (this.open.size >= MAX_WATCHES) throw new DeckError(`Too many open watches (at most ${MAX_WATCHES})`, 'Wait for a running unit to finish before dispatching another.');
    const clamped = Math.max(60_000, Math.min(timeoutMs, MAX_TIMEOUT_MS));
    this.open.set(unit, { unit, reportTo, deadline: this.now() + clamped, tries: 0, nextTryAt: 0 });
  }

  /** Report To must be a resume URL on this host's own origin: a flow cannot make the plugin call anywhere else. */
  checkReportTo(reportTo: string): void {
    const bad = new DeckError('Report To must be this Landflow host\'s resume URL', 'Leave it as {{ $execution.resumeUrl }}. It must be an http(s) address on the host the plugin announced to (LANDFLOW_REGISTRY_URL).');
    let url: URL;
    let host: URL;
    try {
      url = new URL(reportTo);
      host = new URL(this.options.hostOrigin());
    } catch {
      throw bad;
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !sameOrigin(url, host)) throw bad;
  }

  /** One pass: expire, read the inbox (at most every 10 s), deliver what is due. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const [unit, watch] of this.open) {
        if (now >= watch.deadline) {
          this.open.delete(unit);
          this.log('deck watch timed out', { 'deck.unit.name': unit });
        }
      }
      if (this.open.size === 0) return;
      const waiting = [...this.open.values()].some((w) => !w.found);
      if (waiting && now >= this.nextFetchAt) {
        this.nextFetchAt = now + POLL_MS;
        try {
          this.buffer = [...this.buffer, ...(await this.fetchInbox())].slice(-BUFFER_MAX);
        } catch (error) {
          this.log('deck inbox not readable', { error: (error as Error).message });
        }
      }
      // A completion fetched before its watch opened is still in the buffer; matched ones are delivered, not kept.
      for (const watch of this.open.values()) if (!watch.found) watch.found = completionOf(this.buffer, watch.unit);
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
        body: JSON.stringify({ unit: watch.unit, report: watch.found!.report, status: watch.found!.status }),
        signal: AbortSignal.timeout(10_000),
      });
      const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
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

  /** Starts the 1 s loop (a no-op when it runs; the timer never keeps the process alive). */
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

/** The plugin's one table of watches; the host it reports to is the one it announced to. */
let shared: Watches | undefined;
export function sharedWatches(): Watches {
  shared ??= new Watches({ hostOrigin: () => process.env.LANDFLOW_REGISTRY_URL || 'http://127.0.0.1:3000' });
  shared.start();
  return shared;
}
