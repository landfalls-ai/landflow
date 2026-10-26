import { nanoid } from 'nanoid';
import type { Workflow } from '@landflow/engine';
import { handler, json, parseBody } from '@/lib/server/http';
import { withOwnership } from '@/lib/server/projects';
import { createInProject, projectParam, routeActor } from '@/lib/server/projects/http';
import { workflowSchema } from '@/lib/server/schemas';
import { store } from '@/lib/server/store';
import { currentActorId } from '@/lib/server/auth/context';
import { governedSave } from '@/lib/server/governance/saves';

export const dynamic = 'force-dynamic';

/** GET ?projectId= — the workflows the caller sees (owned by or shared with that project), each with its `ownership`. */
export const GET = handler(async (request: Request) => {
  const workflows = withOwnership(routeActor(), 'workflow', store.workflowSummaries(), projectParam(request));
  const stats = store.stats();
  return json({ workflows, stats: { ...stats, workflows: workflows.length, activeWorkflows: workflows.filter((w) => w.active).length } });
});

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, workflowSchema);
  if (!body.ok) return body.response;
  const id = body.data.id && !store.getWorkflow(body.data.id) ? body.data.id : `wf_${nanoid(10)}`;
  // ?projectId= puts it in a project (the caller must be an editor there), a folderId in the folder's; else the caller's personal project.
  // Governance: a new active workflow may need approval first, and nodes the policy doesn't allow come back as warnings.
  let extras = {};
  const workflow = createInProject(request, 'workflow', () => {
    const saved = governedSave({ ...body.data, id } as Workflow, undefined, (w) => store.saveWorkflow(w), { by: currentActorId() });
    extras = saved.extras;
    return saved.workflow;
  }, (w) => w.id, { folderId: body.data.folderId, id });
  return json({ workflow, ...extras }, 201);
});
