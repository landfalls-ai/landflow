import { z } from 'zod';
import { harnessSessions } from '@/lib/server/harness/list';
import { handler, json, parseQuery } from '@/lib/server/http';
import { pageSchema } from '@/lib/server/pagination';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

const query = pageSchema.extend({ agentId: z.string().max(100).optional(), open: z.enum(['1', 'true', '0', 'false']).optional() });

/**
 * GET /api/harness/sessions?agentId=&open=1&limit=&cursor=: the harness sessions the caller may see, newest first, paged with a
 * keyset cursor (`{ sessions, nextCursor? }`). A person's own sessions are theirs alone, an admin's included; the sessions
 * of a Landflow agent go to those who may read the agent. `open=1` leaves out the closed ones. Needs `executions:read` for a key.
 */
export const GET = handler(async (request: Request) => {
  const parsed = parseQuery(request, query);
  if (!parsed.ok) return parsed.response;
  const { limit, cursor, agentId, open } = parsed.data;
  return json(harnessSessions(routeActor(), { limit, cursor, agentId, open: open === '1' || open === 'true' }));
});
