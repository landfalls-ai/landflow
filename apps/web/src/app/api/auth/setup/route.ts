/**
 * POST /api/auth/setup { name, email, password } (public): create the owner, only while there is no user yet, and
 * sign them in. 409 once setup is done.
 */
import { z } from 'zod';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@/lib/shared/auth';
import { clientIp, createOwner, formLimit, signedInResponse, UserError } from '@/lib/server/auth';
import { error, handler, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const schema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(120),
  email: z.string().trim().email('Enter a valid email address').max(320),
  password: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`).max(MAX_PASSWORD_LENGTH),
});

export const POST = handler(async (request: Request) => {
  const limit = formLimit();
  const ip = clientIp(request);
  const check = limit.check(ip);
  if (!check.ok) return error('Too many attempts. Try again later.', 429, { retryAfter: check.retryAfter });
  limit.hit(ip);
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;
  try {
    const owner = await createOwner(body.data);
    return signedInResponse(request, owner, 'setup', {}, 201);
  } catch (caught) {
    if (caught instanceof UserError) return error(caught.message, caught.status);
    throw caught;
  }
});
