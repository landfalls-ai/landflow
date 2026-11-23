/**
 * GET /api/brain/briefing?day=YYYY-MM-DD — the caller's own day (docs/work-and-briefings.md): their work of that day and
 * the day before, newest first, in the instance time zone (today by default). Needs `brain:read` (`brain:write` includes it).
 */
import { z } from 'zod';
import { briefingFor } from '@/lib/server/brain/briefing';
import { handler, json, parseQuery } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

const query = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'day is YYYY-MM-DD').optional() });

export const GET = handler(async (request: Request) => {
  const parsed = parseQuery(request, query);
  if (!parsed.ok) return parsed.response;
  return json(briefingFor(routeActor(), { day: parsed.data.day }));
});
