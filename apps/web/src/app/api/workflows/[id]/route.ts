import type { Workflow } from '@landflow/engine';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { workflowSchema } from '@/lib/server/schemas';
import { store } from '@/lib/server/store';
import { deleteVersions } from '@/lib/server/versions';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const workflow = store.getWorkflow((await params).id);
  return workflow ? json({ workflow }) : error('Workflow not found', 404);
});

export const PUT = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const existing = store.getWorkflow(id);
  if (!existing) return error('Workflow not found', 404);
  const body = await parseBody(request, workflowSchema);
  if (!body.ok) return body.response;
  return json({ workflow: store.saveWorkflow({ ...existing, ...body.data, id } as Workflow) });
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!store.deleteWorkflow(id)) return error('Workflow not found', 404);
  deleteVersions(id);
  return json({ ok: true });
});
