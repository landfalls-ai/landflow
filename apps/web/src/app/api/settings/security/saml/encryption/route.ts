/**
 * /api/settings/security/saml/encryption (owners and admins): the SP's key for encrypted SAML assertions
 * (lib/server/auth/saml-keys.ts). GET the certificate (never the key); POST `{ action: 'generate' }` for a new key pair
 * or `{ action: 'upload', cert, key, passphrase? }` (PEM, RSA); PATCH `{ required }` to refuse unencrypted assertions;
 * DELETE to remove the keys. The IdP needs the certificate (from our metadata) to encrypt to it. Changes are audited.
 *
 * Key rotation with two certificates: `generate` and `upload` take `slot: 'next'` to stage a second pair that the
 * metadata publishes beside the current one (responses decrypt with either); `{ action: 'switch' }` makes it the
 * current pair (the old key stays as `previous`, decrypt-only); `{ action: 'discard', slot: 'next' | 'previous' }`
 * drops one.
 */
import { z } from 'zod';
import { recordAudit } from '@/lib/server/audit';
import { requireUser } from '@/lib/server/auth';
import { publicOrigin } from '@/lib/server/auth/cookies';
import {
  discardSamlEncryptionKey,
  generateSamlEncryptionKey,
  removeSamlEncryptionKey,
  SamlKeyError,
  samlEncryptionView,
  setSamlEncryptionRequired,
  switchSamlEncryptionKey,
  uploadSamlEncryptionKey,
} from '@/lib/server/auth/saml-keys';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const TARGET = { type: 'settings', id: 'saml-encryption', name: 'SAML assertion encryption' };

const slot = z.enum(['current', 'next']).optional();
const postSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('generate'), slot }),
  z.object({ action: z.literal('upload'), slot, cert: z.string().min(1).max(50_000), key: z.string().min(1).max(20_000), passphrase: z.string().max(500).optional() }),
  z.object({ action: z.literal('switch') }),
  z.object({ action: z.literal('discard'), slot: z.enum(['next', 'previous']) }),
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
  const before = samlEncryptionView();
  const failed = await attempt(() => {
    if (input.action === 'generate') return generateSamlEncryptionKey(`Landflow SAML ${new URL(publicOrigin(request)).host}`, me.id, input.slot);
    if (input.action === 'upload') return uploadSamlEncryptionKey({ cert: input.cert, key: input.key, passphrase: input.passphrase }, me.id, input.slot);
    if (input.action === 'switch') return switchSamlEncryptionKey();
    return discardSamlEncryptionKey(input.slot);
  });
  if (failed) return failed;
  const view = samlEncryptionView();
  const next = input.action !== 'switch' && input.action !== 'discard' && input.slot === 'next';
  const summary = {
    generate: next ? 'Generated the next SAML decryption key (published beside the current one)' : 'Generated a new SAML decryption key',
    upload: next ? 'Uploaded the next SAML decryption key (published beside the current one)' : 'Uploaded a SAML decryption key',
    switch: 'Switched the SAML decryption key over to the next one',
    discard: `Discarded the ${input.action === 'discard' ? input.slot : ''} SAML decryption key`,
  }[input.action];
  recordAudit({
    action: 'settings.update',
    target: TARGET,
    summary,
    details: {
      source: view.source,
      fingerprint: view.fingerprint,
      validTo: view.validTo,
      ...(input.action !== 'generate' && input.action !== 'upload' ? {} : { slot: input.slot ?? 'current' }),
      ...(view.next && { nextFingerprint: view.next.fingerprint }),
      ...(input.action === 'switch' && { retiredFingerprint: before.fingerprint }),
    },
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
