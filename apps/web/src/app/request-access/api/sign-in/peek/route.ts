/**
 * POST /request-access/api/sign-in/peek { token } (public): whose sign-in link is this? Answers `{ email }` with the address masked
 * (`m•••@partner.test`) so the page can say "Continue as …" before it posts the token to /verify; the link is not used up. Same answer as /verify for a
 * link that is unknown, used or expired (400), and the same limit (20 wrong tries from one network address in 15 minutes, then 429).
 */
import { z } from 'zod';
import { OutsideAuthError, peekLink } from '@/lib/server/access/outside/identity';
import { outsidePublic, tooMany, outsideClientIp } from '@/lib/server/access/outside/http';
import { json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const schema = z.object({ token: z.string().min(1).max(200) });

export const POST = outsidePublic(
  async ({ req }) => {
    const body = await parseBody(req, schema, { maxBytes: 2048 });
    if (!body.ok) return body.response;
    try {
      return json(await peekLink(body.data.token, { ip: outsideClientIp(req) }));
    } catch (error) {
      if (error instanceof OutsideAuthError && error.reason === 'limited') return tooMany(error.message, Number(error.details?.retryAfter) || 60);
      throw error;
    }
  },
  { write: true },
);
