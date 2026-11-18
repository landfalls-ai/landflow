/**
 * AG18: the agent tools of the instance MCP server (docs/features/ai.md#mcp): the tenant reads Spotlight has in its own
 * tool loops (`list_agents`, `get_agent`, `list_tool_nodes`, `list_knowledge_bases`, `list_models`, `list_credentials`,
 * `read_agent_practices`, the same names, the same answers: they call `tenantTool`), and the writes `create_agent`,
 * `update_agent`, `test_agent` and `publish_agent`. The writes call the same server functions the agents API routes call,
 * never HTTP; `publish_agent` runs the eval gate exactly as `POST /api/agents/:id/publish` does and has no way to skip it.
 * A caller who may not update an agent gets "Agent … not found". Registered by instanceServer (./instance-tools.ts).
 */
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { hasPrompt } from '../../shared/persona';
import { adoptRun, checkPublish } from '../agents/eval-gate';
import { REFUSED_CREDENTIAL_MESSAGE, refusedCredentials, refusedForNewAgent } from '../agents/credential-scope';
import { agentConfigSchema, asConfig } from '../agents/http';
import { smokeTest, SmokeTestError } from '../agents/smoke-test';
import { agentStore, configOf } from '../agents/store';
import { protectedMessage } from '../environments/protection';
import { isProtectedEnvironment } from '../environments/settings';
import { redeployIfDeployed } from '../kagent/deploy';
import { canResource, creationProject, type Actor } from '../projects/access';
import { createIn } from '../projects/http';
import { defaultProjectId, homeProjectId } from '../projects/store';
import { isTenantTool, TENANT_TOOLS, tenantTool } from '../assistant/tenant-tools';
import type { McpScope } from './project-servers';

