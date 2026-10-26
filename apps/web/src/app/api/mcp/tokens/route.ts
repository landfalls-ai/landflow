/**
 * Your Landflow-issued MCP tokens (session only, like API keys). GET lists them (owners and admins: everyone's with
 * `?all=1`); POST { label, scopes?, expiresInDays? } issues one and returns the JWT once as `token`.
 */
import { z } from 'zod';
import { can } from '@/lib/shared/auth';
import { MCP_TOKEN_SCOPES } from '@/lib/shared/mcp';
import { requireUser } from '@/lib/server/auth';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { issueMcpToken, listMcpTokens, MCP_TOKEN_MAX_DAYS, mcpTokenView, McpTokenError } from '@/lib/server/mcp/tokens';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const me = await requireUser();
  const all = new URL(request.url).searchParams.get('all') === '1' && can(me, 'mcp:manage');
  return json({ tokens: listMcpTokens(all ? undefined : me.id).map(mcpTokenView) });
});

const schema = z.object({
  label: z.string().trim().min(1, 'Name the token').max(100),
  scopes: z.array(z.enum(MCP_TOKEN_SCOPES)).min(1).optional(),
  expiresInDays: z.number().int().min(1).max(MCP_TOKEN_MAX_DAYS).optional(),
});

export const POST = handler(async (request: Request) => {
  const me = await requireUser();
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;
  try {
    const { token, record } = await issueMcpToken(me, body.data);
    recordAudit({ action: 'mcp.token.issue', target: { type: 'mcp_token', id: record.id, name: record.label }, summary: `Issued the MCP token “${record.label}” (${record.scopes.join(', ')}, expires ${record.expiresAt.slice(0, 10)})`, details: { scopes: record.scopes, expiresAt: record.expiresAt } });
    return json({ token, record: mcpTokenView(record) }, 201);
  } catch (caught) {
    if (caught instanceof McpTokenError) return error(caught.message, caught.status);
    throw caught;
  }
});
