/**
 * GET /api/workflows/:id/evaluations — the workflow's evaluation runs (newest first), its Evaluation Trigger's
 * Data Table and whether it sets metrics. POST — start an evaluation run over the table (it goes on in the
 * background; poll GET …/evaluations/:runId). The body may carry the editor's unsaved workflow and a row limit.
 */
import { z } from 'zod';
import type { Workflow } from '@landflow/engine';
import { EvaluationError, evaluationsOverview, startEvaluation } from '@/lib/server/evaluations';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { workflowSchema } from '@/lib/server/schemas';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const startSchema = z.object({
  workflow: workflowSchema.optional(),
  maxRows: z.number().int().min(1).max(1_000).optional(),
});

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  const workflow = store.getWorkflow(id);
  if (!workflow) return error('Workflow not found', 404);
  return json(evaluationsOverview(workflow));
});

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const saved = store.getWorkflow(id);
  if (!saved) return error('Workflow not found', 404);
  const body = request.headers.get('content-length') === '0' ? { ok: true as const, data: {} } : await parseBody(request, startSchema);
  if (!body.ok) return body.response;
  const workflow = (body.data.workflow ? { ...saved, ...body.data.workflow, id } : saved) as Workflow;
  try {
    return json({ run: startEvaluation(id, { workflow, ...(body.data.maxRows && { maxRows: body.data.maxRows }) }) }, 201);
  } catch (caught) {
    if (caught instanceof EvaluationError) return error(caught.message, caught.status);
    throw caught;
  }
});
