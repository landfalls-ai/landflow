/**
 * Tool access test panel (docs/agents.md "Tool access"): what could this caller do?
 * POST { caller: { id, role?, source }, config? } — runs the agent's tools through the same policy a run uses (its rules, and OPA or
 * OpenFGA when LANDFLOW_TOOL_POLICY names one) and answers allow, ask or deny for each tool. `config` tries rules that are not saved yet
 * (the draft being edited); without it the saved draft is used. Nothing runs and no tool is called.
 */
import { z } from 'zod';
import { cleanAccess } from '@/lib/shared/agent-access';
import { applyToolPolicy } from '@/lib/server/agents/policy';
import { agentStore, configOf } from '@/lib/server/agents/store';
import { buildToolset } from '@/lib/server/agents/tools';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const SOURCES = ['test', 'schedule', 'telegram', 'slack', 'teams', 'workflow', 'agent', 'api'] as const;
const body = z.object({
  caller: z.object({ id: z.string().trim().min(1).max(200), role: z.string().trim().max(50).optional(), source: z.enum(SOURCES) }),
  rules: z.array(z.object({ id: z.string(), tool: z.string(), who: z.object({ role: z.string().optional(), user: z.string().optional(), source: z.enum(SOURCES).optional() }), effect: z.enum(['allow', 'ask', 'deny']) })).max(100).optional(),
});

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const agent = agentStore.get(id);
  if (!agent) return error('Agent not found', 404);
  const parsed = await parseBody(request, body);
  if (!parsed.ok) return parsed.response;
  const config = configOf(agent);
  const access = parsed.data.rules ? cleanAccess({ rules: parsed.data.rules }) : config.access;
  try {
    const toolset = await buildToolset(agent, config);
    const { role, ...rest } = parsed.data.caller;
    const result = await applyToolPolicy(toolset.tools, { agentId: agent.id, caller: { ...rest, ...(role && { role }) }, access });
    return json({ decisions: result.decisions, unavailable: toolset.unavailable });
  } catch (caught) {
    return error((caught as Error).message, 500);
  }
});
