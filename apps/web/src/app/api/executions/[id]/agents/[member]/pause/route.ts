/**
 * POST /api/executions/:id/agents/:member/pause → `{ member, kind, state }`: pause a team member of a running execution.
 * A Landflow agent (the lead too) stops at its next step boundary and waits for `continue`; a remote (A2A) member's task is
 * canceled at once ("Stop and redirect") and `continue` sends the instruction to the same conversation. `:member` is the
 * member's title in the team. 404 when it isn't working in this execution.
 */
import { error, handler, json } from '@/lib/server/http';
import { currentPrincipal } from '@/lib/server/auth/guard';
import { PauseError, requestPause } from '@/lib/server/agent-teams/pause';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; member: string }> };

export const POST = handler(async (_request: Request, { params }: Ctx) => {
  const { id, member: raw } = await params;
  const member = decodeURIComponent(raw);
  const user = currentPrincipal()?.user;
  try {
    const result = await requestPause(id, member, { id: user?.id ?? 'unknown', name: user?.name || user?.email || 'A person' });
    recordAudit({ action: 'execution.agent.pause', target: { type: 'execution', id }, details: { member, kind: result.kind } });
    return json(result);
  } catch (caught) {
    if (caught instanceof PauseError) return error(caught.message, caught.status);
    throw caught;
  }
});
