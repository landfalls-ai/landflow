/**
 * GET /api/mcp/gateway: the gateway sync's status for Settings → MCP (lib/server/mcp/gateway-sync.ts): mode and
 * adapter, the gateway's health, every target and route Landflow wants or owns with whether the gateway has it as
 * rendered (in step, drift, missing, stale), the last sync and the last error. Any signed-in user.
 */
import { handler, json } from '@/lib/server/http';
import { mcpGatewaySync } from '@/lib/server/mcp/gateway-sync';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json(await mcpGatewaySync.status()));
