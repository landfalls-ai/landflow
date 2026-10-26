/**
 * The instance MCP server, for coding agents (Claude Code, Cursor…): build, validate and run
 * workflows over Streamable HTTP (stateless, JSON responses). Off by default: Settings → MCP turns
 * it on and shows the access token, sent as `Authorization: Bearer <token>`. 403 while it is off,
 * 401 without the right token. Behind the bundled gateway (a target of its own, see lib/server/mcp/gateway-sync.ts) the
 * gateway secret and the caller it validated stand for a Landflow user, whose permissions apply. See
 * lib/server/mcp/instance-tools.ts for the tools. Both protocol eras are served (lib/server/mcp/server.ts).
 */
import type { AuthInfo } from '@modelcontextprotocol/server';
import { withAuth } from '@/lib/server/auth/context';
import { handler } from '@/lib/server/http';
import { authenticateInstanceRequest, mcpAccess, type InstanceCaller } from '@/lib/server/mcp/instance';
import { instanceServer } from '@/lib/server/mcp/instance-tools';
import { jsonRpcError, serveMcpEndpoint } from '@/lib/server/mcp/server';

export const dynamic = 'force-dynamic';

const callerOf = (authInfo: AuthInfo | undefined) => (authInfo?.extra as { caller?: InstanceCaller } | undefined)?.caller;

async function handle(request: Request) {
  if (!mcpAccess().enabled) return jsonRpcError(403, -32001, 'The Landflow MCP server is off. Turn it on in Settings → MCP.');
  const caller = await authenticateInstanceRequest(request);
  if (caller instanceof Response) return caller;
  const authInfo: AuthInfo = { token: '', clientId: caller.kind === 'user' ? caller.user.id : 'instance', scopes: [], extra: { caller } };
  // One factory for the endpoint (the SDK keeps the latest one per key): the caller rides in `authInfo`.
  const serve = () =>
    serveMcpEndpoint('request:/api/mcp', request, (info) => {
      const who = callerOf(info.authInfo);
      return instanceServer(who?.kind === 'user' ? who.actor : undefined);
    }, authInfo);
  return caller.kind === 'user' ? withAuth({ principal: { user: caller.user, via: 'mcp' } }, serve) : serve();
}

export const GET = handler(handle);
export const POST = handler(handle);
export const DELETE = handler(handle);
