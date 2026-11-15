import { handler, json, parseBody, parseQuery } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';
import { routeOrigin } from '@/lib/server/practices/store';
import { listQuery, draftSchema } from '@/lib/server/practices/schema';
import { storePort } from '@/lib/server/practices/register';
import { listView } from '@/lib/server/practices/views';

export const dynamic = 'force-dynamic';

/** GET ?status=&level=&projectId=&topic=&q= — the practices the caller may see (drafts and approved by default). */
export const GET = handler(async (request: Request) => {
  const query = parseQuery(request, listQuery);
  if (!query.ok) return query.response;
  return json(listView(routeActor(), query.data));
});

/** POST — a new practice, as a draft: a person's own typing is theirs, anything else is tainted. */
export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, draftSchema);
  if (!body.ok) return body.response;
  routeActor();
  const { practice, version } = storePort.draft(body.data, routeOrigin(body.data.citations?.length ?? 0));
  return json({ practice, version }, 201);
});
