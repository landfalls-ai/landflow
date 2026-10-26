/** GET /.well-known/mcp/server-card.json: the instance's Server Card (SEP-2127): the gateway URL, how to sign in, the plugins behind it. Same callers as `tools/list`. */
import { handler, json } from '@/lib/server/http';
import { registryCaller } from '@/lib/server/mcp/identity';
import { instanceServerCard } from '@/lib/server/mcp/registry';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const gate = await registryCaller(request);
  if (!gate.ok) return gate.response;
  return json(instanceServerCard(gate.caller), { headers: { 'cache-control': 'private, no-store' } });
});
