/** GET /.well-known/oauth-protected-resource/api/mcp/projects/<id>: protected resource metadata (RFC 9728) of one project's MCP server. Public. */
import { handler, json } from '@/lib/server/http';
import { protectedResourceMetadata } from '@/lib/server/mcp/identity';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => json(protectedResourceMetadata({ projectId: decodeURIComponent((await params).id) }), { headers: { 'cache-control': 'public, max-age=300' } }));
