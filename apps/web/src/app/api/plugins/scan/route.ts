import { z } from 'zod';
import { registry } from '@/lib/server/plugins/registry';
import { handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const scanSchema = z.object({
  hosts: z.array(z.string().regex(/^[\w.-]+$/)).max(16).optional(),
  ports: z.array(z.number().int().min(1).max(65535)).max(2048).optional(),
});

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, scanSchema, { optional: true });
  if (!body.ok) return body.response;
  const result = await registry.scan(body.data);
  return json({ ...result, plugins: registry.list() });
});
