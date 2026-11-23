/** POST /api/mcp/approvals/<id> { approve: boolean }: answer a waiting MCP tool call (who may: lib/server/mcp/approvals.ts). */
import { z } from 'zod';
import { requireUser } from '@/lib/server/auth';
import { recordAudit } from '@/lib/server/audit';
import { handler, json, parseBody } from '@/lib/server/http';
import { decideMcpApproval } from '@/lib/server/mcp/approvals';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const me = await requireUser();
  const body = await parseBody(request, z.strictObject({ approve: z.boolean() }));
  if (!body.ok) return body.response;
  const approval = decideMcpApproval((await params).id, body.data.approve, me);
  recordAudit({
    action: 'mcp.approval.decide',
    outcome: body.data.approve ? 'success' : 'denied',
    target: { type: 'mcp_approval', id: approval.id, name: `${approval.pluginId} · ${approval.tool}` },
    summary: `${body.data.approve ? 'Approved' : 'Denied'} MCP tool ${approval.tool} of ${approval.pluginId} for ${approval.caller}`,
    details: { pluginId: approval.pluginId, tool: approval.tool, caller: approval.caller },
  });
  return json({ approval });
});
