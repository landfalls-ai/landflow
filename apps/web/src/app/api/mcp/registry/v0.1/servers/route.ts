/**
 * The private MCP Registry API (docs/protocol.md §15.4), v0.1 shapes: GET /api/mcp/registry/v0.1/servers lists every
 * plugin's server.json with `?limit`, `?cursor`, `?search`, `?version=latest`, `?updated_since`. Read-only, for signed-in
 * users, Landflow MCP tokens, identity provider tokens, API keys and the gateway (lib/server/mcp/identity.ts).
 */
import { handler, json } from '@/lib/server/http';
import { registryCaller } from '@/lib/server/mcp/identity';
import { listServers } from '@/lib/server/mcp/registry';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const gate = await registryCaller(request);
  if (!gate.ok) return gate.response;
  const q = new URL(request.url).searchParams;
  const limit = q.get('limit') ? Number(q.get('limit')) : undefined;
  return json(listServers({ ...(limit !== undefined && Number.isFinite(limit) && { limit }), cursor: q.get('cursor') ?? undefined, search: q.get('search') ?? undefined, version: q.get('version') ?? undefined, updatedSince: q.get('updated_since') ?? undefined }));
});
