/** GET /api/mcp/registry/v0.1/servers/<name>/versions: every version of one server, newest first. */
import { error, handler, json } from '@/lib/server/http';
import { listServerVersions } from '@/lib/server/mcp/registry';
import { registryCaller } from '@/lib/server/mcp/identity';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ name: string }> };

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const gate = await registryCaller(request);
  if (!gate.ok) return gate.response;
  const found = listServerVersions(decodeURIComponent((await params).name));
  return found ? json(found) : error('Server not found', 404);
});
