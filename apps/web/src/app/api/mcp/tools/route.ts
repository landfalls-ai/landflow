/**
 * GET /api/mcp/tools: every MCP tool of every plugin exposed to agents, with its plugin, its name on the plugin's
 * endpoint and on the gateway, annotations, input and output schema (the tool browser in Settings → MCP). A session
 * or an API key with `workflows:read`; grants are not applied here (that's what the browser is for).
 */
import { handler, json } from '@/lib/server/http';
import { exposedTools } from '@/lib/server/mcp/plugin-servers';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json(exposedTools()));
