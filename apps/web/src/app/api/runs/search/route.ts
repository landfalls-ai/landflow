/**
 * GET /api/runs/search → `{ items, more, truncated? }`: saved runs matching every filter given, newest first, only those of
 * workflows the caller sees (lib/server/journal/runs-query.ts, docs/run-trace.md). Filters: `text` (words in span names,
 * inputs and outputs, messages, artifacts, checks), `workflowId`, `actor` (name or id), `tool`, `status`,
 * `failedSteps=true`, `failedCheck` (a check that failed, by name; empty for any), `from` and `to` (ISO or YYYY-MM-DD),
 * `limit` (≤ 100, default 20) and `offset`. Each item: executionId, workflowId, workflowName, status, startedAt,
 * durationMs, matches, and with a journal filter failedSteps and failedChecks.
 */
import { handler, json } from '@/lib/server/http';
import { searchRuns } from '@/lib/server/journal/runs-query';
import { visibleIds } from '@/lib/server/projects';
import { routeActor } from '@/lib/server/projects/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const q = new URL(request.url).searchParams;
  const flag = (key: string) => ['1', 'true', 'yes'].includes((q.get(key) ?? '').toLowerCase());
  const visible = visibleIds(routeActor(), 'workflow', store.listWorkflows().map((w) => w.id));
  return json(
    searchRuns(
      {
        text: q.get('text') ?? undefined,
        workflowId: q.get('workflowId') ?? undefined,
        actor: q.get('actor') ?? undefined,
        tool: q.get('tool') ?? undefined,
        status: q.get('status') ?? undefined,
        failedSteps: flag('failedSteps'),
        failedCheck: q.has('failedCheck') ? (q.get('failedCheck') ?? '') : undefined,
        from: q.get('from') ?? undefined,
        to: q.get('to') ?? undefined,
        limit: q.has('limit') ? Number(q.get('limit')) : undefined,
        offset: q.has('offset') ? Number(q.get('offset')) : undefined,
      },
      visible,
    ),
  );
});
