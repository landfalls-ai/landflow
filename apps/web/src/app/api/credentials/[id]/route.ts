import { z } from 'zod';
import { credentials } from '@/lib/server/credentials/vault';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { credentialRateLimitSchema } from '@/lib/server/schemas';
import { ownershipOf } from '@/lib/server/projects';
import { forgetDeleted, routeActor } from '@/lib/server/projects/http';
import { resourceCan } from '@/lib/shared/projects';
import type { CredentialDetail } from '@/lib/shared/types';
import { auditedChange } from '@/lib/server/audit';
import { getUser } from '@/lib/server/auth/users';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** The credential with the name of who last changed its data (`updatedByName`). */
function withChanger(credential: CredentialDetail): CredentialDetail {
  const changer = credential.updatedBy ? getUser(credential.updatedBy)?.name : undefined;
  return changer ? { ...credential, updatedByName: changer } : credential;
}

/**
 * Secret fields never leave the server; someone who can't edit the credential (shared to use, viewers) sees no fields at
 * all. `updatedByName` names who last changed its data, for the dialog's "Last changed by".
 */
export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const found = credentials.get((await params).id);
  if (!found) return error('Credential not found', 404);
  const credential = withChanger(found);
  const ownership = ownershipOf(routeActor(), 'credential', credential.id);
  return json({ credential: resourceCan(ownership.access, 'update') ? credential : { ...credential, data: {} }, ownership });
});

/**
 * PATCH { name?, data?, rateLimit? } — `data` holds only the fields to change (the others stay); empty secret fields keep
 * their saved value, null clears a field (and `rateLimit: null` takes the limit off). The caller becomes the last changer
 * only when a value actually changes (vault.ts update).
 */
export const PATCH = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, z.object({ name: z.string().max(120).optional(), data: z.record(z.string(), z.unknown()).optional(), rateLimit: credentialRateLimitSchema.nullable().optional() }));
  if (!body.ok) return body.response;
  const id = (await params).id;
  // Who changes its data is recorded ("Last changed by" in the credential dialog).
  const actor = routeActor().id;
  const before = credentials.get(id);
  // Which fields changed, never their values. Fail-closed audit records it first (the credentials file is no transaction).
  if (!before) return error('Credential not found', 404);
  const credential = auditedChange(
    (done) => ({ action: 'credential.update', target: { type: 'credential', id, ...((done?.name ?? before.name) && { name: (done?.name ?? before.name)! }) }, details: { credentialType: done?.type ?? before.type, renamed: body.data.name !== undefined, rateLimit: body.data.rateLimit === undefined ? undefined : body.data.rateLimit ?? null, fields: Object.keys(body.data.data ?? {}) } }),
    () => credentials.update(id, body.data, { actor }),
  );
  return json({ credential: withChanger(credential) });
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  const existing = credentials.get(id);
  if (!existing) return error('Credential not found', 404);
  const removed = auditedChange(
    () => ({ action: 'credential.delete', target: { type: 'credential', id, ...(existing.name && { name: existing.name }) }, details: { credentialType: existing.type } }),
    () => credentials.delete(id),
  );
  if (!removed) return error('Credential not found', 404);
  forgetDeleted('credential', id);
  return json({ ok: true });
});
