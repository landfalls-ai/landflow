/**
 * The branch of a run as GitHub sees it (lib/server/run-changes.ts, docs/run-trace.md#artifacts-and-code-changes).
 *
 * GET /api/executions/:id/changes → `{ available: true, repository: { owner, repo, url }, branch: { base, head, aheadBy,
 * behindBy, totalCommits, url, files: [{ path, status, additions, deletions, patch? }], truncated, note? }, fetchedAt }`,
 * or `{ available: false, reason }` when the run names no repository or branch, has no GitHub credential to read it with, or
 * GitHub refuses. The comparison is made by the GitHub plugin's Repository → Compare with the flow's own credential, and kept
 * per run for 10 minutes (15 seconds while the run is live). Same access as `GET /api/executions/:id`.
 */
import { error, handler, json } from '@/lib/server/http';
import { runBranchChanges } from '@/lib/server/run-changes';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  const reply = await runBranchChanges(id);
  return reply ? json(reply) : error('Execution not found', 404);
});
