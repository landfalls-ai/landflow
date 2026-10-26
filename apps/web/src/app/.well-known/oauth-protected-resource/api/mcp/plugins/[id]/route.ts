/** GET /.well-known/oauth-protected-resource/api/mcp/plugins/<id>: protected resource metadata (RFC 9728) of one plugin's MCP endpoint. Public. */
import { handler, json } from '@/lib/server/http';
import { protectedResourceMetadata } from '@/lib/server/mcp/identity';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => json(protectedResourceMetadata({ pluginId: decodeURIComponent((await params).id) }), { headers: { 'cache-control': 'public, max-age=300' } }));
