import { z } from 'zod';
import { CredentialError, credentials } from '@/lib/server/credentials/vault';
import { registry } from '@/lib/server/plugins/registry';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

/** POST { type, data, id? } — with `id`, saved secrets fill in the fields the form left empty. */
export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, z.object({ type: z.string().min(3), data: z.record(z.string(), z.unknown()).default({}), id: z.string().optional() }));
  if (!body.ok) return body.response;
  try {
    const started = Date.now();
    const result = await registry.testCredentials(body.data.type, credentials.testData(body.data.type, body.data.data, body.data.id));
    return json({ ...result, durationMs: Date.now() - started });
  } catch (caught) {
    if (caught instanceof CredentialError) return error(caught.message, caught.status);
    throw caught;
  }
});
