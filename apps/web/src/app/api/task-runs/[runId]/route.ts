/**
 * A project task's run (docs/projects-and-goals.md#tasks).
 * GET — `{ run }` for any role in the run's project, settled against its session first.
 * POST { decision: 'approve' | 'deny' } — editors and admins, signed in (not an API key: policy `sessionOnly`). Only a
 * `requested` run is decided (else 409 `Already <status>`); approve re-checks the agent and the project's rules (409, the run
 * stays `requested`), answers 202 and starts the agent in the background; deny answers 200.
 */
import { handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';
import { decisionSchema } from '@/lib/server/tasks/schema';
import { decide, readRun } from '@/lib/server/tasks/run';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ runId: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => json({ run: readRun(routeActor(), (await params).runId) }));

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { runId } = await params;
  const body = await parseBody(request, decisionSchema);
  if (!body.ok) return body.response;
  const run = decide(routeActor(), runId, body.data.decision);
  return json({ run }, { status: body.data.decision === 'approve' ? 202 : 200 });
});
