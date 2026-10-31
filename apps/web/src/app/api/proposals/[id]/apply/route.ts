/**
 * POST /api/proposals/:id/apply — apply a suggestion on the server: its changes are checked against the workflow as it is
 * now and saved through governance, a draft becomes a new workflow (in `?projectId=`, else the caller's), persona rules go
 * to the agent's draft, and a missing tool is approved for the workflows that build it (On Usage Event on proposal.applied).
 * Returns `{ proposal, workflow?, warnings, started? }`; 409 when the changes no longer fit.
 */
import type { Workflow } from '@/lib/shared/types';
import { applyProposal, getProposal, ProposalError } from '@/lib/server/brain/proposals';
import { canProposal } from '@/lib/server/brain/scope';
import { error, handler, json } from '@/lib/server/http';
import { createIn, routeActor, targetProject } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const actor = routeActor();
  const proposal = getProposal(id);
  if (!proposal || !canProposal(actor, proposal, 'read')) return error('Suggestion not found', 404);
  // A draft creates a workflow, which any builder may; changing a workflow or agent needs edit access to it.
  if (!proposal.draft && !canProposal(actor, proposal, 'update')) return error('You can’t change what this suggestion is about', 403);
  const projectId = proposal.draft ? targetProject(request) : undefined;
  try {
    const result = applyProposal(id, {
      actorId: actor.id,
      createWorkflow: (save, workflowId) => createIn(projectId, 'workflow', save, (w: Workflow) => w.id, workflowId),
    });
    return json(result);
  } catch (caught) {
    if (caught instanceof ProposalError) return error(caught.message, caught.status);
    throw caught;
  }
});
