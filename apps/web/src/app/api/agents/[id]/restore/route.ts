/** POST /api/agents/:id/restore { version } — copy an earlier published version's config into the draft (nothing is published). */
import { z } from 'zod';
import { agentStore } from '@/lib/server/agents/store';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!agentStore.get(id)) return error('Agent not found', 404);
  const body = await parseBody(request, z.object({ version: z.number().int().positive() }));
  if (!body.ok) return body.response;
  const agent = agentStore.restore(id, body.data.version);
  return agent ? json({ agent }) : error(`Version ${body.data.version} is not in the history`, 404);
});
