/**
 * GET /api/audit — the audit log, newest first: `?actor=` (a user id, or part of a name or email), `action=`
 * (comma-separated; `workflow.*` for a category), `targetType=`, `targetId=`, `projectId=` (the project of the
 * event's target), `outcome=` (success, failure, denied), `from=` / `to=` (ISO times or dates), `q=` (text),
 * `limit=` (1–500, default 50) and `cursor=` (the previous page's `nextCursor`). Owners and admins read every event,
 * project admins their projects' (lib/server/audit/access.ts); API keys need the `audit:read` scope.
 */
import { requireUser } from '@/lib/server/auth';
import { auditFiltersFor } from '@/lib/server/audit/access';
import { filtersFrom } from '@/lib/server/audit/query';
import { queryEvents } from '@/lib/server/audit/store';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const me = await requireUser();
  const params = new URL(request.url).searchParams;
  const scoped = auditFiltersFor(me, filtersFrom(params));
  if (!scoped.ok) return error(scoped.message, 403);
  const limit = Math.max(1, Math.min(Number(params.get('limit')) || 50, 500));
  return json(queryEvents(scoped.filters, { limit, cursor: params.get('cursor') ?? undefined }));
});
