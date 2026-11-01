/**
 * GET /api/brain/workflows/:id — what the second brain knows about one workflow: its profile, the facts about it and its
 * open suggestions (the editor's side card). Access is the workflow's.
 */
import type { WorkflowKnowledge } from '@/lib/shared/brain';
import { getProfile, listFacts } from '@/lib/server/brain/facts';
import { listProposals } from '@/lib/server/brain/proposals';
import { error, handler, json } from '@/lib/server/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  if (!store.getWorkflow(id)) return error('Workflow not found', 404);
  const knowledge: WorkflowKnowledge = {
    profile: getProfile('workflow', id),
    facts: listFacts({ subjectType: 'workflow', subjectId: id, limit: 50 }),
    proposals: listProposals({ workflowId: id, status: 'open', limit: 20 }),
  };
  return json(knowledge);
});
