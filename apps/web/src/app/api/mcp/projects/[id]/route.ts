/**
 * The instance MCP server scoped to one project (docs/transports.md): the same tools as /api/mcp, but they list and change only
 * this project's workflows, and what they create goes into it. Same sign-in as /api/mcp (the access token from Settings → MCP, a
 * Landflow MCP token, an identity provider's token, an API key, or the gateway); 404 for an unknown project, 403 for a token scoped
 * to another one. See lib/server/mcp/instance-route.ts.
 */
import { handler } from '@/lib/server/http';
import { serveInstance } from '@/lib/server/mcp/instance-route';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const handle = async (request: Request, { params }: Ctx) => serveInstance(request, decodeURIComponent((await params).id));

export const GET = handler(handle);
export const POST = handler(handle);
export const DELETE = handler(handle);
