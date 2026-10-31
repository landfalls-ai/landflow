/**
 * The Run Trace journal of an execution (lib/server/journal, docs/run-trace.md).
 *
 * GET /api/executions/:id/events?after=<seq>&limit=<n ≤ 2000> → `{ events, last, more }`: the events with a seq above
 * `after` (default 0), in order; `last` is the highest seq in this page (`after` when empty); `more` says there is a next page.
 * A run recorded before Run Trace (within the retention) gets its journal rebuilt from its run data the first time it is read.
 */
import { error, handler, json } from '@/lib/server/http';
import { journalStore, rebuildJournal } from '@/lib/server/journal';
import { liveExecution } from '@/lib/server/runner';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const MAX_LIMIT = 2000;
const DEFAULT_LIMIT = 500;

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const record = liveExecution(id) ? undefined : store.getExecution(id);
  if (!record && !liveExecution(id)) return error('Execution not found', 404);
  const url = new URL(request.url);
  const after = Math.max(0, Math.floor(Number(url.searchParams.get('after') ?? 0)) || 0);
  if (record && after === 0) rebuildJournal(record, record.workflow ?? store.getWorkflow(record.workflowId));
  const asked = Math.floor(Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT));
  const limit = Math.min(MAX_LIMIT, Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_LIMIT);
  // One more than asked tells whether another page follows.
  const rows = journalStore.read(id, after, limit + 1);
  const events = rows.slice(0, limit);
  return json({ events, last: events.at(-1)?.seq ?? after, more: rows.length > limit });
});
