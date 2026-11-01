/**
 * POST /api/brain/run { what: detect|study|effects|all } — run the second brain now instead of waiting for its hour (owners
 * and admins). Waits for the run: `detect` and `effects` take a moment, `study` asks the model about each changed workflow.
 */
import { z } from 'zod';
import { runBrain } from '@/lib/server/brain';
import { handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const Body = z.object({ what: z.enum(['detect', 'study', 'effects', 'all']).default('detect') });

export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  return json(await runBrain(parsed.data.what));
});
