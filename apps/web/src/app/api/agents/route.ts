import { z } from 'zod';
import type { AgentAvatar } from '@/lib/shared/agents';
import { randomFace } from '@/lib/shared/faces';
import { nanoid } from 'nanoid';
import { agentStore } from '@/lib/server/agents/store';
import { agentTemplateAccess, agentTemplates, configFromTemplate } from '@/lib/server/agents/templates';
import { marketplaceStore } from '@/lib/server/marketplace/store';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { withOwnership } from '@/lib/server/projects';
import { createInProject, projectParam, routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

/** GET ?projectId= — the agents the caller sees, each with its `ownership`, and the marketplace plugin that installed it. */
export const GET = handler(async (request: Request) => {
  const installedBy = new Map(marketplaceStore.installed().flatMap((p) => p.agents.map((a) => [a.id, { installedId: p.id, plugin: p.plugin, marketplace: p.marketplaceName }] as const)));
  const summaries = agentStore.summaries().map((a) => {
    const marketplace = installedBy.get(a.id);
    return marketplace ? { ...a, marketplace } : a;
  });
  return json({ agents: withOwnership(routeActor(), 'agent', summaries, projectParam(request)) });
});

const createSchema = z.object({
  name: z.string().max(200).optional(),
  /** Start from a persona (GET /api/agent-templates). */
  templateId: z.string().optional(),
  /** What the New agent dialog changed. */
  avatar: z.unknown().optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  icon: z.string().max(80).optional(),
  team: z.string().max(60).optional(),
});

/**
 * POST — a new agent, empty or from a template (`templateId`), with the name, avatar, colour and team given. An agent made
 * without an avatar (a script, the CLI, another agent) gets a face from its name, as the New agent dialog gives one: a
 * robot icon in a team chart read as a missing picture.
 */
export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, createSchema);
  if (!body.ok) return body.response;
  const { templateId, name, avatar, color, icon, team } = body.data;
  const template = templateId ? agentTemplates.get(templateId) : undefined;
  if (templateId && (!template || !agentTemplateAccess(routeActor(), template).read)) return error('Template not found', 404);
  const overrides = { name, color, icon, team, ...(avatar !== undefined && { avatar: avatar as AgentAvatar }) };
  const face: AgentAvatar = { kind: 'face', face: randomFace(name?.trim() || nanoid(6)) };
  const config = template ? configFromTemplate(template, overrides) : { name, ...(color && { color }), ...(icon && { icon }), ...(team && { team }), avatar: avatar !== undefined ? (avatar as AgentAvatar) : face };
  return json({ agent: createInProject(request, 'agent', () => agentStore.create(config), (a) => a.id) }, 201);
});
