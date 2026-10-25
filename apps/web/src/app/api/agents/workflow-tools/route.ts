/** Workflows an agent can call: those that start with "When Called by a Workflow or Agent". */
import { workflowToolInfo } from '@/lib/server/agents/tools';
import { handler, json } from '@/lib/server/http';
import { filterVisible } from '@/lib/server/projects';
import { routeActor } from '@/lib/server/projects/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const workflows = filterVisible(routeActor(), 'workflow', store.listWorkflows()).map((workflow) => {
    const info = workflowToolInfo(workflow.id);
    return {
      id: workflow.id,
      name: workflow.name,
      ...(workflow.description && { description: workflow.description }),
      eligible: info.eligible,
      ...(!info.eligible && { reason: info.reason }),
    };
  });
  workflows.sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.name.localeCompare(b.name));
  return json({ workflows });
});
