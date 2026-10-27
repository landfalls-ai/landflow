/**
 * The instance MCP server, for coding agents (Claude Code, Cursor…): build, validate and run
 * workflows over Streamable HTTP (stateless, JSON responses). Off by default: Settings → MCP turns
 * it on and shows the access token, sent as `Authorization: Bearer <token>`. 403 while it is off,
 * 401 without the right token. A Landflow MCP token (or an identity provider's token, or an API key) works too and acts as
 * its user; a token issued for a project sees only that project (`/api/mcp/projects/<id>` is the same server for one
 * project). Behind the bundled gateway (a target of its own, see lib/server/mcp/gateway-sync.ts) the
 * gateway secret and the caller it validated stand for a Landflow user, whose permissions apply. See
 * lib/server/mcp/instance-tools.ts for the tools. Both protocol eras are served (lib/server/mcp/server.ts).
 */
import { handler } from '@/lib/server/http';
import { serveInstance } from '@/lib/server/mcp/instance-route';

export const dynamic = 'force-dynamic';

const handle = (request: Request) => serveInstance(request);

export const GET = handler(handle);
export const POST = handler(handle);
export const DELETE = handler(handle);
