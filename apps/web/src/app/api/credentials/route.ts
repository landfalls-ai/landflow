import { z } from 'zod';
import type { JsonObject } from '@landflow/protocol';
import { CredentialError, credentials } from '@/lib/server/credentials/vault';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json({ credentials: credentials.list() }));

/** POST { name, type, data } */
export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, z.object({ name: z.string().max(120).default(''), type: z.string().min(3), data: z.record(z.string(), z.unknown()).default({}) }));
  if (!body.ok) return body.response;
  try {
    return json({ credential: credentials.create({ ...body.data, data: body.data.data as JsonObject }) }, 201);
  } catch (caught) {
    if (caught instanceof CredentialError) return error(caught.message, caught.status);
    throw caught;
  }
});
