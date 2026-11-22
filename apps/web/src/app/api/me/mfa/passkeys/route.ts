/**
 * POST /api/me/mfa/passkeys { challenge, name, response } (a signed-in person, session only; open to a session that may
 * only enrol): finish adding a passkey with the browser's answer to the options from POST /api/me/mfa/passkeys/options.
 * The challenge works once and only for this person; origin and relying party must be the instance's public URL
 * (LANDFLOW_PUBLIC_URL). Answers 201 with the new factor, plus ten recovery codes (shown once) when it is the person's
 * first second factor; 400 when the answer does not verify or the request expired; 409 for a passkey that is already
 * registered or at ten passkeys.
 */
import { z } from 'zod';
import { requireUser } from '@/lib/server/auth';
import { attestationSchema, finishRegistration } from '@/lib/server/auth/mfa';
import { handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const schema = z.object({ challenge: z.string().min(1).max(100), name: z.string().trim().min(1, 'Name your passkey').max(60), response: attestationSchema });

export const POST = handler(async (request: Request) => {
  const user = await requireUser();
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;
  const done = await finishRegistration(user, body.data.challenge, body.data.name, body.data.response);
  return json(done, { status: 201, headers: { 'cache-control': 'no-store' } });
});
