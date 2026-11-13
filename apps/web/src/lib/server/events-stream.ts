/**
 * The /api/events stream: bus events a person may see, resumable and re-checked while it is open. Each message
 * carries `id: <bootId>.<seq>`; after a reconnect the browser sends it back as `Last-Event-ID` and the retained
 * events newer than it are replayed (filtered). When the ring no longer reaches back, or the id came from another
 * process, an `event: reset` tells the client to refetch instead. Every `revalidateMs` the visibility filter is
 * rebuilt from the user's current access, and the stream closes once the session or user is gone, so a revoked
 * member stops receiving a project's events within that interval rather than at the next reconnect.
 */
import { bus, type SeqEvent } from './bus';
import { resolvePrincipal, currentPrincipal } from './auth/guard';
import { getUser } from './auth/users';
import { liveEventFilter } from './projects/events';
import { sseResponse, type SseOptions } from './sse';

export const REVALIDATE_MS = 30_000;

type Filter = (event: SeqEvent) => boolean;

export interface EventStreamOptions extends Pick<SseOptions, 'heartbeatMs' | 'maxBufferedBytes'> {
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
    const resolved = resolvePrincipal(request);
    if (!resolved.ok || resolved.principal?.user.id !== principal.user.id) return undefined;
    const user = getUser(principal.user.id);
    if (!user || user.disabledAt) return undefined;
    return liveEventFilter(user);
  };
}

export function eventStream(request: Request, options: EventStreamOptions = {}): Response {
  const authorize = options.authorize ?? reauthorize(request);
  let visible = authorize();
  if (!visible)
    return new Response(JSON.stringify({ error: 'Sign in again' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
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
        const next = authorize();
        if (!next) close();
        else visible = next;
      }, options.revalidateMs ?? REVALIDATE_MS);
      return () => {
        unsubscribe();
        clearInterval(recheck);
      };
    },
    {
      greeting: true,
      retryMs: 3000,
      heartbeatMs: options.heartbeatMs,
      maxBufferedBytes: options.maxBufferedBytes,
    },
  );
}
