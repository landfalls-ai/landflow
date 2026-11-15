import { handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';
import { PracticeError } from '@/lib/server/practices/errors';
import { approvePractice } from '@/lib/server/practices/approve';
import { approveSchema } from '@/lib/server/practices/schema';
import { getPractice, versionsOf } from '@/lib/server/practices/store';
import { viewOf, visiblePractice } from '@/lib/server/practices/views';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** POST — approve a version (a person, never an API key). A tainted version needs `reviewedSources`; each overlap needs an answer. */
export const POST = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, approveSchema);
  if (!body.ok) return body.response;
  const actor = routeActor();
  const { id } = await params;
  if (!visiblePractice(actor, id)) throw new PracticeError('Practice not found', 404);
  approvePractice(actor, id, body.data);
  return json({ practice: viewOf(actor, getPractice(id)!, versionsOf(id)) });
});
