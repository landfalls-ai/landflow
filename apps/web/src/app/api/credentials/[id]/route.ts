import { z } from 'zod';
import { CredentialError, credentials } from '@/lib/server/credentials/vault';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const credential = credentials.get((await params).id);
  return credential ? json({ credential }) : error('Credential not found', 404);
});

/** PATCH { name?, data? } — empty secret fields keep their saved value, null clears a field. */
export const PATCH = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, z.object({ name: z.string().max(120).optional(), data: z.record(z.string(), z.unknown()).optional() }));
  if (!body.ok) return body.response;
  try {
    return json({ credential: credentials.update((await params).id, body.data) });
  } catch (caught) {
    if (caught instanceof CredentialError) return error(caught.message, caught.status);
    throw caught;
  }
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) =>
  credentials.delete((await params).id) ? json({ ok: true }) : error('Credential not found', 404),
);
