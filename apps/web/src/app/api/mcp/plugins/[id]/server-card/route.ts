/**
 * GET /api/mcp/plugins/<id>/server-card: the plugin's Server Card (SEP-2127), for clients that look before connecting.
 * Served to the same callers as `tools/list`, with the tools that caller would see (stream T2-F; the endpoint itself is T2-E's).
 */
import { error, handler, json } from '@/lib/server/http';
import { authenticateMcpRequest, canReadRegistry, McpAuthError, mcpAuthErrorResponse } from '@/lib/server/mcp/identity';
import { serverCardFor } from '@/lib/server/mcp/registry';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const pluginId = decodeURIComponent((await params).id);
  try {
    const caller = await authenticateMcpRequest(request, { pluginId });
    if (!canReadRegistry(caller)) return mcpAuthErrorResponse(new McpAuthError('This caller may not read Server Cards', 403));
    const card = serverCardFor(pluginId, caller);
    return card ? json(card, { headers: { 'cache-control': 'private, no-store' } }) : error('No such MCP server', 404);
  } catch (caught) {
    if (caught instanceof McpAuthError) return mcpAuthErrorResponse(caught);
    throw caught;
  }
});
