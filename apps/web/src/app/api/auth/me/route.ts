/**
 * GET /api/auth/me: who is calling, and how (a session or an API key, with its scopes). PATCH { name } (signed-in
 * users) renames yourself; PATCH { currentPassword, newPassword } changes your password.
 */
import { z } from 'zod';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@/lib/shared/auth';
import { currentPrincipal, requireUser, setPassword, updateUser, verifyPassword, viewerOf } from '@/lib/server/auth';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const user = await requireUser();
  const principal = currentPrincipal();
  return json({ user: viewerOf(user), via: principal?.via ?? 'session', ...(principal?.apiKey && { apiKey: principal.apiKey }) });
});

const patchSchema = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  currentPassword: z.string().max(1024).optional(),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`).max(MAX_PASSWORD_LENGTH).optional(),
});

export const PATCH = handler(async (request: Request) => {
  let user = await requireUser();
  const body = await parseBody(request, patchSchema);
  if (!body.ok) return body.response;
  if (body.data.newPassword) {
    if (user.passwordHash && !(await verifyPassword(body.data.currentPassword ?? '', user.passwordHash))) return error('Your current password is wrong', 403);
    user = await setPassword(user.id, body.data.newPassword);
  }
  if (body.data.name) user = updateUser(user.id, { name: body.data.name });
  return json({ user: viewerOf(user) });
});
