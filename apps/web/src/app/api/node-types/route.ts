import { registry } from '@/lib/server/plugins/registry';
import { getGovernancePolicy, scopeFor, scopedNodeBlocked } from '@/lib/server/governance/policy';
import { handler, json } from '@/lib/server/http';
import { canResource, projectRole } from '@/lib/server/projects';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

/**
 * Every node type; those the governance policy blocks carry `blocked` (the reason), so the node creator can hide them.
 * `?workflowId=` (the workflow being edited) or `?projectId=` also applies that project's (and workflow's) allow-lists.
 */
export const GET = handler(async (request: Request) => {
  const params = new URL(request.url).searchParams;
  const actor = routeActor();
  const workflowId = params.get('workflowId') ?? undefined;
  const projectId = params.get('projectId') ?? undefined;
  const scope = scopeFor(
    workflowId && canResource(actor, 'workflow', workflowId, 'read') ? { workflowId } : projectId && projectRole(actor, projectId) ? { projectId } : undefined,
  );
  const policy = getGovernancePolicy();
  return json({
    nodeTypes: registry.nodeTypes().map((info) => {
      const blocked = scopedNodeBlocked(info.type, policy, scope);
      return blocked ? { ...info, blocked: blocked.message } : info;
    }),
  });
});
