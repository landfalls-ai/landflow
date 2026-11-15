import { error, handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';
import { PracticeError } from '@/lib/server/practices/errors';
import { patchSchema } from '@/lib/server/practices/schema';
import { storePort } from '@/lib/server/practices/register';
import { routeOrigin, versionsOf } from '@/lib/server/practices/store';
import { detailView, visiblePractice } from '@/lib/server/practices/views';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** GET — the practice with its versions (each with its state), the latest applications and the conflicts of its newest draft. */
export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const detail = detailView(routeActor(), (await params).id);
  return detail ? json(detail) : error('Practice not found', 404);
});

/** PATCH — a new draft version made from the newest version plus the changes. The approved one stays what agents get. */
export const PATCH = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, patchSchema);
  if (!body.ok) return body.response;
  const actor = routeActor();
  const practice = visiblePractice(actor, (await params).id);
  if (!practice) throw new PracticeError('Practice not found', 404);
  const newest = versionsOf(practice.id)[0]!;
  const changes = body.data;
  const input = {
    practiceId: practice.id,
    handle: practice.handle,
    level: practice.level,
    ...(practice.projectId && { projectId: practice.projectId }),
    title: changes.title ?? newest.title,
    strength: changes.strength ?? newest.strength,
    topics: changes.topics ?? newest.topics,
    repos: changes.repos ?? newest.repos,
    paths: changes.paths ?? newest.paths,
    summary: changes.summary ?? newest.summary,
    body: changes.body ?? newest.body,
    checks: changes.checks ?? newest.checks,
    citations: changes.citations ?? newest.citations.map(({ verified: _verified, ...rest }) => rest),
  };
  return json(storePort.draft(input, routeOrigin(input.citations.length)), 201);
});
