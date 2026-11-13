/**
 * The /api/events stream: bus events a person may see, resumable and re-checked while it is open. Each message
 * carries `id: <bootId>.<seq>`; after a reconnect the browser sends it back as `Last-Event-ID` and the retained
 * events newer than it are replayed (filtered). When the ring no longer reaches back, or the id came from another
 * process, an `event: reset` tells the client to refetch instead. Every `revalidateMs` the visibility filter is
 * rebuilt from the user's current access, and the stream closes once the session or user is gone, so a revoked
 * member stops receiving a project's events within that interval rather than at the next reconnect. The re-check does
 * not mark the session as used, so a tab left open still reaches the idle limit and its stream closes then.
 */
import { bus, type SeqEvent } from './bus';
import { resolvePrincipal, currentPrincipal } from './auth/guard';
import { error } from './http';
import { getUser } from './auth/users';
import { liveEventFilter } from './projects/events';
import { sseResponse, type SseOptions } from './sse';

export const REVALIDATE_MS = 30_000;

type Filter = (event: SeqEvent) => boolean;

export interface EventStreamOptions extends Pick<SseOptions, 'heartbeatMs' | 'maxBufferedBytes' | 'stallMs'> {
  revalidateMs?: number;
  /** A fresh filter for the same user, or undefined when the session or user is no longer valid. Tests replace it. */
  authorize?: () => Filter | undefined;
}

/** Default re-check: the same credentials still resolve to a live user, and the filter is rebuilt from their access now. */
function reauthorize(request: Request): () => Filter | undefined {
  const principal = currentPrincipal();
  if (!principal) return () => undefined;
  // Tests (and nothing else) run as a synthetic principal that has no credentials to re-resolve.
  if (principal.via === 'test') return () => liveEventFilter(principal.user);
  return () => {
    // Without touching the session: an open tab is not activity, so the idle limit (LANDFLOW_SESSION_IDLE_HOURS) still ends it.
    const resolved = resolvePrincipal(request, { touch: false });
    if (!resolved.ok || resolved.principal?.user.id !== principal.user.id) return undefined;
    const user = getUser(principal.user.id);
    if (!user || user.disabledAt) return undefined;
    return liveEventFilter(user);
  };
}

export function eventStream(request: Request, options: EventStreamOptions = {}): Response {
  const authorize = options.authorize ?? reauthorize(request);
  let visible = authorize();
  if (!visible) return error('Sign in again', 401);
  const lastId = request.headers.get('last-event-id');
  return sseResponse(
    request,
    (send, close) => {
      const emit = (event: SeqEvent) => {
        if (visible?.(event)) send(event, { id: `${bus.bootId}.${event.seq}` });
      };
      let afterSeq: number | undefined;
      if (lastId) {
        const [boot, seq] = lastId.split('.');
        const n = Number(seq);
        if (boot === bus.bootId && Number.isInteger(n) && bus.covers(n)) afterSeq = n;
        else send({ reason: boot === bus.bootId ? 'out-of-range' : 'other-process' }, { event: 'reset' });
      }
      const unsubscribe = bus.subscribe(emit, { afterSeq });
      const recheck = setInterval(() => {
        // A throw here (a database read during shutdown) would be an uncaught exception, which ends the process: close instead.
        let next: Filter | undefined;
        try {
          next = authorize();
        } catch {
          next = undefined;
        }
        if (!next) close();
        else visible = next;
      }, options.revalidateMs ?? REVALIDATE_MS);
      return () => {
        unsubscribe();
        clearInterval(recheck);
      };
    },
    {
      route: '/api/events',
      greeting: true,
      retryMs: 3000,
      heartbeatMs: options.heartbeatMs,
      maxBufferedBytes: options.maxBufferedBytes,
      stallMs: options.stallMs,
    },
  );
}
