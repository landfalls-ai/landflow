/**
 * GET /api/agents/:id/context-preview?projectId= — what a chat with the agent in that project would be given: the project
 * block (in the agent's mode) and the approved practices. Without `projectId`, the agent's home project. Nothing is recorded.
 * Editors of the agent see it, because it shows the project's brief (docs/projects-and-goals.md#testing-an-agent-in-a-project).
 */
import { z } from 'zod';
import { agentStore } from '@/lib/server/agents/store';
import { error, handler, json, parseQuery } from '@/lib/server/http';
import { projectRole, requireResource } from '@/lib/server/projects/access';
import { routeActor } from '@/lib/server/projects/http';
import { getProject, homeProjectId, shares } from '@/lib/server/projects/store';
import { runPractices, type PracticesSwitch } from '@/lib/server/project-context/practices';
import { runContextProvider } from '@/lib/server/project-context/seam';
import type { ContextMode, RunPractice } from '@/lib/shared/project-context';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export interface ContextPreview {
  projectId?: string;
  mode: ContextMode;
  text: string;
  compact: string;
  practices: { text: string; list: RunPractice[] };
}

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const agent = agentStore.get(id);
  if (!agent) return error('Agent not found', 404);
  const actor = routeActor();
  // The preview shows the home project's brief: editors only (a 'user' share may use the agent, not read it).
  requireResource(actor, 'agent', id, 'update');
  const query = parseQuery(request, z.object({ projectId: z.string().max(200).optional() }));
  if (!query.ok) return query.response;
  const home = homeProjectId('agent', id);
  const projectId = query.data.projectId || home;
  if (query.data.projectId) {
    // A project the person has no role in, or one the agent is not available in, is not found.
    const available = projectId === home || shares('agent', id).some((s) => s.projectId === projectId || s.projectId === '*');
    if (!getProject(projectId!) || !projectRole(actor, projectId) || !available) return error('Project not found', 404);
  }
  const mode: ContextMode = agent.projectContext ?? 'full';
  let ctx: ReturnType<NonNullable<ReturnType<typeof runContextProvider>>['build']> | undefined;
  try {
    ctx = runContextProvider()?.build({ caller: 'chat', agentId: id, ...(projectId && { projectId }) }, mode);
  } catch {
    // A run goes on without the block when the builder throws; the preview says the same.
  }
  // PC07: AgentConfig.practices comes from PR06.
  const practices = runPractices((agent as { practices?: PracticesSwitch }).practices, { ...(projectId && { projectId }), agentId: id, size: 'full' });
  return json({
    ...(projectId && { projectId }),
    mode: ctx?.mode ?? mode,
    text: ctx?.text ?? '',
    compact: ctx?.compact ?? '',
    practices: { text: practices.text, list: practices.practices },
  } satisfies ContextPreview);
});
