import type { Workflow } from '@landflow/engine';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { workflowSchema } from '@/lib/server/schemas';
import { currentActorId } from '@/lib/server/auth/context';
import { ownershipOf } from '@/lib/server/projects';
import { forgetDeleted, routeActor } from '@/lib/server/projects/http';
import { publishedVersionId } from '@/lib/server/publications';
import { forgetWorkflow } from '@/lib/server/publish';
import { recordAudit } from '@/lib/server/audit';
import { publishOrRequest } from '@/lib/server/governance/approvals';
import { governedSave } from '@/lib/server/governance/saves';
import { store } from '@/lib/server/store';
import { deleteVersions, versionFor } from '@/lib/server/versions';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const workflow = store.getWorkflow((await params).id);
  // `ownership`: its project and what the caller may do with it (the editor is read-only for viewers).
  return workflow ? json({ workflow, ownership: ownershipOf(routeActor(), 'workflow', workflow.id) }) : error('Workflow not found', 404);
});

export const PUT = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const existing = store.getWorkflow(id);
  if (!existing) return error('Workflow not found', 404);
  const body = await parseBody(request, workflowSchema);
  if (!body.ok) return body.response;
  // Governance (lib/server/governance/saves.ts): an `active` switch may be held for approval or refused; policy warnings.
  const { workflow, extras } = governedSave({ ...existing, ...body.data, id } as Workflow, existing, (w) => store.saveWorkflow(w), { by: currentActorId() });
  // Saves are drafts. A client from before draft and publish sends `active: true` with an active workflow to put the
  // save live (the editor leaves `active` out): publish what it saved, as such a save used to do (or ask, four-eyes on).
  if (body.data.active === true && existing.active) {
    const version = versionFor(workflow);
    if (version && version.id !== publishedVersionId(id)) {
      const outcome = await publishOrRequest({ workflowId: id, action: 'publish', versionId: version.id, by: currentActorId(), note: 'Saved as active (API)' }).catch((caught: Error) => {
        extras.activationRefused = caught.message;
        return undefined;
      });
      if (outcome?.approvalRequired) extras.publishRequest = outcome.request;
    }
  }
  return json({ workflow: store.getWorkflow(id) ?? workflow, ...extras });
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  const existing = store.getWorkflow(id);
  if (!store.deleteWorkflow(id)) return error('Workflow not found', 404);
  recordAudit({ action: 'workflow.delete', target: { type: 'workflow', id, ...(existing?.name && { name: existing.name }) } });
  deleteVersions(id);
  forgetDeleted('workflow', id);
  // Its publication goes now; app webhook triggers remove their hooks in the background.
  void forgetWorkflow(id);
  return json({ ok: true });
});