export interface AgentToolsContext {
  actor?: Actor;
  scope?: McpScope;
  json: (value: unknown) => CallToolResult;
  failure: (message: string) => CallToolResult;
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const DEFAULT_SMOKE = 'In one sentence, say what you do and what you would need to do it.';

/** What each read tool takes, as the zod shapes of the tools' JSON schemas (the specs are Spotlight's; one description). */
const READ_INPUTS: Record<string, z.ZodObject<z.ZodRawShape>> = {
  list_agents: z.object({ query: z.string().optional().describe('Words to match against names, roles, descriptions and tools') }),
  get_agent: z.object({ id: z.string().describe('The agent\'s id or its name') }),
  list_tool_nodes: z.object({ query: z.string().optional().describe('What the tool should do, in words'), types: z.array(z.string()).optional().describe('Only these node types') }),
  list_knowledge_bases: z.object({}),
  list_models: z.object({}),
  list_credentials: z.object({}),
  read_agent_practices: z.object({}),
};

export function registerAgentTools(server: McpServer, ctx: AgentToolsContext) {
  const { actor, scope, json, failure } = ctx;
  const gone = (id: string) => failure(`Agent ${id} not found`);
  /** The agent, when the caller may update it (a caller who may not sees "not found", never that it exists). */
  const editable = (id: string) =>
    agentStore.get(id) && (!actor || canResource(actor, 'agent', id, 'update')) && (!scope || homeProjectId('agent', id) === scope.projectId) ? agentStore.get(id) : undefined;
  const smoke = async (id: string, message: string, signal?: AbortSignal) => {
    try {
      return await smokeTest(id, message, signal ? { signal } : {});
    } catch (caught) {
      if (caught instanceof SmokeTestError) return { state: 'untested' as const, reason: caught.message };
      throw caught;
    }
  };

  for (const spec of TENANT_TOOLS) {
    const name = spec.name;
    if (!isTenantTool(name)) continue;
    server.registerTool(
      name,
      { title: name.replace(/_/g, ' '), description: spec.description, inputSchema: READ_INPUTS[name]!, annotations: READ_ONLY },
      async (args: Record<string, unknown>) => {
        const answer = await tenantTool(name, args, { actor, ...(scope && { projectId: scope.projectId }) });
        return answer.ok ? json(answer.text) : failure(answer.text);
      },
    );
  }

  server.registerTool(
    'create_agent',
    {
      title: 'Create an agent',
      description:
        'Save a new agent as a draft from a config (the shape of an exported agent: name, description, model {provider, model}, instructions in four parts, tools, persona, memory). Read read_agent_practices, list_tool_nodes, list_knowledge_bases, list_models and list_credentials first. The draft is smoke-tested once when it has a model; the reply has its id, the smoke state and the next step. It is never published here: test_agent, then publish_agent.',
      inputSchema: z.object({ config: agentConfigSchema, smokeMessage: z.string().max(4000).optional().describe('What to send it for the smoke test (default: asks what it does)') }),
      annotations: WRITE,
    },
    async ({ config, smokeMessage }) => {
      if (isProtectedEnvironment()) return failure(protectedMessage());
      const cfg = asConfig(config);
      // Fresh ids, as the import route does, so a config copied from another agent shares no schedule or channel state.
      const reid = <T extends { id: string }>(items: T[] | undefined, prefix: string) => items?.map((item) => ({ ...item, id: `${prefix}_${nanoid(8)}` }));
      const home = scope ? (actor ? creationProject(actor, scope.projectId) : scope.projectId) : actor ? creationProject(actor) : undefined;
      if (refusedForNewAgent(home ?? defaultProjectId(), cfg).length) return failure(REFUSED_CREDENTIAL_MESSAGE);
      const agent = createIn(
        home,
        'agent',
        () =>
          agentStore.create({
            ...cfg,
            skills: reid(cfg.skills, 'sk'),
            tools: reid(cfg.tools, 'tl'),
            schedules: reid(cfg.schedules, 'sc')?.map((s) => ({ ...s, enabled: false })),
            channels: reid(cfg.channels, 'ch')?.map((c) => ({ ...c, enabled: false })),
          }),
        (a) => a.id,
      );
      const result = agent.model?.model ? await smoke(agent.id, smokeMessage ?? DEFAULT_SMOKE) : { state: 'untested' as const, reason: 'Choose a model for this agent first' };
      return json({ id: agent.id, name: agent.name, published: false, smoke: result, next: result.state === 'passed' ? 'publish_agent' : 'fix the draft with update_agent, then test_agent' });
    },
  );

  server.registerTool(
    'update_agent',
    {
      title: 'Change an agent\'s draft',
      description: 'Replace fields of an agent\'s draft (as PUT /api/agents/:id does: the draft is saved whole from the config given, merged by the store; published versions stay as they are until publish_agent).',
      inputSchema: z.object({ id: z.string(), config: agentConfigSchema }),
      annotations: WRITE,
    },
    async ({ id, config }) => {
      if (isProtectedEnvironment()) return failure(protectedMessage());
      if (!editable(id)) return gone(id);
      if (refusedCredentials(id, config).length) return failure(REFUSED_CREDENTIAL_MESSAGE);
      const agent = agentStore.saveDraft(id, asConfig(config));
      return agent ? json({ id, name: agent.name, published: agent.published?.version ?? false, draftDiffers: agent.published ? JSON.stringify(configOf(agent)) !== JSON.stringify(configOf(agent.published.config)) : false }) : gone(id);
    },
  );

  server.registerTool(
    'test_agent',
    {
      title: 'Smoke-test an agent',
      description: 'Run the agent\'s draft once on a message with approvals denied (the smoke test): answers passed, failed or untested, its reply, and every tool call it made. The session is deleted after.',
      inputSchema: z.object({ id: z.string(), message: z.string().trim().min(1).max(4000) }),
      annotations: { ...WRITE, openWorldHint: true },
    },
    async ({ id, message }) => {
      if (!editable(id)) return gone(id);
      try {
        return json({ smoke: await smokeTest(id, message) });
      } catch (caught) {
        return caught instanceof SmokeTestError ? failure(caught.message) : failure((caught as Error).message);
      }
    },
  );

  server.registerTool(
    'publish_agent',
    {
      title: 'Publish an agent',
      description: 'Publish the draft as a new version through the eval gate: its test cases run first, and a score below the bar holds the publish (the reply then has the verdict and nothing is published). There is no way to skip the gate.',
      inputSchema: z.object({ id: z.string() }),
      annotations: { ...WRITE, openWorldHint: true },
    },
    async ({ id }) => {
      if (isProtectedEnvironment()) return failure(protectedMessage());
      const current = editable(id);
      if (!current) return gone(id);
      if (!current.model?.model) return failure('Choose a model before publishing');
      if (!hasPrompt(current)) return failure('Describe the persona or add instructions before publishing');
      const checked = JSON.stringify(configOf(current));
      let gate;
      try {
        gate = await checkPublish(id);
      } catch (caught) {
        return failure(`The eval gate could not run: ${(caught as Error).message}`);
      }
      if (!gate.verdict.ok) return json({ id, published: false, held: true, verdict: gate.verdict, ...(gate.run && { average: gate.run.average }) });
      const now = agentStore.get(id);
      if (!now || JSON.stringify(configOf(now)) !== checked) return failure('The draft changed while the eval gate was checking it. Publish again to check the new draft.');
      const agent = agentStore.publish(id)!;
      if (gate.run && agent.published) adoptRun(gate.run, agent.published.version);
      const kagent = await redeployIfDeployed(agent);
      return json({ id, published: agent.published?.version ?? true, ...(!gate.skipped && { verdict: gate.verdict }), ...(kagent && { kagent }) });
    },
  );
}
