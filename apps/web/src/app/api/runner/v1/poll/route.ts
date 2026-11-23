/**
 * POST /api/runner/v1/poll { name?, version?, max? }: a network runner's long poll (C29, docs/network-runners.md). Public
 * path: the runner's own token (`Authorization: Bearer lf_run_…`) is the authentication, checked first (401 for none, a
 * wrong one, a revoked one or an address its list refuses, without saying which). Records that the runner is here, then
 * holds the request up to 25 s and answers `200 { id, request }` with the next call for its network, or `204`. `max: 0`
 * only says "here" (a runner at capacity keeps its presence). A revoked runner gets 401 within a second.
 */
import { handler, json, parseBody } from '@/lib/server/http';
import { claimCall, limits } from '@/lib/server/networks/calls';
import { pollSchema } from '@/lib/server/networks/schema';
import { authenticateRunner, markSeen } from '@/lib/server/networks/store';
import { clientAddress } from '@/lib/server/net/client-address';

export const dynamic = 'force-dynamic';

export const POST = handler(async (request: Request) => {
  const runner = authenticateRunner(request);
  if (!runner) return json({ error: 'Invalid runner token' }, 401);
  const body = await parseBody(request, pollSchema, { optional: true, maxBytes: 4_096 });
  if (!body.ok) return body.response;
  const seen = () => markSeen(runner.id, { version: body.data.version, address: clientAddress(request) });
  seen();
  if (body.data.max === 0) return new Response(null, { status: 204 });
  const claimed = await claimCall(runner, { waitMs: limits.pollWaitMs, signal: request.signal, onSeen: seen });
  return claimed ? json(claimed) : new Response(null, { status: 204 });
});
