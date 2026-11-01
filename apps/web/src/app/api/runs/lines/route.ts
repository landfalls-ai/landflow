/**
 * GET /api/runs/lines?ids=<id>,<id>… → `{ lines }`: what each run did, in one line (lib/shared/run-line.ts, docs/run-trace.md#what-a-run-did-in-one-line),
 * by execution id: `in` (what came in: label, detail, kind), `by` (the lead or agent, the members who worked, the team),
 * `out` (what came out: label, detail, url, tone ok | warn | bad | live), status, ms, tokens. At most 20 ids; runs the
 * caller cannot read, and runs without a journal, are left out.
 */
import { error, handler, json } from '@/lib/server/http';
import { lineOf } from '@/lib/server/journal/runs-query';
import { visibleIds } from '@/lib/server/projects';
import { routeActor } from '@/lib/server/projects/http';
import { store } from '@/lib/server/store';
import type { RunLine } from '@/lib/shared/run-line';

export const dynamic = 'force-dynamic';

const MAX_IDS = 20;

export const GET = handler(async (request: Request) => {
  const ids = [...new Set((new URL(request.url).searchParams.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
  if (!ids.length) return error('Give the runs: ?ids=<executionId>,<executionId>', 400);
  if (ids.length > MAX_IDS) return error(`At most ${MAX_IDS} runs at a time`, 400);
  const visible = visibleIds(routeActor(), 'workflow', store.listWorkflows().map((w) => w.id));
  const lines: Record<string, RunLine> = {};
  for (const id of ids) {
    const record = store.getExecution(id);
    if (!record || (visible && !visible.has(record.workflowId))) continue;
    const line = lineOf(id);
    if (line) lines[id] = line;
  }
  return json({ lines });
});
