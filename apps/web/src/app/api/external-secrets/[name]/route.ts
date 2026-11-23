/**
 * One external secrets provider: GET it (no secret values), PATCH `{ enabled?, settings? }` (a secret setting left
 * empty keeps its value, `null` clears a setting), DELETE it. Credentials that reference it fail until it is back.
 */
import { z } from 'zod';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { externalSecrets } from '@/lib/server/secrets';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ name: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const provider = externalSecrets.get((await params).name);
  return provider ? json(provider) : error('Provider not found', 404);
});

export const PATCH = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, z.strictObject({ enabled: z.boolean().optional(), settings: z.record(z.string(), z.union([z.string().max(20_000), z.number(), z.null()])).optional() }));
  if (!body.ok) return body.response;
  return json(externalSecrets.update((await params).name, body.data));
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => (externalSecrets.delete((await params).name) ? json({ ok: true }) : error('Provider not found', 404)));
