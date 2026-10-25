import { z } from 'zod';
import type { Workflow } from '@landflow/engine';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** PATCH { timeSavedMinutes } — set (or with null clear) a workflow's minutes saved per successful run, from the Insights table. */
export const PATCH = handler(async (request: Request, { params }: Ctx) => {
  const workflow = store.getWorkflow((await params).id);
  if (!workflow) return error('Workflow not found', 404);
  const body = await parseBody(request, z.object({ timeSavedMinutes: z.number().min(0).max(100_000).nullable() }));
  if (!body.ok) return body.response;
  const { timeSavedMinutes: _previous, ...settings } = workflow.settings ?? {};
  const saved = store.saveWorkflow({
    ...workflow,
    settings: { ...settings, ...(body.data.timeSavedMinutes !== null && { timeSavedMinutes: body.data.timeSavedMinutes }) },
  } as Workflow);
  return json({ workflowId: saved.id, timeSavedMinutes: saved.settings?.timeSavedMinutes ?? null });
});
