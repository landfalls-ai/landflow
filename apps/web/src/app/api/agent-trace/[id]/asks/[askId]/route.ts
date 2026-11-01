import { askAnswer } from '@/lib/server/a2a/agent-asks';
import { TRACE_ID } from '@/lib/server/a2a/agent-trace';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

/**
 * GET /api/agent-trace/:id/asks/:askId?wait=<seconds>: a person's answer to a command the landflow-harness mod asked about
 * (lib/server/a2a/agent-asks.ts, docs/a2a.md). → `{ decision: 'pending' | 'approved' | 'denied', by?, at?, expired? }`. Public like
 * the trace route: the trace id is the credential. `wait` (up to 30) holds the request until a person decides, so the mod's
 * polling is a long poll. `denied` with `expired` means nobody answered in time or the call ended. An ask the run has not
 * stored yet (queue mode: the post is still on its way to the process that holds the trace) is pending.
 */
export const GET = handler(async (request: Request, { params }: { params: Promise<{ id: string; askId: string }> }) => {
  const { id, askId } = await params;
  if (!TRACE_ID.test(id) || !/^[A-Za-z0-9_-]{1,64}$/.test(askId)) return error('Not found', 404);
  const wait = Number(new URL(request.url).searchParams.get('wait') ?? 0);
  const answer = await askAnswer(id, askId, Number.isFinite(wait) ? wait : 0);
  return json(answer ?? { decision: 'pending' });
});
