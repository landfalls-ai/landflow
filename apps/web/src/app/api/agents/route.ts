import { z } from 'zod';
import { agentStore } from '@/lib/server/agents/store';
import { handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json({ agents: agentStore.summaries() }));

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, z.object({ name: z.string().max(200).optional() }));
  if (!body.ok) return body.response;
  return json({ agent: agentStore.create({ name: body.data.name }) }, 201);
});
