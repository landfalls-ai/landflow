/** GET /.well-known/oauth-protected-resource/api/mcp: protected resource metadata (RFC 9728) of the host's MCP root. Public. */
import { handler, json } from '@/lib/server/http';
import { protectedResourceMetadata } from '@/lib/server/mcp/identity';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json(protectedResourceMetadata({}), { headers: { 'cache-control': 'public, max-age=300' } }));
