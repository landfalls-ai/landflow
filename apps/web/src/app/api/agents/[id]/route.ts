import { agentConfigSchema, asConfig } from '@/lib/server/agents/http';
import { agentStore } from '@/lib/server/agents/store';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const agent = agentStore.get((await params).id);
  return agent ? json({ agent }) : error('Agent not found', 404);
});

/** Autosave of the builder: replaces the draft; published versions stay as they are. */
export const PUT = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, agentConfigSchema);
  if (!body.ok) return body.response;
  const agent = agentStore.saveDraft((await params).id, asConfig(body.data));
  return agent ? json({ agent }) : error('Agent not found', 404);
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  return agentStore.delete((await params).id) ? json({ ok: true }) : error('Agent not found', 404);
});
