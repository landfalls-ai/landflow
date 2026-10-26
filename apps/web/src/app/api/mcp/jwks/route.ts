/** GET /api/mcp/jwks: the public keys (RFC 7517) that verify Landflow-issued MCP tokens; the gateway reads them too. Public. */
import { handler, json } from '@/lib/server/http';
import { mcpJwks } from '@/lib/server/mcp/tokens';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json(await mcpJwks(), { headers: { 'cache-control': 'public, max-age=300' } }));
