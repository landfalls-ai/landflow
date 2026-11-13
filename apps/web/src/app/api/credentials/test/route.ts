import { z } from 'zod';
import { recordAudit } from '@/lib/server/audit';
import { CredentialError, credentials } from '@/lib/server/credentials/vault';
import { registry } from '@/lib/server/plugins/registry';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { redactValue, resolveCredentialData, SecretsError } from '@/lib/server/secrets';
import { requireResource } from '@/lib/server/projects';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

/** POST { type, data, id? } — with `id`, saved secrets fill in the fields the form left empty. */
export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, z.object({ type: z.string().min(3), data: z.record(z.string(), z.unknown()).default({}), id: z.string().optional() }));
  if (!body.ok) return body.response;
  try {
    // Testing a saved credential sends its secrets to the plugin: only for those who may edit it.
    if (body.data.id) requireResource(routeActor(), 'credential', body.data.id, 'update');
    const started = Date.now();
    // An OAuth2 credential is tested with a token that hasn't expired.
    if (body.data.id) await credentials.refreshOAuth2(body.data.id);
    // `$secrets` in the fields resolve like they do for a node; the plugin's answer is redacted.
    const data = await resolveCredentialData(credentials.testData(body.data.type, body.data.data, body.data.id));
    const audit = (ok: boolean, extra: Record<string, unknown> = {}) =>
      recordAudit({ action: 'credential.test', outcome: ok ? 'success' : 'failure', target: { type: 'credential', ...(body.data.id && { id: body.data.id }), name: body.data.type }, summary: `Tested a ${body.data.type} credential`, details: { type: body.data.type, ...(body.data.id && { credentialId: body.data.id }), ok, ...extra } });
    // From here the secrets were sent to the plugin: a test that throws is recorded too (its message is not).
    let result;
    try {
      result = redactValue(await registry.testCredentials(body.data.type, data));
    } catch (caught) {
      audit(false, { error: caught instanceof Error ? caught.name : 'error' });
      throw caught;
    }
    audit(result.ok !== false);
    return json({ ...result, durationMs: Date.now() - started });
  } catch (caught) {
    if (caught instanceof CredentialError) return error(caught.message, caught.status);
    if (caught instanceof SecretsError) return json({ ok: false, message: caught.message });
    throw caught;
  }
});
