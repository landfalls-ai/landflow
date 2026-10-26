/** DELETE /api/mcp/tokens/<id>: revoke one of your MCP tokens (owners and admins: anyone's). It stops working on the next call. */
import { can } from '@/lib/shared/auth';
import { requireUser } from '@/lib/server/auth';
import { error, handler, json } from '@/lib/server/http';
import { getMcpToken, mcpTokenView, revokeMcpToken } from '@/lib/server/mcp/tokens';
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
  const revoked = revokeMcpToken(token.id);
  if (revoked) recordAudit({ action: 'mcp.token.revoke', target: { type: 'mcp_token', id: token.id, name: token.label }, summary: `Revoked the MCP token “${token.label}”`, details: { owner: token.userId } });
  return json({ ok: true, record: mcpTokenView(getMcpToken(token.id) ?? token) });
});
