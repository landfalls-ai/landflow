/** One tool grant (owners and admins): GET, PATCH { tools?, credentials?, approval? (always | destructive | never | null; `requireApproval` boolean still accepted) }, DELETE. */
import { requireUser } from '@/lib/server/auth';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { deleteGrant, getGrant, grantPatchSchema, McpGrantError, updateGrant } from '@/lib/server/mcp/grants';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  await requireUser('mcp:manage');
  const grant = getGrant((await params).id);
  return grant ? json({ grant }) : error('Grant not found', 404);
});

export const PATCH = handler(async (request: Request, { params }: Ctx) => {
  const me = await requireUser('mcp:manage');
  const body = await parseBody(request, grantPatchSchema);
  if (!body.ok) return body.response;
  try {
    const grant = updateGrant((await params).id, body.data, me);
    recordAudit({ action: 'mcp.grant.update', target: { type: 'mcp_grant', id: grant.id, name: `${grant.subject.kind}:${grant.subject.id} → ${grant.pluginId}` }, summary: `Changed the grant of ${grant.subject.kind} ${grant.subject.name ?? grant.subject.id} on ${grant.pluginId}`, details: { pluginId: grant.pluginId, tools: grant.tools === '*' ? '*' : grant.tools, credentialTypes: Object.keys(grant.credentials), approval: grant.approval ?? null } });
    return json({ grant });
  } catch (caught) {
    if (caught instanceof McpGrantError) return error(caught.message, caught.status);
    throw caught;
  }
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  await requireUser('mcp:manage');
  const grant = getGrant((await params).id);
  if (!grant) return error('Grant not found', 404);
  deleteGrant(grant.id);
  recordAudit({ action: 'mcp.grant.delete', target: { type: 'mcp_grant', id: grant.id, name: `${grant.subject.kind}:${grant.subject.id} → ${grant.pluginId}` }, summary: `Removed the grant of ${grant.subject.kind} ${grant.subject.name ?? grant.subject.id} on ${grant.pluginId}`, details: { pluginId: grant.pluginId, subjectKind: grant.subject.kind, subjectId: grant.subject.id } });
  return json({ ok: true });
});
