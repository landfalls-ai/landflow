/**
 * GET /api/audit — the audit log, newest first: `?actor=` (a user id, or part of a name or email), `action=`
 * (comma-separated; `workflow.*` for a category), `targetType=`, `targetId=`, `outcome=` (success, failure,
 * denied), `from=` / `to=` (ISO times or dates), `q=` (text), `limit=` (1–500, default 50) and `cursor=` (the
 * previous page's `nextCursor`). Owners and admins; API keys need the `audit:read` scope.
 */
import { filtersFrom } from '@/lib/server/audit/query';
import { queryEvents } from '@/lib/server/audit/store';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const params = new URL(request.url).searchParams;
  const limit = Math.max(1, Math.min(Number(params.get('limit')) || 50, 500));
  return json(queryEvents(filtersFrom(params), { limit, cursor: params.get('cursor') ?? undefined }));
});
