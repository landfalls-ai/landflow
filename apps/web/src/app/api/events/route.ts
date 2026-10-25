/** Live SSE feed of registry + execution events for every open editor/dashboard. */
import { bus } from '@/lib/server/bus';
import { handler, sseHeaders } from '@/lib/server/http';
import { liveEventFilter } from '@/lib/server/projects/events';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const encoder = new TextEncoder();
  // Members only get the events of the workflows and agents they see.
  const visible = liveEventFilter(routeActor());
  let unsubscribe = () => {};
  let keepAlive: NodeJS.Timeout | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const cleanup = () => {
        unsubscribe();
        if (keepAlive) clearInterval(keepAlive);
      };
      write(': connected\n\n');
      unsubscribe = bus.subscribe((event) => {
        if (!visible(event)) return;
        // Heartbeats are high-volume; the UI only needs their timing, not the full payload.
        write(`data: ${JSON.stringify(event)}\n\n`);
      });
      keepAlive = setInterval(() => write(': ping\n\n'), 15_000);
      request.signal.addEventListener('abort', () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      unsubscribe();
      if (keepAlive) clearInterval(keepAlive);
    },
  });
  return new Response(stream, { headers: sseHeaders });
});
