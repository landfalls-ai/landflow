/**
 * Settings → External secrets: GET the providers (settings without secret values, and the secret names each lists),
 * the provider kinds and their fields, the cache TTL, the environment and whether node parameters may read
 * `$secrets`; POST `{ name, kind, enabled?, settings }` adds a provider; PATCH `{ allowInParameters }` changes the
 * instance setting (owners and admins). Credential fields read its secrets as `{{ $secrets.<name>.<secret> }}`.
 */
import { z } from 'zod';
import type { SecretProvidersResponse } from '@/lib/shared/secrets';
import { SECRET_PROVIDER_KINDS } from '@/lib/shared/secrets';
import { recordAudit } from '@/lib/server/audit';
import { currentEnvironment } from '@/lib/server/environments/settings';
import { handler, json, parseBody } from '@/lib/server/http';
import { cacheTtlSeconds, externalSecrets, providerKinds, readSecretsSettings, writeSecretsSettings } from '@/lib/server/secrets';

export const dynamic = 'force-dynamic';

const providerSettingsSchema = z.record(z.string(), z.union([z.string().max(20_000), z.number(), z.null()]));

export const GET = handler(async () => {
  const environment = currentEnvironment();
  const body: SecretProvidersResponse = {
    providers: externalSecrets.list(),
    kinds: providerKinds(),
    cacheTtlSeconds: cacheTtlSeconds(),
    allowInParameters: readSecretsSettings().allowInParameters,
    ...(environment && { environment }),
  };
  return json(body);
});

export const PATCH = handler(async (request: Request) => {
  const body = await parseBody(request, z.strictObject({ allowInParameters: z.boolean() }));
  if (!body.ok) return body.response;
  const settings = writeSecretsSettings(body.data);
  recordAudit({ action: 'settings.update', target: { type: 'settings', id: 'external-secrets', name: 'External secrets' }, details: { fields: Object.keys(body.data), ...body.data } });
  return json(settings);
});

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, z.strictObject({ name: z.string().max(64), kind: z.enum(SECRET_PROVIDER_KINDS), enabled: z.boolean().optional(), settings: providerSettingsSchema.default({}) }));
  if (!body.ok) return body.response;
  return json(externalSecrets.create(body.data), 201);
});
