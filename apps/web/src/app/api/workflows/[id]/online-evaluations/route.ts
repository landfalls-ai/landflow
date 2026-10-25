/**
 * GET /api/workflows/:id/online-evaluations — the workflow's AI Agent nodes, each with its online grading
 * settings, recent scores and trend. PUT { nodeId, …settings } — change one node's settings.
 */
import { z } from 'zod';
import { getOnlineConfig, nodeTarget, normalizeOnlineConfig, onlineReport, saveOnlineConfig, workflowOnlineEvals } from '@/lib/server/evaluations';
import { onlineEvalConfigSchema } from '@/lib/server/evaluations/http';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const putSchema = onlineEvalConfigSchema.extend({ nodeId: z.string().min(1) });

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const workflow = store.getWorkflow((await params).id);
  return workflow ? json(workflowOnlineEvals(workflow)) : error('Workflow not found', 404);
});

export const PUT = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const workflow = store.getWorkflow(id);
  if (!workflow) return error('Workflow not found', 404);
  const body = await parseBody(request, putSchema);
  if (!body.ok) return body.response;
  const { nodeId, model, ...rest } = body.data;
  if (!workflow.nodes.some((node) => node.id === nodeId && node.type === 'core.aiAgent')) return error('No AI Agent node with that id', 404);
  const target = nodeTarget(id, nodeId);
  const current = getOnlineConfig(target);
  const next = normalizeOnlineConfig({ ...rest, ...(model !== undefined && { model: model ?? undefined }) }, model === null ? { ...current, model: undefined } : current);
  saveOnlineConfig(target, next);
  return json({ report: onlineReport(target, 20) });
});
