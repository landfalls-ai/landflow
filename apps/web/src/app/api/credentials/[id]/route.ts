import { z } from 'zod';
import { CredentialError, credentials } from '@/lib/server/credentials/vault';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { credentialRateLimitSchema } from '@/lib/server/schemas';
import { ownershipOf } from '@/lib/server/projects';
import { forgetDeleted, routeActor } from '@/lib/server/projects/http';
import { resourceCan } from '@/lib/shared/projects';
import { auditedChange } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Secret fields never leave the server; someone who can't edit the credential (shared to use, viewers) sees no fields at all. */
export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const credential = credentials.get((await params).id);
  if (!credential) return error('Credential not found', 404);
  const ownership = ownershipOf(routeActor(), 'credential', credential.id);
  return json({ credential: resourceCan(ownership.access, 'update') ? credential : { ...credential, data: {} }, ownership });
});

/** PATCH { name?, data?, rateLimit? } — empty secret fields keep their saved value, null clears a field (and `rateLimit: null` takes the limit off). */
export const PATCH = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, z.object({ name: z.string().max(120).optional(), data: z.record(z.string(), z.unknown()).optional(), rateLimit: credentialRateLimitSchema.nullable().optional() }));
  if (!body.ok) return body.response;
  try {
    const id = (await params).id;
    const before = credentials.get(id);
    // Which fields changed, never their values. Fail-closed audit records it first (the credentials file is no transaction).
    if (!before) return json({ credential: credentials.update(id, body.data) }); // throws the 404
    const credential = auditedChange(
      (done) => ({ action: 'credential.update', target: { type: 'credential', id, ...((done?.name ?? before?.name) && { name: (done?.name ?? before?.name)! }) }, details: { credentialType: done?.type ?? before?.type, renamed: body.data.name !== undefined, rateLimit: body.data.rateLimit === undefined ? undefined : body.data.rateLimit ?? null, fields: Object.keys(body.data.data ?? {}) } }),
      () => credentials.update(id, body.data),
    );
    return json({ credential });
  } catch (caught) {
    if (caught instanceof CredentialError) return error(caught.message, caught.status);
    throw caught;
  }
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
