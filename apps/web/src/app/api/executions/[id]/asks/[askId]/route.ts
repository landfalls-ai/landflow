import { z } from 'zod';
import { decideAsk } from '@/lib/server/a2a/agent-asks';
import { currentPrincipal } from '@/lib/server/auth/guard';
import { handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const decisionSchema = z.object({ approved: z.boolean(), command: z.string().min(1).max(20_000).optional() });

/**
 * POST /api/executions/:id/asks/:askId `{ approved, command? }` → `{ ask }`: a person's word on a command a Claude Code member asked about
 * (lib/server/a2a/agent-asks.ts). The mod, polling, runs the command or tells Claude Code a person denied it; the journal gets
 * an Approval check (who, what, when). `command` (with `approved: true`) is the command as a person changed it: the poll hands it to the mod,
 * which runs it instead, and the journal says it was edited. Needs update access to the run, like the approvals route. 404 no such ask; 409 already
 * answered, or nobody answered in time.
 */
export const POST = handler(async (request: Request, { params }: { params: Promise<{ id: string; askId: string }> }) => {
  const { id, askId } = await params;
  const body = await parseBody(request, decisionSchema);
  if (!body.ok) return body.response;
  const user = currentPrincipal()?.user;
  return json({ ask: decideAsk(id, askId, body.data.approved, user?.email || user?.name, body.data.command) });
});
