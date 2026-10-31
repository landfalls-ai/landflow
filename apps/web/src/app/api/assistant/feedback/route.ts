import { z } from 'zod';
import { handler, json, parseBody } from '@/lib/server/http';
import { currentPrincipal } from '@/lib/server/auth/guard';
import { recordAssistantFeedback } from '@/lib/server/telemetry/assistant';
import { recordUsage } from '@/lib/server/usage/ledger';

export const dynamic = 'force-dynamic';

const Body = z.object({
  kind: z.enum(['fix', 'param', 'data', 'next', 'proposal']),
  action: z.enum(['applied', 'dismissed']),
  /** The workflow and node type it was about, for the usage ledger (docs/second-brain.md). */
  workflowId: z.string().max(200).optional(),
  nodeType: z.string().max(200).optional(),
});

/** POST { kind, action }: the editor reports a suggestion or chat proposal applied or dismissed. */
export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const { kind, action, workflowId, nodeType } = parsed.data;
  recordAssistantFeedback(kind, action);
  const actorId = currentPrincipal()?.user?.id;
  recordUsage({ kind: action === 'applied' ? 'assistant.applied' : 'assistant.dismissed', workflowId, nodeType, actorId, attrs: { suggestion: kind } });
  return json({ ok: true });
});
