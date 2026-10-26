/**
 * GET /api/audit/export?format=csv|json — the events matching the same filters as GET /api/audit, newest first, as a
 * download (CSV with one column per field, or a JSON array; at most 100,000 events). The export itself is audited (in
 * the exported project's log, when one is chosen). Owners and admins export every event, project admins their
 * projects'; API keys need the `audit:read` scope.
 */
import { recordAudit } from '@/lib/server/audit';
import { requireUser } from '@/lib/server/auth';
import { auditFiltersFor } from '@/lib/server/audit/access';
import { exportStream } from '@/lib/server/audit/export';
import { filtersFrom } from '@/lib/server/audit/query';
import { error, handler } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const me = await requireUser();
  const params = new URL(request.url).searchParams;
  const format = params.get('format') === 'json' ? 'json' : 'csv';
  const scoped = auditFiltersFor(me, filtersFrom(params));
  if (!scoped.ok) return error(scoped.message, 403);
  const { filters } = scoped;
  // Recorded before the stream starts, so the export lists itself only when it is newer than the filter's end.
  recordAudit({
    action: 'audit.export',
    target: { type: 'audit_log', ...(filters.projectId && { id: filters.projectId }) },
    project: filters.projectId ?? null,
    summary: `Exported the audit log as ${format.toUpperCase()}`,
    details: { format, ...filters, action: filters.action?.join(','), projectIds: undefined, ...(filters.projectIds && { projects: filters.projectIds.length }) },
  });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return new Response(exportStream(format, filters), {
    headers: {
      'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="landflow-audit-${stamp}.${format}"`,
      'cache-control': 'no-store',
    },
  });
});
