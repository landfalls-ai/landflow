import { z } from 'zod';
import { registry } from '@/lib/server/plugins/registry';
import { handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json({ plugins: registry.list() }));

/** Manually register an endpoint (http(s):// or grpc://). */
export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, z.object({ endpoint: z.string().min(3) }));
  if (!body.ok) return body.response;
  const entry = await registry.addEndpoint(body.data.endpoint, 'manual');
  return json({ pluginId: entry.id, plugins: registry.list() }, 201);
});
