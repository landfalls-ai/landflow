/**
 * GET /api/workflows/:id/unattended-approvals[?version=<n>] — the tools that ask first which a run nobody watches (a webhook,
 * a schedule, a channel, an app trigger, the hosted chat, a form) will refuse in production: `[{ tool, agent, node, trigger, line }]`,
 * `[]` when none. The published version by default (its agents at their pins), else the draft; `version` names a saved version, or `draft` the saved draft (what the next publish would run); `update=<agentId,...>` reads those agents at their latest published version (an update offer's re-pin).
 * Said before publishing: the publish card and the Publish menu show the lines. Read access on the workflow.
 */
import { z } from 'zod';
import { unattendedApprovals } from '@/lib/server/agents/unattended';
import { error, handler, json, parseQuery } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const query = parseQuery(request, z.object({ version: z.union([z.literal('draft'), z.coerce.number().int().min(1)]).optional(), update: z.string().max(2000).optional() }));
  if (!query.ok) return query.response;
  const lines = unattendedApprovals((await params).id, query.data.version, query.data.update?.split(',').map((a) => a.trim()).filter(Boolean));
  if (!lines) return error('Workflow not found', 404);
  return json(lines);
});
