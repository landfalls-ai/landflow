/**
 * The Run Trace journal of an execution (lib/server/journal, docs/run-trace.md).
 *
 * GET /api/executions/:id/events?after=<seq>&limit=<n ≤ 2000> → `{ events, last, more }`: the events with a seq above
 * `after` (default 0), in order; `last` is the highest seq in this page (`after` when empty); `more` says there is a next page.
 * A run recorded before Run Trace (within the retention) gets its journal rebuilt from its run data the first time it is read.
 */
import { z } from 'zod';
import { error, handler, json, parseQuery } from '@/lib/server/http';
import { limitParam } from '@/lib/server/pagination';
import { journalStore, rebuildJournal } from '@/lib/server/journal';
import { liveExecution } from '@/lib/server/runner';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const MAX_LIMIT = 2000;
const DEFAULT_LIMIT = 500;

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const record = liveExecution(id) ? undefined : await store.loadExecution(id);
  if (!record && !liveExecution(id)) return error('Execution not found', 404);
  const query = parseQuery(request, z.object({ after: z.coerce.number().int().min(0).default(0), limit: limitParam(MAX_LIMIT, DEFAULT_LIMIT) }));
  if (!query.ok) return query.response;
  const { after, limit } = query.data;
  if (record && after === 0) rebuildJournal(record, record.workflow ?? store.getWorkflow(record.workflowId));
  // One more than asked tells whether another page follows.
  const rows = await journalStore.readEventsAsync(id, after, limit + 1);
  const events = rows.slice(0, limit);
  return json({ events, last: events.at(-1)?.seq ?? after, more: rows.length > limit });
});
