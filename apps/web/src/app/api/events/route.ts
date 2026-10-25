/** Live SSE feed of registry + execution events for every open editor/dashboard. */
import { bus } from '@/lib/server/bus';
import { handler, sseHeaders } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const encoder = new TextEncoder();
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
