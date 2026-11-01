/** DELETE /api/agent-templates/:id — remove a saved template (editors of its project; owners and admins for instance-wide ones). */
import { agentTemplates, AgentTemplateError } from '@/lib/server/agents/templates';
import { error, handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const DELETE = handler(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  try {
    agentTemplates.remove(id, routeActor());
    return json({ ok: true });
  } catch (caught) {
    if (caught instanceof AgentTemplateError) return error(caught.message, caught.status);
    throw caught;
  }
});
