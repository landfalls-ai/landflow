import { handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';
import { PracticeError } from '@/lib/server/practices/errors';
import { waivePractice } from '@/lib/server/practices/approve';
import { waiverSchema } from '@/lib/server/practices/schema';
import { visiblePractice } from '@/lib/server/practices/views';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** POST — waive the practice for one run, with a reason (someone who may approve it). A second waiver of the run returns the first. */
export const POST = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, waiverSchema);
  if (!body.ok) return body.response;
  const actor = routeActor();
  const { id } = await params;
  if (!visiblePractice(actor, id)) throw new PracticeError('Practice not found', 404);
  return json({ application: waivePractice(actor, id, body.data) }, 201);
});
