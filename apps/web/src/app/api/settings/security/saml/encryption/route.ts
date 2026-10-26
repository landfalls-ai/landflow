/**
 * /api/settings/security/saml/encryption (owners and admins): the SP's key for encrypted SAML assertions
 * (lib/server/auth/saml-keys.ts). GET the certificate (never the key); POST `{ action: 'generate' }` for a new key pair
 * or `{ action: 'upload', cert, key, passphrase? }` (PEM, RSA); PATCH `{ required }` to refuse unencrypted assertions;
 * DELETE to remove the key. The IdP needs the certificate (from our metadata) to encrypt to it. Changes are audited.
 */
import { z } from 'zod';
import { recordAudit } from '@/lib/server/audit';
import { requireUser } from '@/lib/server/auth';
import { publicOrigin } from '@/lib/server/auth/cookies';
import { generateSamlEncryptionKey, removeSamlEncryptionKey, SamlKeyError, samlEncryptionView, setSamlEncryptionRequired, uploadSamlEncryptionKey } from '@/lib/server/auth/saml-keys';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const TARGET = { type: 'settings', id: 'saml-encryption', name: 'SAML assertion encryption' };

const postSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('generate') }),
  z.object({ action: z.literal('upload'), cert: z.string().min(1).max(50_000), key: z.string().min(1).max(20_000), passphrase: z.string().max(500).optional() }),
]);
const patchSchema = z.object({ required: z.boolean() });

/** Key errors are the caller's (400); anything else is ours. */
async function attempt(fn: () => unknown): Promise<Response | undefined> {
  try {
    await fn();
    return undefined;
  } catch (caught) {
    if (caught instanceof SamlKeyError) return error(caught.message, 400);
    throw caught;
  }
}

export const GET = handler(async () => {
  await requireUser('settings:manage');
  return json(samlEncryptionView());
});

export const POST = handler(async (request: Request) => {
  const me = await requireUser('settings:manage');
  const body = await parseBody(request, postSchema);
  if (!body.ok) return body.response;
  const input = body.data;
  const failed = await attempt(() =>
    input.action === 'generate' ? generateSamlEncryptionKey(`Landflow SAML ${new URL(publicOrigin(request)).host}`, me.id) : uploadSamlEncryptionKey({ cert: input.cert, key: input.key, passphrase: input.passphrase }, me.id),
  );
  if (failed) return failed;
  const view = samlEncryptionView();
  recordAudit({
    action: 'settings.update',
    target: TARGET,
    summary: input.action === 'generate' ? 'Generated a new SAML decryption key' : 'Uploaded a SAML decryption key',
    details: { source: view.source, fingerprint: view.fingerprint, validTo: view.validTo },
  });
  return json(view);
});

export const PATCH = handler(async (request: Request) => {
  await requireUser('settings:manage');
  const body = await parseBody(request, patchSchema);
  if (!body.ok) return body.response;
  const failed = await attempt(() => setSamlEncryptionRequired(body.data.required));
  if (failed) return failed;
  recordAudit({ action: 'settings.update', target: TARGET, summary: body.data.required ? 'Required encrypted SAML assertions' : 'Stopped requiring encrypted SAML assertions', details: { required: body.data.required } });
  return json(samlEncryptionView());
});

export const DELETE = handler(async () => {
  await requireUser('settings:manage');
  const before = samlEncryptionView();
  const failed = await attempt(() => removeSamlEncryptionKey());
  if (failed) return failed;
  recordAudit({ action: 'settings.update', target: TARGET, summary: 'Removed the SAML decryption key', details: { fingerprint: before.fingerprint } });
  return json(samlEncryptionView());
});
