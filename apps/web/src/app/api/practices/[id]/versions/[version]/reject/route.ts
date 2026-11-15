import { handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';
import { PracticeError } from '@/lib/server/practices/errors';
import { rejectVersion } from '@/lib/server/practices/approve';
import { rejectSchema } from '@/lib/server/practices/schema';
import { versionsOf } from '@/lib/server/practices/store';
import { viewOf, visiblePractice } from '@/lib/server/practices/views';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; version: string }> };

/** POST { reason } — reject a version waiting for approval (the reason is 10 to 500 characters). */
export const POST = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, rejectSchema);
  if (!body.ok) return body.response;
  const actor = routeActor();
  const { id, version } = await params;
  if (!visiblePractice(actor, id)) throw new PracticeError('Practice not found', 404);
  const practice = rejectVersion(actor, id, Number(version), body.data.reason);
  return json({ practice: viewOf(actor, practice, versionsOf(id)) });
});
