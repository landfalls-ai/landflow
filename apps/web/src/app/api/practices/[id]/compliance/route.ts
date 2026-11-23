import { handler, json, parseQuery } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';
import { complianceOf } from '@/lib/server/practices/compliance';
import { complianceQuery } from '@/lib/server/practices/compliance-schema';
import { PracticeError } from '@/lib/server/practices/errors';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** GET ?days= (1 to 90, default 30) — how often the practice was given, cited, passed, failed and waived, and who follows it. 404 when the caller may not see the practice. */
export const GET = handler(async (request: Request, { params }: Ctx) => {
  const query = parseQuery(request, complianceQuery);
  if (!query.ok) return query.response;
  const compliance = complianceOf(routeActor(), (await params).id, query.data.days);
  if (!compliance) throw new PracticeError('Practice not found', 404);
  return json({ compliance });
});
