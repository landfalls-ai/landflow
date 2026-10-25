/**
 * Settings → External secrets: GET the providers (settings without secret values, and the secret names each lists),
 * the provider kinds and their fields, the cache TTL and the environment; POST `{ name, kind, enabled?, settings }`
 * adds a provider. Credential fields read its secrets as `{{ $secrets.<name>.<secret> }}`.
 */
import { z } from 'zod';
import type { SecretProvidersResponse } from '@/lib/shared/secrets';
import { SECRET_PROVIDER_KINDS } from '@/lib/shared/secrets';
import { currentEnvironment } from '@/lib/server/environments/settings';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { cacheTtlSeconds, externalSecrets, providerKinds, SecretsError } from '@/lib/server/secrets';

export const dynamic = 'force-dynamic';

const providerSettingsSchema = z.record(z.string(), z.union([z.string().max(20_000), z.number(), z.null()]));

export const GET = handler(async () => {
  const environment = currentEnvironment();
  const body: SecretProvidersResponse = { providers: externalSecrets.list(), kinds: providerKinds(), cacheTtlSeconds: cacheTtlSeconds(), ...(environment && { environment }) };
  return json(body);
});

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, z.strictObject({ name: z.string().max(64), kind: z.enum(SECRET_PROVIDER_KINDS), enabled: z.boolean().optional(), settings: providerSettingsSchema.default({}) }));
  if (!body.ok) return body.response;
  try {
    return json(externalSecrets.create(body.data), 201);
  } catch (caught) {
    if (caught instanceof SecretsError) return error(caught.message, caught.status);
    throw caught;
  }
});
