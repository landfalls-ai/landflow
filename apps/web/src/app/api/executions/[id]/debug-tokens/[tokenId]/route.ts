/**
 * DELETE /api/executions/:id/debug-tokens/:tokenId: revoke a debug token (its minter; owners and admins: any). It stops
 * working on its next call; the row stays (revoked) until the purge. A token of another execution answers 404.
 */
import { can } from '@/lib/shared/auth';
import { requireUser } from '@/lib/server/auth';
import { getDebugToken, revokeDebugToken } from '@/lib/server/auth/debug-tokens';
import { error, handler, json } from '@/lib/server/http';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; tokenId: string }> };

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const me = await requireUser();
  const { id, tokenId } = await params;
  const token = getDebugToken(tokenId);
  if (!token || token.executionId !== id || (token.createdBy !== me.id && !can(me, 'mcp:manage'))) return error('Debug token not found', 404);
  const revoked = revokeDebugToken(token.id, me.id);
  if (revoked) {
    recordAudit({ action: 'mcp.token.revoke', target: { type: 'debug_token', id: token.id, name: token.label }, summary: `Revoked the debug token for execution ${id}`, details: { kind: 'debug', executionId: id, owner: token.createdBy, uses: token.uses } });
  }
  return json({ ok: true, revoked, record: getDebugToken(token.id) });
});
