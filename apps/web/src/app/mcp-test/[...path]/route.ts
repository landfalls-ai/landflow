/**
 * MCP Server Trigger test URLs: /mcp-test/<path> serves the tools of the workflow an editor listens with ("Listen for
 * test event" on the trigger, POST /api/workflows/:id/listen), saved or not, over Streamable HTTP (stateless, JSON
 * responses), and 404 otherwise. Each tools/call is a manual test run the editor shows live; listing the tools isn't
 * recorded. The trigger's bearer or header auth applies (401; 403 when its credential isn't the workflow project's).
 * 405 for GET and DELETE. See lib/server/mcp/trigger.ts and lib/server/test-webhooks.ts.
 */
import { handler } from '@/lib/server/http';
import { handleTestTriggerRequest } from '@/lib/server/mcp/trigger';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ path: string[] }> };

async function handle(request: Request, { params }: Ctx) {
  const path = (await params).path.join('/');
  return handleTestTriggerRequest(request, path);
}

export const GET = handler(handle);
export const POST = handler(handle);
export const DELETE = handler(handle);
