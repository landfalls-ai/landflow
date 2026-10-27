/**
 * One chat message to the editor assistant (Spotlight in the editor). The
 * reply streams as SSE, one event per step: `text`, `tool` (activity),
 * `proposal` (validated changes), then `done`, or `error`. `session` marks a
 * request from Spotlight's test-and-fix session.
 */
import { z } from 'zod';
import type { Workflow } from '@landflow/engine';
import { runChat, type ChatEvent } from '@/lib/server/assistant/chat';
import { errorText } from '@/lib/server/assistant/model';
import { allowedTypes } from '@/lib/server/assistant/scope';
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
  /** The saved workflow being edited: proposals then use only the node types its project and its own lists allow. */
  workflowId: z.string().max(200).optional(),
  /** What the user tagged in the message: node ids on the canvas, node type ids. */
  mentions: z.object({ nodes: z.array(z.string().max(200)).max(20), types: z.array(z.string().max(200)).max(20) }).partial().optional(),
  /** From Spotlight's test-and-fix session: a request for a fix to a failed run, or whether a run did what was asked. */
  session: z.enum(['fix', 'review']).optional(),
});

export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const { workflow, workflowId, ...rest } = parsed.data;
  const types = allowedTypes(workflowId);
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
        await runChat({ ...rest, types, workflow: { id: workflowId ?? 'draft', ...workflow } as Workflow, signal: abort.signal, onEvent: send });
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
