/**
 * A workflow's own governance policy (lib/server/governance/scopes.ts): four-eyes publishing even when the instance
 * doesn't ask for it, and a node allow-list stricter than its project's and the instance's.
 * GET — `{ policy, canEdit, instanceFourEyes, project? }` (anyone who sees the workflow).
 * PUT { fourEyes?, nodes?: { mode?, plugins?, types? } } — admins of the workflow's project (and instance owners and
 * admins): editors can't loosen what governs their own publishing.
 */
import { recordAudit } from '@/lib/server/audit';
import { getGovernancePolicy } from '@/lib/server/governance/policy';
import { getProjectSettings, getWorkflowPolicy, updateWorkflowPolicy, workflowPolicyPatchSchema } from '@/lib/server/governance/scopes';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { canResource, getProject, homeProjectId } from '@/lib/server/projects';
import { routeActor } from '@/lib/server/projects/http';
import { store } from '@/lib/server/store';
import { DEFAULT_WORKFLOW_POLICY, type WorkflowPolicyView } from '@/lib/shared/project-policy';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

function view(workflowId: string, canEdit: boolean): WorkflowPolicyView {
  const projectId = homeProjectId('workflow', workflowId);
  const project = projectId ? getProject(projectId) : undefined;
  const settings = getProjectSettings(projectId);
  return {
    policy: getWorkflowPolicy(workflowId) ?? structuredClone(DEFAULT_WORKFLOW_POLICY),
    canEdit,
    instanceFourEyes: getGovernancePolicy().fourEyes.enabled,
    ...(project && { project: { id: project.id, name: project.name, nodes: settings.nodes } }),
  };
}

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!store.getWorkflow(id)) return error('Workflow not found', 404);
  return json(view(id, canResource(routeActor(), 'workflow', id, 'move')));
});

export const PUT = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const workflow = store.getWorkflow(id);
  if (!workflow) return error('Workflow not found', 404);
  const actor = routeActor();
  if (!canResource(actor, 'workflow', id, 'move')) return error('Only admins of the workflow’s project can change its policy', 403);
  const body = await parseBody(request, workflowPolicyPatchSchema);
  if (!body.ok) return body.response;
  const policy = updateWorkflowPolicy(id, body.data, actor.id);
  recordAudit({
    action: 'workflow.policy.update',
    target: { type: 'workflow', id, name: workflow.name },
    summary: `Changed the governance policy of “${workflow.name}”`,
    details: { fourEyes: policy.fourEyes, nodesMode: policy.nodes.mode, plugins: policy.nodes.plugins, nodeTypes: policy.nodes.types },
  });
  return json(view(id, true));
});
