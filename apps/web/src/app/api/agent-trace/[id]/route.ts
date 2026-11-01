import { z } from 'zod';
import { ingestTrace } from '@/lib/server/a2a/agent-trace';
import { error, handler, parseBody } from '@/lib/server/http';

/**
 * POST /api/agent-trace/:id: what a Claude Code agent on kagent did for one call, from Landflow's landflow-harness mod
 * (lib/server/a2a/agent-trace.ts, docs/a2a.md "The landflow-harness mod"). Public: the id, which Landflow made for that
 * call and sent only in the request, is the credential. 204 taken; 404 no such trace; 410 the call ended (the mod stops
 * posting there); 413 the trace holds all it may.
 */
const bodySchema = z.object({ events: z.array(z.unknown()).max(500) });

export const POST = handler(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) return error('Not found', 404);
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  switch (ingestTrace(id, body.data.events)) {
    case 'ok':
      return new Response(null, { status: 204 });
    case 'closed':
      return error('This call has ended', 410);
    case 'full':
      return error('This trace is full', 413);
    default:
      return error('Not found', 404);
  }
});
