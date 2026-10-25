import { z } from 'zod';
import { registry } from '@/lib/server/plugins/registry';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** PATCH { preferredTransport: 'http' | 'grpc' | null } */
export const PATCH = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, z.object({ preferredTransport: z.enum(['http', 'grpc']).nullable() }));
  if (!body.ok) return body.response;
  registry.setPreferredTransport((await params).id, body.data.preferredTransport ?? undefined);
  return json({ plugins: registry.list() });
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) =>
  registry.remove((await params).id) ? json({ ok: true }) : error('Plugin not found or built-in', 404),
);
