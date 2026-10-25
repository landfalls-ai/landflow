/**
 * One chat message to the editor assistant. The reply streams as SSE, one
 * event per step: `text`, `tool` (activity), `proposal` (validated changes),
 * then `done`, or `error`.
 */
import { z } from 'zod';
import type { Workflow } from '@landflow/engine';
import { runChat, type ChatEvent } from '@/lib/server/assistant/chat';
import { errorText } from '@/lib/server/assistant/model';
import { handler, parseBody, sseHeaders } from '@/lib/server/http';
import { runDigestSchema, workflowSchema } from '@/lib/server/schemas';
import { traceparentHeader } from '@/lib/server/telemetry';

export const dynamic = 'force-dynamic';

const Body = z.object({
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(20_000) }))
    .min(1)
    .max(60)
    .refine((messages) => messages.at(-1)?.role === 'user', 'The last message must be from the user'),
  workflow: workflowSchema,
  selectedNodeId: z.string().optional(),
  runs: z.record(z.string(), runDigestSchema).optional(),
  model: z.string().max(100).optional(),
});

export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const { workflow, ...rest } = parsed.data;
  const encoder = new TextEncoder();
  const abort = new AbortController();
  request.signal.addEventListener('abort', () => abort.abort());

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ChatEvent) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        } catch {
          // client went away
        }
      };
      try {
        await runChat({ ...rest, workflow: { id: 'draft', ...workflow } as Workflow, signal: abort.signal, onEvent: send });
      } catch (caught) {
        if (!abort.signal.aborted) send({ type: 'error', message: errorText(caught) });
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });
  return new Response(stream, { headers: { ...sseHeaders, ...traceparentHeader() } });
});
