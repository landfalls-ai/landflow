/**
 * POST /api/external-secrets/:name/test — connect and list the secret names. With `{ kind?, settings }` (the form's
 * values over the saved ones) an unsaved configuration is tested and nothing is stored; otherwise the saved
 * provider is, and its names and result are kept. → SecretProviderCheck (never values).
 */
import { z } from 'zod';
import { SECRET_PROVIDER_KINDS } from '@/lib/shared/secrets';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { externalSecrets, SecretsError } from '@/lib/server/secrets';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ name: string }> };

const bodySchema = z.strictObject({ kind: z.enum(SECRET_PROVIDER_KINDS).optional(), settings: z.record(z.string(), z.union([z.string().max(20_000), z.number(), z.null()])).optional() });

export const POST = handler(async (request: Request, { params }: Ctx) => {
  // No body: test the saved provider.
  const body = request.headers.get('content-length') === '0' || !request.body ? { ok: true as const, data: {} } : await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  try {
    return json(await externalSecrets.test((await params).name, body.data.kind || body.data.settings ? body.data : undefined));
  } catch (caught) {
    if (caught instanceof SecretsError) return error(caught.message, caught.status);
    throw caught;
  }
});
