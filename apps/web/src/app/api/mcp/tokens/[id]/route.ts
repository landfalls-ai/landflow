/**
 * DELETE /api/mcp/tokens/<id>: revoke one of your MCP tokens (owners and admins: anyone's); it stops working on the
 * next call. A second DELETE on a token that is already revoked or expired removes its row (`purged: true`); live
 * tokens are never deleted outright, so a revocation always leaves a trace until the purge (30 days, the gateway sync's tick).
 */
import { can } from '@/lib/shared/auth';
import { requireUser } from '@/lib/server/auth';
import { error, handler, json } from '@/lib/server/http';
import { deleteMcpToken, getMcpToken, isDeadMcpToken, mcpTokenView, revokeMcpToken } from '@/lib/server/mcp/tokens';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const me = await requireUser();
  const token = getMcpToken((await params).id);
  if (!token || (token.userId !== me.id && !can(me, 'mcp:manage'))) return error('MCP token not found', 404);
  return json({ record: mcpTokenView(token) });
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const me = await requireUser();
  const token = getMcpToken((await params).id);
  if (!token || (token.userId !== me.id && !can(me, 'mcp:manage'))) return error('MCP token not found', 404);
  if (isDeadMcpToken(token)) {
    deleteMcpToken(token.id);
    recordAudit({ action: 'mcp.token.delete', target: { type: 'mcp_token', id: token.id, name: token.label }, summary: `Deleted the ${token.revokedAt ? 'revoked' : 'expired'} MCP token “${token.label}”`, details: { owner: token.userId, revokedAt: token.revokedAt, expiresAt: token.expiresAt } });
    return json({ ok: true, purged: true, record: mcpTokenView(token) });
  }
  const revoked = revokeMcpToken(token.id);
  if (revoked) recordAudit({ action: 'mcp.token.revoke', target: { type: 'mcp_token', id: token.id, name: token.label }, summary: `Revoked the MCP token “${token.label}”`, details: { owner: token.userId } });
  return json({ ok: true, purged: false, record: mcpTokenView(getMcpToken(token.id) ?? token) });
});
