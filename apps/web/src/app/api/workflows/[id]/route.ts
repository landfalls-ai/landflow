import type { Workflow } from '@landflow/engine';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { workflowSchema } from '@/lib/server/schemas';
import { currentActorId } from '@/lib/server/auth/context';
import { publishedVersionId } from '@/lib/server/publications';
import { forgetWorkflow, publishVersion } from '@/lib/server/publish';
import { store } from '@/lib/server/store';
import { deleteVersions, versionFor } from '@/lib/server/versions';

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
  const workflow = store.saveWorkflow({ ...existing, ...body.data, id } as Workflow);
  // Saves are drafts. A client from before draft and publish sends `active: true` with an active workflow to put the
  // save live (the editor leaves `active` out): publish what it saved, as such a save used to do.
  if (body.data.active === true && existing.active) {
    const version = versionFor(workflow);
    if (version && version.id !== publishedVersionId(id)) await publishVersion(id, version.id, currentActorId(), 'Saved as active (API)');
  }
  return json({ workflow: store.getWorkflow(id) ?? workflow });
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!store.deleteWorkflow(id)) return error('Workflow not found', 404);
  deleteVersions(id);
  // Its publication goes now; app webhook triggers remove their hooks in the background.
  void forgetWorkflow(id);
  return json({ ok: true });
});
