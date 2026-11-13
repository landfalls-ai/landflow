/**
 * The one way a route streams Server-Sent Events. Every streaming route used to build its own ReadableStream and
 * enqueue without looking at how much a slow client had left unread, so one stalled tab could grow the process's
 * memory without bound. `sseResponse` counts the queued bytes. Past `maxBufferedBytes` it ends the stream with a
 * closing comment when the client has stopped reading (nothing read for `stallMs`), or whatever the client does past
 * `hardLimitBytes` (EventSource reconnects and resumes from its last id; a fetch reader sees the stream end). A client
 * that is reading but behind a burst (a run whose nodes emit megabytes in a few milliseconds) is let catch up.
 * It also writes `id:` / `event:` lines, sends heartbeat comments, and cleans up on abort, cancel and close.
 */
import { sseHeaders } from './http';
import { recordSseConnection } from './telemetry/metrics';

export interface SseSendOptions {
  /** The `id:` line: what the browser sends back as `Last-Event-ID` after a reconnect. */
  id?: string | number;
  /** The `event:` line; without it the browser delivers the message to `onmessage`. */
  event?: string;
}

/** Writes one event; returns false once the stream is closed (client gone, buffer limit hit, or `close()`). */
export type SseSend = (data: unknown, options?: SseSendOptions) => boolean;

/** What a route does with the open stream: it may return (or resolve to) a cleanup that runs once the stream ends. */
export type SseStart = (send: SseSend, close: () => void) => void | (() => void) | Promise<void | (() => void)>;

export interface SseOptions {
  /** Unread bytes past which a client that stopped reading is cut. Default 16 MiB (see DEFAULT_MAX_BUFFERED_BYTES). */
  maxBufferedBytes?: number;
  /** How long a client may read nothing while over `maxBufferedBytes` before it counts as stalled. Default 10 s; 0 cuts at once. */
  stallMs?: number;
  /** Unread bytes past which any client is cut, reading or not. Default 8 × `maxBufferedBytes`. */
  hardLimitBytes?: number;
  /** Heartbeat comment interval, 0 for none. Default 15 s. */
  heartbeatMs?: number;
  /** `retry:` hint to EventSource, in ms. */
  retryMs?: number;
  /** A first comment so proxies flush the headers at once. */
  greeting?: boolean;
  /** The `http.route` label of landflow.sse.connections; default: the request path with ids replaced by `:id`. */
  route?: string;
  /** Extra response headers (the traceparent). */
  headers?: Record<string, string>;
}

/**
 * 16 MiB, the request body cap. A run's events carry node inputs and outputs, so three nodes of 3 MB each queue 16 MB
 * in under a second while the client reads as fast as it can; the run and assistant streams are fetch readers that
 * cannot resume, so a byte limit alone cut healthy editor runs. Hence the stall rule and the larger hard limit.
 */
export const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
export const DEFAULT_STALL_MS = 10_000;
/** Queued bytes that still count as "nothing queued": the retry hint, greeting and a few heartbeats. */
const CONTROL_SLACK_BYTES = 256;

/** A request path as a metric label: segments that look like ids (ids, uuids, anything with a digit) become `:id`. */
export function routeLabel(request: Request): string {
  try {
    return new URL(request.url).pathname.split('/').map((part) => (/\d/.test(part) || part.length > 24 ? ':id' : part)).join('/').slice(0, 80);
  } catch {
    return 'unknown';
  }
}

export function sseResponse(request: Request, start: SseStart, options: SseOptions = {}): Response {
  const { maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES, heartbeatMs = 15_000, retryMs, greeting = false } = options;
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  const hardLimitBytes = Math.max(options.hardLimitBytes ?? maxBufferedBytes * 8, maxBufferedBytes);
  // Progress: bytes the client has taken off the queue (enqueued minus still queued), and when that last grew.
  let enqueued = 0;
  let consumed = 0;
  let progressAt = Date.now();
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let heartbeat: NodeJS.Timeout | undefined;
  let cleanup: (() => void) | undefined;
  const route = options.route ?? routeLabel(request);
  let counted = false;

  const finish = () => {
    if (closed) return;
    closed = true;
    if (counted) recordSseConnection(route, -1);
    if (heartbeat) clearInterval(heartbeat);
    request.signal.removeEventListener('abort', onAbort);
    try {
      cleanup?.();
    } catch {}
    cleanup = undefined;
  };
  const close = () => {
    finish();
    try {
      controller.close();
    } catch {}
  };
  const onAbort = () => close();

  const write = (text: string): boolean => {
    if (closed) return false;
    const bytes = encoder.encode(text);
    const room = controller.desiredSize;
    // An event bigger than the whole limit is still sent when only control frames (retry, greeting, ping) are queued,
    // or it could never be delivered and a resume would loop on it.
    const queued = room === null ? 0 : maxBufferedBytes - room;
    if (enqueued - queued > consumed) {
      consumed = enqueued - queued;
      progressAt = Date.now();
    }
    const over = room !== null && room < bytes.byteLength && queued > CONTROL_SLACK_BYTES;
    const stalled = Date.now() - progressAt >= stallMs;
    if (over && (stalled || queued + bytes.byteLength > hardLimitBytes)) {
      try {
        controller.enqueue(encoder.encode(': buffer limit reached, reconnect\n\n'));
      } catch {}
      close();
      return false;
    }
    try {
      controller.enqueue(bytes);
      enqueued += bytes.byteLength;
      return true;
    } catch {
      close();
      return false;
    }
  };

  const send: SseSend = (data, sendOptions = {}) => {
    const lines: string[] = [];
    if (sendOptions.id !== undefined) lines.push(`id: ${sendOptions.id}`);
    if (sendOptions.event) lines.push(`event: ${sendOptions.event}`);
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    for (const line of payload.split('\n')) lines.push(`data: ${line}`);
    return write(`${lines.join('\n')}\n\n`);
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      cancel: finish,
    },
    // Count bytes, not chunks, so desiredSize is the room left.
    { highWaterMark: maxBufferedBytes, size: (chunk) => chunk.byteLength },
  );

  if (request.signal.aborted) {
    close();
  } else {
    request.signal.addEventListener('abort', onAbort);
    counted = true;
    recordSseConnection(route, 1);
    if (retryMs !== undefined) write(`retry: ${retryMs}\n\n`);
    if (greeting) write(': connected\n\n');
    if (heartbeatMs > 0) heartbeat = setInterval(() => write(': ping\n\n'), heartbeatMs);
    // Not awaited: a route's start may run for minutes (a workflow run) while chunks already flow.
    Promise.resolve()
      .then(() => start(send, close))
      .then(
        (done) => {
          if (typeof done !== 'function') return;
          if (closed) done();
          else cleanup = done;
        },
        () => close(),
      );
  }
  return new Response(stream, {
    headers: { ...sseHeaders, ...options.headers },
  });
}
