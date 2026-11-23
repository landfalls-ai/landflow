import { handler, json, parseQuery } from '@/lib/server/http';
import { decodeCursor, encodeCursor } from '@/lib/server/pagination';
import { routeActor } from '@/lib/server/projects/http';
import { PracticeError } from '@/lib/server/practices/errors';
import { canApprove } from '@/lib/server/practices/approve';
import { applicationsQuery } from '@/lib/server/practices/schema';
import { applicationsOf } from '@/lib/server/practices/store';
import { viewApplications, visiblePractice } from '@/lib/server/practices/views';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** GET ?limit=&cursor= — where the practice was delivered, cited, checked or waived, newest first. */
export const GET = handler(async (request: Request, { params }: Ctx) => {
  const query = parseQuery(request, applicationsQuery);
  if (!query.ok) return query.response;
  const actor = routeActor();
  const practice = visiblePractice(actor, (await params).id);
  if (!practice) throw new PracticeError('Practice not found', 404);
  const page = applicationsOf(practice.id, query.data.limit, query.data.cursor ? decodeCursor(query.data.cursor) : undefined);
  return json({ applications: viewApplications(canApprove(actor, practice), page.applications), ...(page.next && { nextCursor: encodeCursor(page.next) }) });
});
