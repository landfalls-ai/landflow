/** Publish the draft as a new version (schedules, channels and the Message an Agent node use it), or unpublish. */
import { agentStore } from '@/lib/server/agents/store';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (_request: Request, { params }: Ctx) => {
  const id = (await params).id;
  const current = agentStore.get(id);
  if (!current) return error('Agent not found', 404);
  if (!current.model?.model) return error('Choose a model before publishing');
  if (!current.instructions.trim()) return error('Add instructions before publishing');
  return json({ agent: agentStore.publish(id) });
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const agent = agentStore.unpublish((await params).id);
  return agent ? json({ agent }) : error('Agent not found', 404);
});
