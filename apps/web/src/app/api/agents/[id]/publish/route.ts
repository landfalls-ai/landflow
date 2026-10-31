/**
 * Publish the draft as a new version (schedules, channels and the Run an Agent node use it), or unpublish. An agent
 * deployed to kagent gets the new version there too (`kagent` in the answer: its status, or why it couldn't be written);
 * unpublishing leaves kagent's copy as it is.
 */
import { agentStore } from '@/lib/server/agents/store';
import { error, handler, json } from '@/lib/server/http';
import { redeployIfDeployed } from '@/lib/server/kagent/deploy';
import { hasPrompt } from '@/lib/shared/persona';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (_request: Request, { params }: Ctx) => {
  const id = (await params).id;
  const current = agentStore.get(id);
  if (!current) return error('Agent not found', 404);
  if (!current.model?.model) return error('Choose a model before publishing');
  if (!hasPrompt(current)) return error('Describe the persona or add instructions before publishing');
  const agent = agentStore.publish(id)!;
  const kagent = await redeployIfDeployed(agent);
  return json({ agent: kagent && !('error' in kagent) ? (agentStore.get(id) ?? agent) : agent, ...(kagent && { kagent }) });
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const agent = agentStore.unpublish((await params).id);
  return agent ? json({ agent }) : error('Agent not found', 404);
});
