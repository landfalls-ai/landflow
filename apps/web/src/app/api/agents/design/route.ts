/**
 * POST { name, description, instructions, workflow?, after?, before? } — the agent Spotlight proposes (`newAgent`,
 * docs/assistant.md#agents-and-teams), designed by the Agent architect: a model this host has (a local one first), the
 * tools it needs from the plugins online and a knowledge base when it works from documents. Saved as a draft; the
 * editor publishes it in autonomous mode. Answers `{ agent, needs, missing, dropped, designed }`, or 429 with the cap's
 * message when the caller's AI usage cap is reached (no agent is created).
 */
import { z } from 'zod';
import { randomFace } from '@/lib/shared/faces';
import { agentResources } from '@/lib/server/assistant/agent-resources';
import { designAgent } from '@/lib/server/assistant/architect';
import { allowedTypes } from '@/lib/server/assistant/scope';
import { agentStore } from '@/lib/server/agents/store';
import { isUsageCapError } from '@/lib/server/ai-usage';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { createInProject, routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

const Body = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(''),
  instructions: z.string().max(4000).default(''),
  workflow: z.string().max(200).optional(),
  after: z.string().max(200).optional(),
  before: z.string().max(200).optional(),
});

export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const actor = routeActor();
  const resources = await agentResources(actor);
  let design: Awaited<ReturnType<typeof designAgent>>;
  try {
    design = await designAgent(parsed.data, { types: allowedTypes(undefined, actor), actor, resources, signal: request.signal });
  } catch (caught) {
    // The caller's AI usage cap: say so, and create no agent (Spotlight shows the message on the step).
    if (isUsageCapError(caught)) return error(caught.message, 429);
    throw caught;
  }
  const config = { avatar: { kind: 'face' as const, face: randomFace(parsed.data.name) }, ...design.config };
  const agent = createInProject(request, 'agent', () => agentStore.create(config), (a) => a.id);
  return json({ agent, needs: design.needs, missing: design.missing, dropped: design.dropped, designed: design.designed }, 201);
});
