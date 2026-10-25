/**
 * MCP Server Triggers: /mcp/<path> serves the tools of the *active* workflow whose MCP Server
 * Trigger has that path, over Streamable HTTP (stateless, JSON responses). 404 when no active
 * workflow serves the path, 401 when the trigger's auth fails, 405 for GET and DELETE.
 * See lib/server/mcp/trigger.ts.
 */
import { handler } from '@/lib/server/http';
import { handleTriggerRequest } from '@/lib/server/mcp/trigger';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ path: string[] }> };

async function handle(request: Request, { params }: Ctx) {
  const path = (await params).path.join('/');
  return handleTriggerRequest(request, path);
}

export const GET = handler(handle);
export const POST = handler(handle);
export const DELETE = handler(handle);
