/**
 * POST { name, description, instructions, workflow?, after?, before?, tools?, knowledge? } — the agent Spotlight proposes (`newAgent`,
 * docs/assistant.md#agents-and-teams), designed by the Agent architect: a model this host has (a local one first), the
 * tools it needs from the plugins online and a knowledge base when it works from documents. Saved as a draft; the
 * editor publishes it in autonomous mode. Its brief's test cases are saved on it (the eval gate). Answers `{ agent, needs, missing, dropped, designed, cases }`, or 429 with the cap's
 * message when the caller's AI usage cap is reached (no agent is created).
 */
import { z } from 'zod';
import { randomFace } from '@/lib/shared/faces';
import { agentResources } from '@/lib/server/assistant/agent-resources';
import { designAgent } from '@/lib/server/assistant/architect';
import { resolveSpotlightModel } from '@/lib/server/assistant/models-list'; // SB19:
import { allowedTypes } from '@/lib/server/assistant/scope';
import { addCase } from '@/lib/server/agents/eval-gate'; // SB17:
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
  // SB05: what the agent needs, from Spotlight's newAgent.
  tools: z.array(z.string().max(80)).max(8).optional(),
  knowledge: z.string().max(200).optional(),
  // SB19: the model Spotlight picked (a model this server offers); absent, the Settings default.
  model: z.string().max(100).optional(),
});

export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const picked = await resolveSpotlightModel(parsed.data.model); // SB19:
  if ('error' in picked) return error(picked.error, 400); // SB19:
  const actor = routeActor();
  const resources = await agentResources(actor);
  let design: Awaited<ReturnType<typeof designAgent>>;
  try {
    design = await designAgent(parsed.data, { model: picked.model, types: allowedTypes(undefined, actor), actor, resources, signal: request.signal });
  } catch (caught) {
    // The caller's AI usage cap: say so, and create no agent (Spotlight shows the message on the step).
    if (isUsageCapError(caught)) return error(caught.message, 429);
    throw caught;
  }
  const config = { avatar: { kind: 'face' as const, face: randomFace(parsed.data.name) }, ...design.config };
  const agent = createInProject(request, 'agent', () => agentStore.create(config), (a) => a.id);
  // SB17: the brief's test cases are saved on the new agent (the eval gate runs them on its first publish); one that fails is a line for the person, not a 500.
  const cases: NonNullable<typeof design.cases> = [];
  const needs = [...design.needs];
  for (const draft of design.cases ?? []) {
    try {
      addCase(agent.id, draft);
      cases.push(draft);
    } catch {
      if (!needs.some((n) => n.tool === 'test cases')) needs.push({ tool: 'test cases', kind: 'parameter', text: 'Add test cases on the Evaluations tab' });
    }
  }
  return json({ agent, needs, missing: design.missing, dropped: design.dropped, designed: design.designed, cases /* SB17: */ }, 201);
});
