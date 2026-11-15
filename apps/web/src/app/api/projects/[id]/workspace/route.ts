/**
 * GET /api/projects/:id/workspace — the project's workspace for harness runs (any role; setup commands only for editors and admins).
 * PUT { repos, worktree, branchTemplate } — save it (the project's admins). Landflow never runs a setup command (docs/projects-and-goals.md#workspace).
 */
import { z } from 'zod';
import { SETUP_LINES_MAX } from '@/lib/shared/project-workspace';
import { json, parseBody } from '@/lib/server/http';
import { projectRoute, routeActor } from '@/lib/server/projects/http';
import { saveWorkspace, workspaceView } from '@/lib/server/projects/workspace';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

// The shape only; the limits and their messages are checked in saveWorkspace.
const bodySchema = z.object({
  repos: z.record(z.string().max(200), z.object({ defaultBranch: z.string().max(300).optional(), setup: z.array(z.string().max(2000)).max(SETUP_LINES_MAX * 20).optional() })),
  worktree: z.enum(['per-run', 'shared']),
  branchTemplate: z.string().max(1000),
});

export const GET = projectRoute(async (_request: Request, { params }: Ctx) => json(workspaceView(routeActor(), (await params).id)));

export const PUT = projectRoute(async (request: Request, { params }: Ctx) => {
  const actor = routeActor();
  const id = (await params).id;
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  return json(saveWorkspace(actor, id, body.data));
});
