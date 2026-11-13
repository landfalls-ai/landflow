import type { Workflow } from '@landflow/engine';
import { z } from 'zod';
import { HttpError } from '@/lib/server/errors';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { workflowSchema } from '@/lib/server/schemas';
import { currentActorId } from '@/lib/server/auth/context';
import { ownershipOf } from '@/lib/server/projects';
import { forgetDeleted, routeActor } from '@/lib/server/projects/http';
import { deletePublications, publishedVersionId } from '@/lib/server/publications';
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

/** 412: the client based its save on a version that is no longer the stored one. */
class WorkflowConflictError extends HttpError {
  static readonly errorName: string = 'WorkflowConflictError';
  constructor(current: Workflow) {
    super('This workflow changed since you opened it', 412, { code: 'workflow_conflict', details: { current: { updatedAt: current.updatedAt, ...(current.updatedBy && { updatedBy: current.updatedBy }) } } });
  }
}

/**
 * The `updatedAt` the client says it based the save on: `If-Match: "<updatedAt>"` (weak tags and quotes allowed) or body
 * `baseUpdatedAt`. One entity tag only: a list (`"a", "b"`) is read as one value and never matches, so it is a 412. The
 * tag is a millisecond timestamp, so two saves in the same millisecond share it and the second does not conflict.
 */
function baseOf(request: Request, fromBody: string | undefined): string | undefined {
  const header = request.headers.get('if-match')?.trim();
  if (header && header !== '*') return header.replace(/^W\//, '').replace(/^"|"$/g, '');
  return fromBody;
}

const saveSchema = workflowSchema.and(z.object({ baseUpdatedAt: z.string().optional() }));

/**
 * PUT replaces the document the client sends onto the stored one. With `If-Match` (or `baseUpdatedAt`) naming the
 * `updatedAt` the client loaded, a save over a newer stored version is refused (412 `workflow_conflict`); without one
 * the last write wins, as the API, CLI and MCP always did.
 */
export const PUT = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!store.getWorkflow(id)) return error('Workflow not found', 404);
  const body = await parseBody(request, saveSchema);
  if (!body.ok) return body.response;
  const { baseUpdatedAt, ...fields } = body.data;
  // Read after the body (an await): the check and the save below run without one between them.
  const existing = store.getWorkflow(id);
  if (!existing) return error('Workflow not found', 404);
  const base = baseOf(request, baseUpdatedAt);
  if (base && existing.updatedAt && base !== existing.updatedAt) throw new WorkflowConflictError(existing);
  // Governance (lib/server/governance/saves.ts): an `active` switch may be held for approval or refused; policy warnings.
  const { workflow, extras } = governedSave({ ...existing, ...fields, id } as Workflow, existing, (w) => store.saveWorkflow(w), { by: currentActorId() });
  // Saves are drafts. A client from before draft and publish sends `active: true` with an active workflow to put the
  // save live (the editor leaves `active` out): publish what it saved, as such a save used to do (or ask, four-eyes on).
  if (fields.active === true && existing.active) {
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
  // The row, its versions, publications, project rows and policy go in one transaction: all or nothing. Publication
  // listeners hear of it only after the commit.
  let publicationGone = () => {};
  const deleted = store.deleteWorkflow(id, () => {
    deleteVersions(id);
    publicationGone = deletePublications(id);
    forgetDeleted('workflow', id);
  });
  if (!deleted) return error('Workflow not found', 404);
  publicationGone();
  recordAudit({ action: 'workflow.delete', target: { type: 'workflow', id, ...(existing?.name && { name: existing.name }) } });
  // Its publication went with it; app webhook triggers remove their hooks in the background.
  void forgetWorkflow(id);
  return json({ ok: true });
});
