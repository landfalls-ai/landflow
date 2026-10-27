/**
 * The schedule of a workflow's evaluation (Evaluations tab): a cron that starts an evaluation run by itself, evaluated by
 * the leader in queue mode.
 *
 * GET → { schedule?, nextRun? }; PUT { enabled, cron, timezone?, maxRows? } — set it; DELETE — remove it.
 */
import { z } from 'zod';
import type { EvaluationSchedule } from '@/lib/shared/evaluations';
import { checkSchedule, nextRun } from '@/lib/server/evaluations';
import { getSettings, saveSettings } from '@/lib/server/evaluations/store';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  enabled: z.boolean(),
  cron: z.string().trim().min(1).max(200),
  timezone: z.string().trim().max(100).optional(),
  maxRows: z.number().int().min(1).max(1_000).optional(),
});

const view = (workflowId: string) => {
  const schedule = getSettings(workflowId).schedule;
  const workflow = store.getWorkflow(workflowId);
  return { ...(schedule && { schedule, ...(schedule.enabled && { nextRun: nextRun(schedule, new Date(), workflow?.settings?.timezone?.trim() || undefined) }) }) };
};

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!store.getWorkflow(id)) return error('Workflow not found', 404);
  return json(view(id));
});

export const PUT = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!store.getWorkflow(id)) return error('Workflow not found', 404);
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  const problem = checkSchedule(body.data);
  if (problem) return error(problem, 400);
  const settings = getSettings(id);
  const { lastRunAt, lastRunId } = settings.schedule ?? ({} as Partial<EvaluationSchedule>);
  const schedule: EvaluationSchedule = { ...(lastRunAt && { lastRunAt }), ...(lastRunId && { lastRunId }), enabled: body.data.enabled, cron: body.data.cron, ...(body.data.timezone && { timezone: body.data.timezone }), ...(body.data.maxRows && { maxRows: body.data.maxRows }) };
  saveSettings(id, { ...settings, schedule });
  return json(view(id));
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!store.getWorkflow(id)) return error('Workflow not found', 404);
  const { schedule: _schedule, ...rest } = getSettings(id);
  saveSettings(id, rest);
  return json({});
});
