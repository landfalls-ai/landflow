/** GET /api/mcp/registry/v0.1/servers/<name>/versions/<version>: one version (`latest` for the newest). */
import { error, handler, json } from '@/lib/server/http';
import { getServerVersion } from '@/lib/server/mcp/registry';
import { registryCaller } from '@/lib/server/mcp/identity';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ name: string; version: string }> };

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const gate = await registryCaller(request);
  if (!gate.ok) return gate.response;
  const { name, version } = await params;
  const found = getServerVersion(decodeURIComponent(name), decodeURIComponent(version));
  return found ? json(found) : error('Server version not found', 404);
});
