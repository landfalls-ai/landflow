/**
 * POST /api/brain/work { events: WorkEventInput[1..50] } — record the caller's own work (docs/work-and-briefings.md).
 * Answers `{ saved: [{ sourceId, id, created }], rejected: [{ sourceId, reason }] }`: an event that fails the checks is
 * rejected with its reason and the others are saved. The same `source` and `sourceId` again updates the event. Needs the
 * `brain:write` scope (or a session). Private to the caller: nobody else reads it, an admin included.
 */
import { z } from 'zod';
import { recordWork, MAX_WORK_EVENTS } from '@/lib/server/brain/work';
import { handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

const body = z.object({ events: z.array(z.unknown()).min(1, 'Send at least one event').max(MAX_WORK_EVENTS, `At most ${MAX_WORK_EVENTS} events at a time`) });

export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, body);
  if (!parsed.ok) return parsed.response;
  return json(recordWork(routeActor(), parsed.data.events));
});
