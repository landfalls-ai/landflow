/**
 * POST /api/runner/v1/calls/:id: the claiming runner's answer to one call, `{ status, headers, body? }` or `{ error: { code,
 * message } }` (C29). Public path with the runner's own token; 404 for a call the runner didn't claim or that was
 * answered already. Bodies are base64 and up to 10 MiB, so the cap is above the usual JSON one.
 */
import { handler, json, parseBody } from '@/lib/server/http';
import { completeCall } from '@/lib/server/networks/calls';
import { answerSchema } from '@/lib/server/networks/schema';
import { authenticateRunner, markSeen } from '@/lib/server/networks/store';
import { clientAddress } from '@/lib/server/net/client-address';

export const dynamic = 'force-dynamic';

const MAX_ANSWER_BYTES = 15 * 1024 * 1024;

export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const runner = authenticateRunner(request);
  if (!runner) return json({ error: 'Invalid runner token' }, 401);
  const body = await parseBody(request, answerSchema, { maxBytes: MAX_ANSWER_BYTES });
  if (!body.ok) return body.response;
  const { id } = await context.params;
  markSeen(runner.id, { address: clientAddress(request) });
  await completeCall(runner, id, body.data);
  return new Response(null, { status: 204 });
});
