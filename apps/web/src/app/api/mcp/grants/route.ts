/**
 * Tool grants (docs/protocol.md §15.5; owners and admins). GET lists them (`?pluginId=` filters); POST creates one:
 * { subject: { kind, id }, pluginId, tools: string[] | '*', credentials?: { <type>: <credentialId> }, requireApproval? }.
 */
import { requireUser } from '@/lib/server/auth';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { createGrant, grantCreateSchema, listGrants, McpGrantError } from '@/lib/server/mcp/grants';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  await requireUser('mcp:manage');
  const pluginId = new URL(request.url).searchParams.get('pluginId') ?? undefined;
  return json({ grants: listGrants(pluginId ? { pluginId } : {}) });
});

export const POST = handler(async (request: Request) => {
  const me = await requireUser('mcp:manage');
  const body = await parseBody(request, grantCreateSchema);
  if (!body.ok) return body.response;
  try {
    const grant = createGrant(body.data, me.id);
    recordAudit({
      action: 'mcp.grant.create',
      target: { type: 'mcp_grant', id: grant.id, name: `${grant.subject.kind}:${grant.subject.id} → ${grant.pluginId}` },
      summary: `Granted ${grant.subject.kind} ${grant.subject.name ?? grant.subject.id} ${grant.tools === '*' ? 'every tool' : `${grant.tools.length} tool(s)`} of ${grant.pluginId}`,
      details: { subjectKind: grant.subject.kind, subjectId: grant.subject.id, pluginId: grant.pluginId, tools: grant.tools === '*' ? '*' : grant.tools, credentialTypes: Object.keys(grant.credentials) },
    });
    return json({ grant }, 201);
  } catch (caught) {
    if (caught instanceof McpGrantError) return error(caught.message, caught.status);
    throw caught;
  }
});
