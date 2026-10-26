/** GET /api/mcp/registry/v0.1/servers/<name>: the latest version of one server (a convenience; the official path is `/versions/latest`). */
import { error, handler, json } from '@/lib/server/http';
import { getServerVersion } from '@/lib/server/mcp/registry';
import { registryCaller } from '@/lib/server/mcp/identity';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ name: string }> };

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const gate = await registryCaller(request);
  if (!gate.ok) return gate.response;
  const found = getServerVersion(decodeURIComponent((await params).name), 'latest');
  return found ? json(found) : error('Server not found', 404);
});
