/**
 * Debug tokens of one execution (docs/specs/19-debug-token.md): short-lived, read-only credentials that open three tools
 * of the instance MCP server (explain_failure, get_run_trace, get_execution) for this execution and nothing else.
 *
 * GET  → `{ tokens }`: yours for this execution (owners and admins: everyone's); never the token itself.
 * POST { ttlSeconds? (60–86400, default 3600), scopes? (executions:read, trace:read; default both), label? } → 201
 *      `{ token, record, mcp }`: the token is shown once. Needs read access to the execution's workflow.
 */
import { z } from 'zod';
import { can } from '@/lib/shared/auth';
import { requireUser } from '@/lib/server/auth';
import { DEBUG_TOKEN_SCOPES, DebugTokenError, listDebugTokens, mintDebugToken } from '@/lib/server/auth/debug-tokens';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { mcpAccess } from '@/lib/server/mcp/instance';
import { liveExecution } from '@/lib/server/runner';
import { store } from '@/lib/server/store';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const me = await requireUser();
  const { id } = await params;
  const mine = can(me, 'mcp:manage') ? undefined : me.id;
  return json({ tokens: listDebugTokens({ executionId: id, ...(mine && { createdBy: mine }) }) });
});

const schema = z.object({
  ttlSeconds: z.number().int().min(60).max(86_400).optional(),
  scopes: z.array(z.enum(DEBUG_TOKEN_SCOPES)).min(1).optional(),
  label: z.string().trim().max(100).optional(),
});

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const me = await requireUser();
  const { id } = await params;
  const record = liveExecution(id) ?? store.getExecution(id);
  if (!record) return error('Execution not found', 404);
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;
  try {
    const minted = mintDebugToken(me, { executionId: id, workflowId: record.workflowId, ...body.data });
    const t = minted.record;
    recordAudit({
      action: 'mcp.token.issue',
      target: { type: 'debug_token', id: t.id, name: t.label },
      summary: `Issued a debug token for execution ${id} (${t.scopes.join(', ')}, expires ${t.expiresAt})`,
      details: { kind: 'debug', executionId: id, workflowId: record.workflowId, scopes: t.scopes, expiresAt: t.expiresAt },
    });
    const { enabled, path } = mcpAccess();
    return json({ ...minted, mcp: { enabled, path } }, 201);
  } catch (caught) {
    if (caught instanceof DebugTokenError) return error(caught.message, caught.status);
    throw caught;
  }
});
