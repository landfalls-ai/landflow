/**
 * The one way a route streams Server-Sent Events. Every streaming route used to build its own ReadableStream and
 * enqueue without looking at how much a slow client had left unread, so one stalled tab could grow the process's
 * memory without bound. `sseResponse` counts the queued bytes and, past `maxBufferedBytes`, writes a closing comment
 * and ends the stream (EventSource reconnects and resumes from its last id; a fetch reader sees the stream end).
 * It also writes `id:` / `event:` lines, sends heartbeat comments, and cleans up on abort, cancel and close.
 */
import { sseHeaders } from './http';

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
  /** Unread bytes a client may hold before the stream is closed. Default 16 MiB (see DEFAULT_MAX_BUFFERED_BYTES). */
  maxBufferedBytes?: number;
  /** Heartbeat comment interval, 0 for none. Default 15 s. */
  heartbeatMs?: number;
  /** `retry:` hint to EventSource, in ms. */
  retryMs?: number;
  /** A first comment so proxies flush the headers at once. */
  greeting?: boolean;
  /** Extra response headers (the traceparent). */
  headers?: Record<string, string>;
}

/**
 * 16 MiB, the request body cap. A run's events carry node outputs, and a healthy reader that is rescheduled late can
 * hold a few megabytes for a moment; at 1 MiB such a reader was cut mid-run. The run and assistant streams are fetch
 * readers that cannot resume, so the limit is there for a client that stopped reading, not for a slow one.
 */
export const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
/** Queued bytes that still count as "nothing queued": the retry hint, greeting and a few heartbeats. */
const CONTROL_SLACK_BYTES = 256;

export function sseResponse(request: Request, start: SseStart, options: SseOptions = {}): Response {
  const { maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES, heartbeatMs = 15_000, retryMs, greeting = false } = options;
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let heartbeat: NodeJS.Timeout | undefined;
  let cleanup: (() => void) | undefined;

  const finish = () => {
    if (closed) return;
    closed = true;
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
    if (room !== null && room < bytes.byteLength && queued > CONTROL_SLACK_BYTES) {
      try {
        controller.enqueue(encoder.encode(': buffer limit reached, reconnect\n\n'));
      } catch {}
      close();
      return false;
    }
    try {
      controller.enqueue(bytes);
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
