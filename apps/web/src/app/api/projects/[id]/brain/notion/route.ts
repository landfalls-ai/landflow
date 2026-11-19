/**
 * A project's link to a Notion page (docs/features/notion-brain.md#setting-it-up). Nothing here syncs: the link starts in
 * `setting_up` and the sync (wave nb2) copies. The routes read Notion only through lib/server/notion/port.ts.
 * GET — `LinkStatusView` (the project's members). POST `LinkCreateInput` — link a page (project admins; 202).
 * PATCH `LinkPatchInput` — pause, resume, requests a second, knowledge scope (admins). DELETE — disconnect (admins).
 */
import { recordAudit } from '@/lib/server/audit';
import { checkPage, recheckLink } from '@/lib/server/brain/notion/check';
import { createLink, getLink, LinkConflictError, linkView, notionBrainEnabled, requestSync, SWITCHED_OFF, unlink, updateLink } from '@/lib/server/brain/notion/links';
import { changeStatus } from '@/lib/server/brain/notion/status'; // NB07:
import { linkCreateSchema, linkPatchSchema } from '@/lib/server/brain/notion/schemas';
import { error, json, parseBody } from '@/lib/server/http';
import { projectRoute, requireProject, routeActor } from '@/lib/server/projects/http';
import { projectRoleCan } from '@/lib/shared/projects';
import type { LinkStatusView } from '@/lib/shared/notion-brain';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = projectRoute(async (_request: Request, { params }: Ctx) => {
  const project = requireProject(routeActor(), (await params).id, 'read');
  const canManage = projectRoleCan.manage(project.role);
  const link = getLink(project.id);
  const view: LinkStatusView = link ? linkView(link, { member: true, canManage }) : { linked: false, canManage };
  return json(view);
});

export const POST = projectRoute(async (request: Request, { params }: Ctx) => {
  const actor = routeActor();
  const project = requireProject(actor, (await params).id, 'manage');
  const body = await parseBody(request, linkCreateSchema);
  if (!body.ok) return body.response;
  if (!notionBrainEnabled()) return error(SWITCHED_OFF, 409);
  if (getLink(project.id)) return error('Already linked: change or disconnect the link first', 409);
  const checked = await checkPage(project, body.data);
  try {
    const link = createLink({
      projectId: project.id,
      credentialId: body.data.credentialId,
      rootPageId: checked.rootPageId,
      rootTitle: checked.result.title,
      rootUrl: checked.result.url,
      brainPageId: checked.result.existingBrain.pageId,
      botId: checked.botId,
      botName: checked.botName,
      workspaceName: checked.workspaceName,
      knowledgeScope: body.data.knowledgeScope,
      rps: body.data.rps,
      createdBy: actor.id,
    });
    recordAudit({
      action: 'notion-brain.link',
      target: { type: 'project', id: project.id, name: project.name },
      summary: `Linked “${project.name}” to a Notion page`,
      details: { linkId: link.id, credentialId: link.credential_id, rootPageId: link.root_page_id, existingBrain: checked.result.existingBrain.found },
    });
    return json(linkView(link, { member: true, canManage: true }), 202);
  } catch (err) {
    if (err instanceof LinkConflictError) return error(err.message, 409);
    throw err;
  }
});

export const PATCH = projectRoute(async (request: Request, { params }: Ctx) => {
  const actor = routeActor();
  const project = requireProject(actor, (await params).id, 'manage');
  const body = await parseBody(request, linkPatchSchema);
  if (!body.ok) return body.response;
  if (!notionBrainEnabled()) return error(SWITCHED_OFF, 409);
  const link = getLink(project.id);
  if (!link) return error('This project is not linked to Notion', 404);
  const fields: Parameters<typeof updateLink>[1] = {};
  // NB07: a way back from a refused key or an unshared page. The page is checked first (with the new key, or the link's own for
  // "try again"); a failure (400, 403, 404, 504) leaves the link exactly as it was.
  const stopped = link.status === 'unauthorized' || link.status === 'unshared';
  const resume = body.data.paused === false && stopped;
  let resumeTo: 'active' | 'setting_up' | undefined;
  if (body.data.credentialId !== undefined || resume) {
    const checked = await recheckLink(project, link, body.data.credentialId ?? link.credential_id);
    if (body.data.credentialId !== undefined) {
      fields.credential_id = body.data.credentialId;
      fields.bot_id = checked.botId ?? null;
      fields.bot_name = checked.botName ?? null;
      fields.workspace_name = checked.workspaceName ?? null;
    }
    if (stopped && body.data.paused !== true) {
      resumeTo = link.databases ? 'active' : 'setting_up';
      fields.last_error = null;
    }
  }
  if (body.data.rps !== undefined) fields.rps = body.data.rps;
  if (body.data.knowledgeScope) fields.knowledge_scope = body.data.knowledgeScope;
  if (body.data.paused === true && !['paused', 'unlinked'].includes(link.status)) {
    fields.status = 'paused';
    fields.reason = 'Paused by an admin';
  } else if (body.data.paused === false && link.status === 'paused') {
    fields.status = link.databases ? 'active' : 'setting_up';
    fields.reason = null;
  }
  let next = updateLink(link.id, fields) ?? link;
  if (resumeTo) {
    // NB07: through changeStatus, so the admins get the one notice; the next sync is due now.
    next = changeStatus(link.id, resumeTo) ?? next;
    next = requestSync(link.id) ?? next;
  }
  recordAudit({
    action: 'notion-brain.update',
    target: { type: 'project', id: project.id, name: project.name },
    summary: `Changed the Notion link of “${project.name}”`,
    details: { linkId: link.id, ...(body.data.paused !== undefined && { paused: body.data.paused }), ...(body.data.rps !== undefined && { rps: body.data.rps }), ...(body.data.knowledgeScope && { knowledgeScope: body.data.knowledgeScope }), ...(body.data.credentialId !== undefined && { credentialId: body.data.credentialId }) },
  });
  return json(linkView(next, { member: true, canManage: true }));
});

export const DELETE = projectRoute(async (_request: Request, { params }: Ctx) => {
  const project = requireProject(routeActor(), (await params).id, 'manage');
  const link = getLink(project.id);
  if (!link) return error('This project is not linked to Notion', 404);
  unlink(link.id);
  recordAudit({
    action: 'notion-brain.unlink',
    target: { type: 'project', id: project.id, name: project.name },
    summary: `Disconnected “${project.name}” from Notion`,
    details: { linkId: link.id, rootPageId: link.root_page_id },
  });
  return json({ ok: true, linked: false, message: 'Disconnected. Notion keeps what is there; Landflow keeps its own brain.' });
});
