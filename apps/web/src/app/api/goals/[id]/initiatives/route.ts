/** PUT /api/goals/:id/initiatives { ids } — replace the brain initiatives a goal links (each one the caller may read; 400 names the others). */
import { initiativesSchema } from '@/lib/server/goals/schema';
import { goalView, setInitiativesAs } from '@/lib/server/goals/views';
import { handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const PUT = handler(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const body = await parseBody(request, initiativesSchema);
  if (!body.ok) return body.response;
  const actor = routeActor();
  return json({ goal: goalView(actor, setInitiativesAs(actor, (await params).id, body.data.ids)) });
});
