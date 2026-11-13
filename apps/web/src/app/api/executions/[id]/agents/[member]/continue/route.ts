/**
 * POST /api/executions/:id/agents/:member/continue `{ message? }` → `{ member, kind, state }`: take over a paused team
 * member. `message` is the next instruction (added to its conversation as a message from the person); without one it goes
 * on as it was. 409 when the member is not paused (yet).
 */
import { z } from 'zod';
import { handler, json, parseBody } from '@/lib/server/http';
import { currentPrincipal } from '@/lib/server/auth/guard';
import { continueMember } from '@/lib/server/agent-teams/pause';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; member: string }> };

const bodySchema = z.object({ message: z.string().max(8000).optional() });

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id, member: raw } = await params;
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  const member = decodeURIComponent(raw);
  const user = currentPrincipal()?.user;
  const result = continueMember(id, member, body.data.message, { id: user?.id ?? 'unknown', name: user?.name || user?.email || 'A person' });
  recordAudit({ action: 'execution.agent.continue', target: { type: 'execution', id }, details: { member, instructed: Boolean(body.data.message?.trim()) } });
  return json(result);
});
