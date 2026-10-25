/**
 * The accept-invite page's API (public): GET /api/auth/invites/<token> names the invite (email, role, who sent
 * it), 404 when it is unknown, used or expired; POST { name, password } creates the account and signs it in.
 */
import { z } from 'zod';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@/lib/shared/auth';
import { clientIp, createUser, findToken, formLimit, getUser, markTokenUsed, signedInResponse, UserError } from '@/lib/server/auth';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ token: string }> };

const GONE = 'This invite link is invalid, was used already or has expired. Ask an admin for a new one.';

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const invite = findToken('invite', (await params).token);
  if (!invite) return error(GONE, 404);
  const invitedBy = invite.createdBy ? getUser(invite.createdBy)?.name : undefined;
  return json({ email: invite.email, role: invite.role ?? 'member', ...(invitedBy && { invitedBy }) });
});

const schema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(120),
  password: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`).max(MAX_PASSWORD_LENGTH),
});

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const ip = clientIp(request);
  const limit = formLimit();
  const check = limit.check(ip);
  if (!check.ok) return error('Too many attempts. Try again later.', 429, { retryAfter: check.retryAfter });
  limit.hit(ip);
  const invite = findToken('invite', (await params).token);
  if (!invite) return error(GONE, 404);
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;
  try {
    const user = await createUser({ email: invite.email, name: body.data.name, role: invite.role ?? 'member', password: body.data.password });
    markTokenUsed(invite.id);
    return signedInResponse(request, user, 'invite', {}, 201);
  } catch (caught) {
    if (caught instanceof UserError) return error(caught.message, caught.status);
    throw caught;
  }
});
