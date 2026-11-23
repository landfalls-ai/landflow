/**
 * Online evaluations of a standalone agent. GET — settings, recent scores (newest first), the 30-day trend and
 * totals. PUT — change the settings. POST { sessionId } — grade that session's latest turn now (sampling aside).
 */
import { z } from 'zod';
import { agentStore } from '@/lib/server/agents/store';
import { agentTarget, getOnlineConfig, gradeAgentSession, normalizeOnlineConfig, onlineReport, saveOnlineConfig } from '@/lib/server/evaluations';
import { onlineEvalConfigSchema } from '@/lib/server/evaluations/http';
import { canReadSessionById } from '@/lib/server/agents/session-scope';
import { isInstanceAdmin, resourceAccess } from '@/lib/server/projects/access';
import { routeActor } from '@/lib/server/projects/http';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/**
 * PC13: each score only for a session the viewer may read (a home member never reads another project's graded replies).
 * Instance owners and admins read every session, so they get no filter; for others each session is read once per call,
 * however many of its turns were graded (as `listAgentFeedback` does).
 */
const visibleTo = () => {
  const actor = routeActor();
  if (actor && isInstanceAdmin(actor)) return undefined;
  const seen = new Map<string, boolean>();
  return (score: { sessionId?: string }) => {
    if (!score.sessionId) return canReadSessionById(actor, undefined);
    if (!seen.has(score.sessionId)) seen.set(score.sessionId, canReadSessionById(actor, agentStore.getSession(score.sessionId)));
    return seen.get(score.sessionId)!;
  };
};

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!agentStore.get(id)) return error('Agent not found', 404);
  // PC06: the scores carry session inputs and outputs from every project; only the home reads them.
  if (!resourceAccess(routeActor(), 'agent', id)?.home) return error('Agent not found', 404);
  return json({ report: onlineReport(agentTarget(id), 50, visibleTo()) });
});

export const PUT = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!agentStore.get(id)) return error('Agent not found', 404);
  const body = await parseBody(request, onlineEvalConfigSchema);
  if (!body.ok) return body.response;
  const { model, ...rest } = body.data;
  const target = agentTarget(id);
  const current = getOnlineConfig(target);
  saveOnlineConfig(target, normalizeOnlineConfig({ ...rest, ...(model && { model }) }, model === null ? { ...current, model: undefined } : current));
  return json({ report: onlineReport(target, 50, visibleTo()) });
});

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = await parseBody(request, z.object({ sessionId: z.string().min(1) }));
  if (!body.ok) return body.response;
  // PC13: grading shows the session's input and output, so the session must be one the caller may read.
  const session = agentStore.getSession(body.data.sessionId);
  if (!session || session.agentId !== id || !canReadSessionById(routeActor(), session)) return error('Session not found', 404);
  try {
    return json({ score: await gradeAgentSession(id, body.data.sessionId) }, 201);
  } catch (caught) {
    const message = (caught as Error).message;
    return error(message, /not found/i.test(message) ? 404 : 400);
  }
});
