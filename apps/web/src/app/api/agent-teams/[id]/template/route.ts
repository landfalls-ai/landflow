/**
 * POST /api/agent-teams/:id/template — "Save as template" on a team page (docs/templates.md#team-templates): `{ name,
 * description?, categories?, setup?, workflowId?, projectId? }`. The template holds the team, every Landflow agent in it
 * (published config) and its remote members' A2A addresses, and, with `workflowId`, that workflow (it must have a Run a
 * Team node set to this team; see GET /api/agent-teams/:id/flows). Credentials become slots, never secrets.
 */
import { currentPrincipal } from '@/lib/server/auth/guard';
import { agentTeamStore } from '@/lib/server/agent-teams/store';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { canResource } from '@/lib/server/projects';
import { store } from '@/lib/server/store';
import { saveTeamTemplate, saveTeamTemplateSchema } from '@/lib/server/templates';
import type { Workflow } from '@/lib/shared/types';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const team = agentTeamStore.get((await params).id);
  if (!team) return error('Agent team not found', 404);
  const body = await parseBody(request, saveTeamTemplateSchema);
  if (!body.ok) return body.response;
  const user = currentPrincipal()?.user;
  let workflow: Workflow | undefined;
  if (body.data.workflowId) {
    workflow = store.getWorkflow(body.data.workflowId) as Workflow | undefined;
    if (!workflow || (user && !canResource(user, 'workflow', workflow.id, 'read'))) return error('Workflow not found', 404);
  }
  return json({ template: saveTeamTemplate(body.data, team, workflow, user?.name || user?.email, user) }, 201);
});
