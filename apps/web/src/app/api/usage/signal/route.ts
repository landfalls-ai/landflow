/**
 * POST /api/usage/signal { kind: 'search.empty', query, workflowId? } — what only the editor sees, for the usage ledger:
 * a node search that found nothing (the brain's "unmet demand", docs/second-brain.md).
 */
import { z } from 'zod';
import { CLIENT_SIGNALS } from '@/lib/shared/brain';
import { currentPrincipal } from '@/lib/server/auth/guard';
import { handler, json, parseBody } from '@/lib/server/http';
import { recordUsage } from '@/lib/server/usage/ledger';

export const dynamic = 'force-dynamic';

const Body = z.object({
  kind: z.enum(CLIENT_SIGNALS),
  query: z.string().trim().min(2).max(300),
  workflowId: z.string().max(200).optional(),
});

export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const { kind, query, workflowId } = parsed.data;
  recordUsage({ kind, message: query, ...(workflowId && { workflowId }), ...(currentPrincipal()?.user?.id && { actorId: currentPrincipal()!.user!.id }) });
  return json({ ok: true });
});
