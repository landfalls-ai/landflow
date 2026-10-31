/**
 * An agent's tools over MCP for kagent: /api/mcp/agents/<id> serves the tools of an agent deployed to kagent (Streamable
 * HTTP, stateless, both protocol eras), to the bearer token Landflow wrote to kagent's Secret. See lib/server/kagent/mcp.ts.
 */
import { handler } from '@/lib/server/http';
import { handleAgentMcpRequest } from '@/lib/server/kagent/mcp';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

async function handle(request: Request, { params }: Ctx) {
  const { id } = await params;
  return handleAgentMcpRequest(request, id);
}

export const GET = handler(handle);
export const POST = handler(handle);
export const DELETE = handler(handle);
