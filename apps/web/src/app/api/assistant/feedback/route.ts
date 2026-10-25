import { z } from 'zod';
import { handler, json, parseBody } from '@/lib/server/http';
import { recordAssistantFeedback } from '@/lib/server/telemetry/assistant';

export const dynamic = 'force-dynamic';

const Body = z.object({
  kind: z.enum(['fix', 'param', 'data', 'next', 'proposal']),
  action: z.enum(['applied', 'dismissed']),
});

/** POST { kind, action }: the editor reports a suggestion or chat proposal applied or dismissed. */
export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  recordAssistantFeedback(parsed.data.kind, parsed.data.action);
  return json({ ok: true });
});
