/**
 * A project's settings for agents (PC13, docs/projects-and-goals.md#project-settings-for-agents): the patch schema and its
 * checks, the order of models, the allowed agents and tool kinds, the project's knowledge base, the two pickers, and a run
 * with nothing set being as it was. Made-up data; the model is a scripted stand-in.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, LanguageModel, ModelTurn, ToolSpec } from '@landflow/engine';
import type { ProjectSettingsView } from '@/lib/shared/project-policy';
import { PROJECT_TOOL_KINDS } from '@/lib/shared/project-policy';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-project-agent-settings-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });

interface Seen {
  model: string;
  system: string;
  tools: string[];
}
const seen: Seen[] = [];
type Step = (input: { system?: string; messages: AgentMessage[]; tools: ToolSpec[] }) => Partial<ModelTurn>;
const script: Step[] = [];

vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:11434',
  modelOptions: async () => [],
  agentModel: (config: { model?: string } | undefined): LanguageModel => {
    if (!config?.model) throw new Error('Choose a model for this agent first');
    return {
      provider: 'scripted',
      model: config.model,
      async generate(input) {
        seen.push({ model: config.model!, system: input.system ?? '', tools: input.tools.map((t) => t.name) });
        const step = script.shift();
        return { text: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, ...step?.(input as never) };
      },
    };
  },
}));

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession, runAgent } = await import('@/lib/server/agents/runtime');
const { credentials } = await import('@/lib/server/credentials/vault');
const projectsStore = await import('@/lib/server/projects/store');
const scopes = await import('@/lib/server/governance/scopes');
const { projectToolKind, projectAgentRules } = await import('@/lib/server/project-context/project-settings');
const { queryEvents } = await import('@/lib/server/audit/store');
await import('@/lib/server/project-context/provider');
await import('@/lib/server/goals/context-source');
const settingsRoute = await import('@/app/api/projects/[id]/settings/route');
const agentsRoute = await import('@/app/api/agents/route');
const { withTableScope } = await import('@/lib/server/datatables/projects');

registry.registerBuiltin(corePlugin);

/** A workflow node's own model (Run an Agent): already a model, not a setting. */
const flowModel: LanguageModel = {
  provider: 'scripted',
  model: 'flow-model',
  async generate() {
    seen.push({ model: 'flow-model', system: '', tools: [] });
    return { text: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
  },
};
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = async (id: string, body: unknown) => {
  const response = await settingsRoute.PATCH(new Request(`http://landflow.test/api/projects/${id}/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), params(id));
  return { status: response.status, body: (await response.json()) as ProjectSettingsView & { error?: string } };
};
const view = async (id: string) => (await (await settingsRoute.GET(new Request(`http://landflow.test/api/projects/${id}/settings`), params(id))).json()) as ProjectSettingsView;

let P = '';
let Q = '';
const makeAgent = (name: string, extra: Record<string, unknown> = {}) => agentStore.create({ name, instructions: 'Be brief.', ...extra });
const run = (agentId: string, projectId: string | undefined, extra: Record<string, unknown> = {}) => {
  const agent = agentStore.get(agentId)!;
  const session = newSession(agent, { source: 'test', userId: 'you', version: 'draft' });
  return runAgent({ agent, session, message: 'hello', ...(projectId && { context: { caller: 'chat' as const, agentId, projectId } }), ...extra } as never);
};
const errors = (session: { timeline: Array<{ type: string; message?: string }> }) => session.timeline.filter((e) => e.type === 'error').map((e) => e.message);
const notices = (session: { timeline: Array<{ type: string; message?: string }> }) => session.timeline.filter((e) => e.type === 'notice').map((e) => e.message);

beforeAll(() => {
  P = projectsStore.createTeamProject({ name: 'Payments' }).id;
  Q = projectsStore.createTeamProject({ name: 'Quiet' }).id;
});

describe('the patch schema and its checks', () => {
  it('saves each field, keeps the ones a patch does not name, and null clears', async () => {
    const credential = credentials.create({ name: 'Claude key', type: 'core.anthropicApi', data: { apiKey: 'dev-key' } });
    expect((await patch(P, { defaultModel: { provider: 'anthropic', model: 'claude-sonnet-5-5', credential: { id: credential.id, name: credential.name } } })).status).toBe(400);
    projectsStore.setHomeProject('credential', credential.id, P);
    const shared = makeAgent('Shared writer');
    projectsStore.addShare('agent', shared.id, P, 'user');
    const saved = await patch(P, {
      defaultModel: { provider: 'anthropic', model: 'claude-sonnet-5-5', credential: { id: credential.id, name: credential.name } },
      knowledge: { enabled: true, tool: { type: 'knowledge', name: 'Handbook', description: 'The handbook', store: 'sqlite', collection: 'handbook', embeddings: { provider: 'ollama', model: 'nomic-embed-text' } } },
      agents: { mode: 'allow', ids: [shared.id] },
      agentTools: { mode: 'allow', kinds: ['node', 'knowledge'] },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.settings).toMatchObject({
      defaultModel: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      knowledge: { enabled: true, tool: { id: 'project_knowledge', collection: 'handbook' } },
      agents: { mode: 'allow', ids: [shared.id] },
      agentTools: { mode: 'allow', kinds: ['node', 'knowledge'] },
    });
    expect(saved.body.availableAgents?.map((a) => a.id)).toContain(shared.id);
    // A patch of another field keeps all four.
    const kept = await patch(P, { fourEyes: true });
    expect(kept.body.settings).toMatchObject({ fourEyes: true, defaultModel: { model: 'claude-sonnet-5-5' }, knowledge: { enabled: true }, agents: { ids: [shared.id] }, agentTools: { kinds: ['node', 'knowledge'] } });
    // The audit says what changed, without a credential or a config.
    expect(queryEvents({ action: ['project.settings.update'] }, { limit: 1 }).events[0].details).toMatchObject({
      defaultModel: 'anthropic/claude-sonnet-5-5',
      knowledge: 'on',
      knowledgeTarget: 'handbook',
      agentsMode: 'allow',
      agentIds: [shared.id],
      toolsMode: 'allow',
      toolKinds: ['node', 'knowledge'],
    });
    const cleared = await patch(P, { defaultModel: null, knowledge: null, agents: { mode: 'off', ids: [] }, agentTools: { mode: 'off', kinds: [] } });
    expect(cleared.body.settings.defaultModel).toBeUndefined();
    expect(cleared.body.settings.knowledge).toBeUndefined();
    expect(cleared.body.settings.agents).toEqual({ mode: 'off', ids: [] });
    expect(projectAgentRules(P)).toBeUndefined();
  });

  it('refuses what the project cannot use or does not have', async () => {
    const stranger = makeAgent('Elsewhere');
    const refused = await patch(Q, { agents: { mode: 'allow', ids: [stranger.id] } });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe(`“${stranger.id}” isn’t available in this project`);
    expect((await patch(Q, { agents: { mode: 'allow', ids: Array.from({ length: 201 }, (_, i) => `a${i}`) } })).status).toBe(400);
    expect((await patch(Q, { agentTools: { mode: 'allow', kinds: ['telepathy'] } })).status).toBe(400);
    expect((await patch(Q, { defaultModel: { provider: 'carrier-pigeon', model: 'x' } })).status).toBe(400);
    expect((await patch(Q, { defaultModel: { provider: 'ollama', model: '' } })).status).toBe(400);
    const other = credentials.create({ name: 'Postgres', type: 'core.postgres', data: {} });
    projectsStore.setHomeProject('credential', other.id, Q);
    // Usable in the project, but not an Anthropic credential.
    expect((await patch(Q, { defaultModel: { provider: 'anthropic', model: 'm', credential: { id: other.id, name: other.name } } })).status).toBe(400);
    const outside = credentials.create({ name: 'Outside', type: 'core.postgres', data: {} });
    const knowledge = { enabled: true, tool: { type: 'knowledge', name: 'KB', description: '', store: 'pgvector', collection: 'c', credential: { id: outside.id, name: outside.name }, embeddings: { provider: 'ollama', model: 'e' } } };
    const noCredential = await patch(Q, { knowledge });
    expect(noCredential.status).toBe(400);
    expect(noCredential.body.error).toBe('That credential isn’t available in this project');
  });

  it('reads a broken value as absent', () => {
    const next = scopes.updateProjectSettings(Q, { fourEyes: false });
    expect(next.agents).toBeUndefined();
    expect(scopes.getProjectSettings(Q).defaultModel).toBeUndefined();
  });
});

describe('the run obeys the project', () => {
  it('uses the project default model last: flow, agent, then the project; none is the old error', async () => {
    scopes.updateProjectSettings(P, { defaultModel: { provider: 'ollama', model: 'proj-default' } });
    seen.length = 0;
    const bare = makeAgent('No model');
    expect((await run(bare.id, P)).session.timeline.some((e) => e.type === 'assistant')).toBe(true);
    expect(seen.at(-1)?.model).toBe('proj-default');
    const own = makeAgent('Own model', { model: { provider: 'ollama', model: 'agent-own' } });
    await run(own.id, P);
    expect(seen.at(-1)?.model).toBe('agent-own');
    await run(bare.id, P, { flow: { model: flowModel, tools: [] } });
    expect(seen.at(-1)?.model).toBe('flow-model');
    // Without a project default there is still the old error, and nothing is called.
    const before = seen.length;
    const none = await run(bare.id, Q);
    expect(errors(none.session)).toEqual(['Choose a model for this agent first']);
    expect(seen.length).toBe(before);
    scopes.updateProjectSettings(P, { defaultModel: null });
  });

  it('refuses an agent the project does not allow, with no model call; its own agents and listed ones pass', async () => {
    const shared = makeAgent('Visitor', { model: { provider: 'ollama', model: 'm1' } });
    projectsStore.addShare('agent', shared.id, P, 'user');
    const listed = makeAgent('Listed', { model: { provider: 'ollama', model: 'm1' } });
    projectsStore.addShare('agent', listed.id, P, 'user');
    const home = makeAgent('Resident', { model: { provider: 'ollama', model: 'm1' } });
    projectsStore.setHomeProject('agent', home.id, P);
    scopes.updateProjectSettings(P, { agents: { mode: 'allow', ids: [listed.id] } });
    seen.length = 0;
    const denied = await run(shared.id, P);
    expect(errors(denied.session)).toEqual(['“Visitor” isn\'t allowed in project “Payments” (Project settings → Agents)']);
    expect(denied.reason).toBe('error');
    expect(seen).toHaveLength(0);
    expect((await run(listed.id, P)).reason).toBe('completed');
    expect((await run(home.id, P)).reason).toBe('completed');
    // Another project is not affected.
    expect((await run(shared.id, Q)).reason).toBe('completed');
    // A sub-agent the project doesn't allow fails the tool call.
    const lead = makeAgent('Lead', { model: { provider: 'ollama', model: 'm1' }, tools: [{ id: 't1', type: 'agent', agentId: shared.id }] });
    projectsStore.setHomeProject('agent', lead.id, P);
    script.push(() => ({ toolCalls: [{ id: 'c1', name: 'ask_Visitor', input: { task: 'do it', reason: 'test' } }], stopReason: 'tool_use' }));
    const led = await run(lead.id, P);
    const tool = led.session.timeline.find((e) => e.type === 'tool');
    expect(tool).toMatchObject({ status: 'error' });
    expect(JSON.stringify(tool)).toContain('isn\'t allowed in project');
    scopes.updateProjectSettings(P, { agents: { mode: 'off', ids: [] } });
  });

  it('classifies tools by kind, and withholds a kind the project does not allow', async () => {
    expect(projectToolKind({ kind: 'node', label: 'x' } as never)).toBe('node');
    expect(projectToolKind({ kind: 'node', nodeType: 'core.mcpClientTool' } as never)).toBe('mcp');
    expect(projectToolKind({ kind: 'node', knowledge: true } as never)).toBe('knowledge');
    expect(projectToolKind({ kind: 'workflow' } as never)).toBe('workflow');
    expect(projectToolKind({ kind: 'agent' } as never)).toBe('agent');
    expect(projectToolKind({ kind: 'a2a' } as never)).toBe('a2a');
    for (const kind of ['flow', 'skill', 'memory', 'notebook', 'team']) expect(projectToolKind({ kind } as never)).toBeUndefined();
    expect(PROJECT_TOOL_KINDS).toHaveLength(6);

    const helper = makeAgent('Helper', { model: { provider: 'ollama', model: 'm1' } });
    projectsStore.setHomeProject('agent', helper.id, P);
    const boss = makeAgent('Boss', {
      model: { provider: 'ollama', model: 'm1' },
      tools: [{ id: 't1', type: 'agent', agentId: helper.id }],
      skills: [{ id: 's1', name: 'triage', whenToUse: 'always', instructions: 'Triage.' }],
    });
    projectsStore.setHomeProject('agent', boss.id, P);
    scopes.updateProjectSettings(P, { agentTools: { mode: 'allow', kinds: ['node'] } });
    seen.length = 0;
    const withheld = await run(boss.id, P);
    expect(notices(withheld.session)).toContain('Tool access: Helper withheld by project “Payments” settings');
    // Skills are never withheld; the sub-agent tool is.
    expect(seen.at(-1)?.tools).toContain('load_skill');
    expect(seen.at(-1)?.tools).not.toContain('ask_Helper');
    scopes.updateProjectSettings(P, { agentTools: { mode: 'allow', kinds: ['agent'] } });
    await run(boss.id, P);
    expect(seen.at(-1)?.tools).toContain('ask_Helper');
    scopes.updateProjectSettings(P, { agentTools: { mode: 'off', kinds: [] } });
  });

  it('adds the project knowledge base after the filter and never withholds it; a broken one is a notice', async () => {
    const agent = makeAgent('Reader', { model: { provider: 'ollama', model: 'm1' } });
    projectsStore.setHomeProject('agent', agent.id, P);
    scopes.updateProjectSettings(P, {
      agentTools: { mode: 'allow', kinds: [] },
      knowledge: { enabled: true, tool: { type: 'knowledge', name: 'Handbook', description: 'The handbook', store: 'memory', collection: 'handbook', embeddings: { provider: 'ollama', model: 'e' } } as never },
    });
    seen.length = 0;
    const result = await run(agent.id, P);
    expect(seen.at(-1)?.tools).toEqual(['project_knowledge']);
    expect(result.session.timeline.some((e) => e.type === 'error')).toBe(false);
    scopes.updateProjectSettings(P, { knowledge: { enabled: true, tool: { type: 'knowledge', source: 'node', name: 'Broken', description: '', nodeType: 'nope.nothing', parameters: {} } as never } });
    const broken = await run(agent.id, P);
    expect(notices(broken.session).some((m) => m?.startsWith('Tool unavailable: Broken'))).toBe(true);
    expect(seen.at(-1)?.tools).toEqual([]);
    scopes.updateProjectSettings(P, { knowledge: null, agentTools: { mode: 'off', kinds: [] } });
  });

  it('with nothing set the prompt and the tools are what they were', async () => {
    const helper = makeAgent('Pal', { model: { provider: 'ollama', model: 'm1' } });
    const agent = makeAgent('Plain', { model: { provider: 'ollama', model: 'm1' }, tools: [{ id: 't1', type: 'agent', agentId: helper.id }], skills: [{ id: 's1', name: 'triage', whenToUse: 'always', instructions: 'Triage.' }] });
    projectsStore.setHomeProject('agent', agent.id, Q);
    seen.length = 0;
    await run(agent.id, Q);
    const untouched = seen.at(-1)!;
    // Everything switched off in a saved row.
    scopes.updateProjectSettings(Q, { agents: { mode: 'off', ids: [] }, agentTools: { mode: 'off', kinds: [] }, knowledge: null, defaultModel: null });
    await run(agent.id, Q);
    const off = seen.at(-1)!;
    expect(off.tools).toEqual(untouched.tools);
    expect(off.system.replace(/Current date and time[^\n]*/, '')).toBe(untouched.system.replace(/Current date and time[^\n]*/, ''));
    expect(projectAgentRules(Q)).toBeUndefined();
  });
});

describe('the pickers', () => {
  it('list only the agents available and allowed in the project', async () => {
    const inList = makeAgent('Picked');
    const outList = makeAgent('Not picked');
    projectsStore.addShare('agent', inList.id, P, 'user');
    projectsStore.addShare('agent', outList.id, P, 'user');
    const own = makeAgent('Native');
    projectsStore.setHomeProject('agent', own.id, P);
    scopes.updateProjectSettings(P, { agents: { mode: 'allow', ids: [inList.id] } });
    const list = async () => ((await (await agentsRoute.GET(new Request(`http://landflow.test/api/agents?availableIn=${P}`))).json()) as { agents: Array<{ id: string }> }).agents.map((a) => a.id);
    const listed = await list();
    expect(listed).toContain(inList.id);
    expect(listed).toContain(own.id);
    expect(listed).not.toContain(outList.id);
    // The Run an Agent picker, with the project in scope.
    const options = ((await withTableScope({ projectId: P }, () => registry.loadOptions('core.messageAgent', 'agents', {}))) as Array<{ value: string }>).map((o) => o.value);
    expect(options).toContain(inList.id);
    expect(options).not.toContain(outList.id);
    // The agents page, with no project filter, shows everything.
    const all = ((await (await agentsRoute.GET(new Request('http://landflow.test/api/agents'))).json()) as { agents: Array<{ id: string }> }).agents.map((a) => a.id);
    expect(all).toContain(outList.id);
    scopes.updateProjectSettings(P, { agents: { mode: 'off', ids: [] } });
    expect(await list()).toContain(outList.id);
    expect((await view(P)).availableAgents?.map((a) => a.name)).toEqual(expect.arrayContaining(['Native', 'Not picked', 'Picked']));
  });
});
