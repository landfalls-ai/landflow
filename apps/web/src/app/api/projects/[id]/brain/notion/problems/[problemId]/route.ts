/**
 * POST { action } — resolve a sync problem. Project editors act; `repair` and `deleteLocal` need an admin; an action the
 * problem's kind does not offer is a 400. `dismiss` works now; the others answer 409 until the pull (wave nb2) performs them.
 */
import { recordAudit } from '@/lib/server/audit';
import { SWITCHED_OFF, getLink, notionBrainEnabled, performProblemAction, problemById, problemActionsReady, resolveProblem } from '@/lib/server/brain/notion/links';
import { problemActionSchema } from '@/lib/server/brain/notion/schemas';
import { error, json, parseBody } from '@/lib/server/http';
import { projectRoute, requireProject, routeActor } from '@/lib/server/projects/http';
import { ADMIN_PROBLEM_ACTIONS, PROBLEM_KIND_ACTIONS } from '@/lib/shared/notion-brain';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; problemId: string }> };

export const POST = projectRoute(async (request: Request, { params }: Ctx) => {
  const actor = routeActor();
  const { id, problemId } = await params;
  const project = requireProject(actor, id, 'edit');
  const body = await parseBody(request, problemActionSchema);
  if (!body.ok) return body.response;
  const link = getLink(project.id);
  const problem = problemById(problemId);
  if (!link || !problem || problem.link_id !== link.id) return error('Problem not found', 404);
  if (problem.resolved_at) return error('That problem is resolved already', 409);
  const { action } = body.data;
  if (action !== 'dismiss' && !PROBLEM_KIND_ACTIONS[problem.kind].includes(action)) return error(`“${action}” is not offered for this problem`, 400);
  if (ADMIN_PROBLEM_ACTIONS.includes(action)) requireProject(actor, id, 'manage');
  if (action !== 'dismiss') {
    if (!notionBrainEnabled()) return error(SWITCHED_OFF, 409);
    if (!problemActionsReady()) return error('Not available yet', 409);
    await performProblemAction({ link, problem, action, actorId: actor.id });
  }
  const resolved = resolveProblem(problem.id, actor.id, action) ?? problem;
  recordAudit({
    action: 'notion-brain.problem',
    target: { type: 'project', id: project.id, name: project.name },
    summary: `Resolved a Notion sync problem of “${project.name}”`,
    details: { linkId: link.id, problemId: problem.id, kind: problem.kind, resolution: action },
  });
  return json({ id: resolved.id, resolved: true, action, by: resolved.resolved_by, at: resolved.resolved_at });
});
