/**
 * Online evaluations of a standalone agent. GET — settings, recent scores (newest first), the 30-day trend and
 * totals. PUT — change the settings. POST { sessionId } — grade that session's latest turn now (sampling aside).
 */
import { z } from 'zod';
import { agentStore } from '@/lib/server/agents/store';
import { agentTarget, getOnlineConfig, gradeAgentSession, normalizeOnlineConfig, onlineReport, saveOnlineConfig } from '@/lib/server/evaluations';
import { onlineEvalConfigSchema } from '@/lib/server/evaluations/http';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!agentStore.get(id)) return error('Agent not found', 404);
  return json({ report: onlineReport(agentTarget(id)) });
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
  return json({ report: onlineReport(target) });
});

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = await parseBody(request, z.object({ sessionId: z.string().min(1) }));
  if (!body.ok) return body.response;
  try {
    return json({ score: await gradeAgentSession(id, body.data.sessionId) }, 201);
  } catch (caught) {
    const message = (caught as Error).message;
    return error(message, /not found/i.test(message) ? 404 : 400);
  }
});
