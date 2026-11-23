/**
 * GET /api/runs/compare?a=<executionId>&b=<executionId> → `{ a, b, delta, actors }`: two runs side by side, each folded
 * from its journal (lib/shared/run-compare.ts): duration, tokens in and out, cost, model calls, steps, failed steps,
 * checks (pass, fail, warn), the failed checks' names, artifacts, and per actor the same numbers. `delta` is b minus a;
 * `actors` has one entry per actor of either run with both sides and the difference.
 */
import { compareRuns } from '@/lib/shared/run-compare';
import { error, handler, json } from '@/lib/server/http';
import { digestOf } from '@/lib/server/journal/runs-query';
import { visibleIds } from '@/lib/server/projects';
import { routeActor } from '@/lib/server/projects/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const q = new URL(request.url).searchParams;
  const a = q.get('a')?.trim();
  const b = q.get('b')?.trim();
  if (!a || !b) return error('Give two runs: ?a=<executionId>&b=<executionId>', 400);
  const visible = visibleIds(routeActor(), 'workflow', store.listWorkflows().map((w) => w.id));
  const digests = await Promise.all(
    [a, b].map(async (id) => {
      const digest = await digestOf(id);
      return digest && (!visible || (digest.workflowId && visible.has(digest.workflowId))) ? digest : undefined;
    }),
  );
  if (!digests[0]) return error(`Run ${a} not found`, 404);
  if (!digests[1]) return error(`Run ${b} not found`, 404);
  return json(compareRuns(digests[0], digests[1]));
});
