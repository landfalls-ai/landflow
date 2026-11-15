import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, LanguageModel, ModelTurn, ToolSpec } from '@landflow/engine';
import type { Agent, AgentConfig, AgentSession } from '@/lib/shared/agents';
import type { ContextDataSource, ContextGoalData, ContextProjectData } from '@/lib/shared/project-context';

type Step = (input: { system?: string; messages: AgentMessage[]; tools: ToolSpec[] }) => Partial<ModelTurn>;
const script: Step[] = [];
const systems: string[] = [];
const scopeSeen: Array<string | undefined> = [];

vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:11434',
  modelOptions: async () => [],
  agentModel: (config: { model?: string } | undefined): LanguageModel => ({
    provider: 'scripted',
    model: config?.model ?? 'm',
    async generate(input) {
      systems.push(input.system ?? '');
      const step = script.shift();
      if (!step) throw new Error('The script ran out of turns');
      return { text: '', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, ...step(input as never) };
    },
  }),
}));

// A caller with no role in the project `p_none`; the synthetic owner would be an admin everywhere.
vi.mock('@/lib/server/projects/access', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/server/projects/access')>();
  return { ...real, projectRole: (actor: never, projectId: string | undefined) => (projectId === 'p_none' ? undefined : real.projectRole(actor, projectId)) };
});

vi.mock('@/lib/server/ai-usage', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/server/ai-usage')>();
  return { ...real, agentScope: (...args: Parameters<typeof real.agentScope>) => (scopeSeen.push(currentRunContext()?.projectId), real.agentScope(...args)) };
});

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { agentStore, configOf } = await import('@/lib/server/agents/store');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
const { setHomeProject, createTeamProject } = await import('@/lib/server/projects/store');
const { decide, newSession, runAgent } = await import('@/lib/server/agents/runtime');
const { cacheKey } = await import('@/lib/server/agents/response-cache');
const { configHash } = await import('@/lib/server/agents/semantic-cache');
const { personaPrompt } = await import('@/lib/shared/persona');
const { refFromSession, resolveRun, runLine } = await import('@/lib/server/project-context/resolve');
const { emptyContext, projectContextProvider } = await import('@/lib/server/project-context/provider');
const { setContextDataSource, currentRunContext } = await import('@/lib/server/project-context/seam');
const { POST: chat } = await import('@/app/api/agents/[id]/chat/route');

const goals: Record<string, ContextGoalData> = {
  goal_co: { id: 'goal_co', title: 'Halve close time', level: 'company', status: 'active', ownerName: 'Dana Example' },
  goal_proj: { id: 'goal_proj', title: 'Export invoices', level: 'project', status: 'active' },
  goal_team: { id: 'goal_team', title: 'Answer faster', level: 'project', status: 'active' },
  goal_flow: { id: 'goal_flow', title: 'Nightly checks', level: 'project', status: 'planned' },
  goal_caller: { id: 'goal_caller', title: 'Task goal', level: 'project', status: 'active' },
  goal_dead: { id: 'goal_dead', title: 'Dropped', level: 'project', status: 'cancelled' },
};
const chains: Record<string, string[]> = { goal_proj: ['goal_co', 'goal_proj'] };
const projects: Record<string, ContextProjectData> = {
  p_caller: { id: 'p_caller', name: 'Caller project', brief: 'Caller brief.', goalIds: [] },
  p_wf: { id: 'p_wf', name: 'Flow project', brief: 'Flow brief.', goalIds: ['goal_dead', 'goal_proj'] },
  p_team: { id: 'p_team', name: 'Team project', brief: 'Team brief.', goalIds: [] },
  p_home: { id: 'p_home', name: 'Home project', brief: 'Home brief.', goalIds: [] },
};
const source: ContextDataSource = {
  mission: () => 'Close the month in a day',
  project: (id) => projects[id],
  goalChain: (id) => (chains[id] ?? [id]).map((g) => goals[g]).filter(Boolean),
};

const reply = (text: string): Step => () => ({ text });
const call = (name: string, input: Record<string, unknown> = {}): Step => () => ({ toolCalls: [{ id: `call_${name}`, name, input }] });
const makeAgent = (config: Partial<AgentConfig> = {}): Agent => agentStore.create({ name: 'Helper', instructions: 'Be brief.', model: { provider: 'ollama', model: 'scripted-1' }, ...config });
const testSession = (agent: Agent, userId = 'you') => newSession(agent, { source: 'test', userId, version: 'draft' });
const AT = '2027-01-02T03:04:05.000Z';

beforeAll(() => registry.registerBuiltin(corePlugin));
beforeEach(() => {
  script.length = 0;
  systems.length = 0;
  scopeSeen.length = 0;
  setContextDataSource(source);
});
afterEach(() => {
  setContextDataSource(undefined);
  delete process.env.LANDFLOW_PROJECT_CONTEXT;
});

describe('which project and goal a run is in', () => {
  it('goes caller project, workflow home, team home, agent home', () => {
    const agent = makeAgent();
    setHomeProject('agent', agent.id, 'p_home');
    const team = agentTeamStore.create({ name: 'Desk' });
    setHomeProject('agentTeam', team.id, 'p_team');
    store.saveWorkflow({ id: 'wf_ctx', name: 'Nightly export', nodes: [], connections: [] } as never);
    setHomeProject('workflow', 'wf_ctx', 'p_wf');
    const table: Array<[Parameters<typeof resolveRun>[0], string]> = [
      [{ caller: 'workflow', workflowId: 'wf_ctx', teamId: team.id, agentId: agent.id, projectId: 'p_caller' }, 'p_caller'],
      [{ caller: 'workflow', workflowId: 'wf_ctx', teamId: team.id, agentId: agent.id }, 'p_wf'],
      [{ caller: 'team', teamId: team.id, agentId: agent.id }, 'p_team'],
      [{ caller: 'workflow', workflowId: 'agent:abc', teamId: team.id, agentId: agent.id }, 'p_team'],
      [{ caller: 'schedule', agentId: agent.id }, 'p_home'],
    ];
    for (const [ref, projectId] of table) expect(resolveRun(ref).projectId).toBe(projectId);
  });

  it('picks the goal: the caller, the team, the workflow, the project\'s first live one; cancelled goals never', () => {
    const agent = makeAgent();
    const team = agentTeamStore.create({ name: 'Desk', goalId: 'goal_team' });
    setHomeProject('agentTeam', team.id, 'p_team');
    store.saveWorkflow({ id: 'wf_goal', name: 'Checks', nodes: [], connections: [], settings: { goalId: 'goal_flow' } } as never);
    setHomeProject('workflow', 'wf_goal', 'p_wf');
    expect(agentTeamStore.get(team.id)!.draft.goalId).toBe('goal_team');
    expect(agentTeamStore.create({ name: 'x', goalId: 'nope' }).draft.goalId).toBeUndefined();
    expect(resolveRun({ caller: 'task', agentId: agent.id, teamId: team.id, workflowId: 'wf_goal', goalId: 'goal_caller' }).goalId).toBe('goal_caller');
    expect(resolveRun({ caller: 'team', agentId: agent.id, teamId: team.id, workflowId: 'wf_goal' }).goalId).toBe('goal_team');
    expect(resolveRun({ caller: 'workflow', agentId: agent.id, workflowId: 'wf_goal' }).goalId).toBe('goal_flow');
    expect(resolveRun({ caller: 'workflow', agentId: agent.id, workflowId: 'wf_goal', goalId: 'goal_dead' }).goalId).toBe('goal_flow');
    store.saveWorkflow({ id: 'wf_plain', name: 'Plain', nodes: [], connections: [] } as never);
    setHomeProject('workflow', 'wf_plain', 'p_wf');
    expect(resolveRun({ caller: 'workflow', agentId: agent.id, workflowId: 'wf_plain' }).goalId).toBe('goal_proj');
    expect(resolveRun({ caller: 'chat', agentId: agent.id, projectId: 'p_caller' }).goalId).toBeUndefined();
  });

  it('reads the ref from every kind of session', () => {
    const agent = makeAgent();
    const of = (source: AgentSession['source'], userId = 'u', extra: Partial<AgentSession> = {}) => refFromSession({ ...newSession(agent, { source, userId, version: 'draft' }), ...extra }, agent.id);
    expect(of('test')).toEqual({ caller: 'chat', agentId: agent.id });
    expect(of('schedule')).toMatchObject({ caller: 'schedule' });
    for (const channel of ['telegram', 'slack', 'teams'] as const) expect(of(channel)).toMatchObject({ caller: 'channel' });
    expect(of('agent', 'agent:x')).toMatchObject({ caller: 'agent' });
    expect(of('api')).toMatchObject({ caller: 'mcp' });
    const execution = { workflowId: 'wf_1', executionId: 'ex_1', nodeId: 'n1', nodeName: 'Check invoices' };
    expect(of('workflow', 'workflow:wf_1', { execution })).toEqual({ caller: 'workflow', agentId: agent.id, workflowId: 'wf_1', executionId: 'ex_1', nodeName: 'Check invoices' });
    expect(of('agent', 'team:t_1')).toEqual({ caller: 'team', agentId: agent.id, teamId: 't_1' });
    expect(of('agent', 'team:t_1', { execution })).toMatchObject({ caller: 'team', teamId: 't_1', workflowId: 'wf_1', nodeName: 'Check invoices' });
  });

  it('says what the run is', () => {
    store.saveWorkflow({ id: 'wf_line', name: 'Nightly export', nodes: [], connections: [] } as never);
    const team = agentTeamStore.create({ name: 'Desk' });
    expect(runLine({ caller: 'workflow', workflowId: 'wf_line', nodeName: 'Check invoices' })).toBe('workflow “Nightly export” → step “Check invoices”');
    expect(runLine({ caller: 'team', workflowId: 'wf_line', nodeName: 'Check invoices', teamId: team.id })).toBe('workflow “Nightly export” → step “Check invoices” → team “Desk”');
    expect(runLine({ caller: 'team', teamId: team.id })).toBe('team “Desk”');
    expect(
      (['chat', 'schedule', 'channel', 'agent', 'mcp', 'assistant'] as const).map((caller) => runLine({ caller })),
    ).toEqual(['a test chat', 'a scheduled run', 'a message from a chat channel', 'a task from another agent', 'a request over MCP', 'Spotlight']);
    expect(runLine({ caller: 'task', nodeName: 'Fix import' })).toBe('project task “Fix import”');
  });
});

describe('the block in a run', () => {
  const withProject = (config: Partial<AgentConfig> = {}) => {
    const agent = makeAgent({ skills: [{ id: 's1', name: 'triage', whenToUse: 'sorting tickets', instructions: 'Read.' }], ...config });
    setHomeProject('agent', agent.id, 'p_wf');
    return agent;
  };

  it('puts the block after the skills and before the "You are" line', async () => {
    const agent = withProject();
    script.push(reply('ok'));
    await runAgent({ agent, session: testSession(agent), message: 'hi' });
    const system = systems[0];
    expect(system).toContain('## Where this work fits (from project “Flow project”)');
    expect(system).toContain('Goal (company): Halve close time — owner Dana Example.');
    expect(system.indexOf('- triage: sorting tickets')).toBeLessThan(system.indexOf('## Where this work fits'));
    expect(system.indexOf('## Where this work fits')).toBeLessThan(system.indexOf('You are “Helper”'));
    expect(system).toContain('This run: a test chat.');
  });

  it('gives the old prompt byte for byte with the switch off, the variable off, or no source', async () => {
    const agent = withProject();
    const old = (at: string) => personaPrompt(configOf(agent), { now: new Date(at) });
    const dates = () => /Current date and time: (\S+Z)\./.exec(systems.at(-1)!)![1];
    script.push(reply('1'), reply('2'), reply('3'), reply('4'));
    await runAgent({ agent: { ...agent, projectContext: 'off' }, session: testSession(agent), message: 'hi' });
    expect(systems.at(-1)).toBe(old(dates()));
    process.env.LANDFLOW_PROJECT_CONTEXT = 'off';
    await runAgent({ agent, session: testSession(agent), message: 'hi' });
    expect(systems.at(-1)).toBe(old(dates()));
    delete process.env.LANDFLOW_PROJECT_CONTEXT;
    setContextDataSource(undefined);
    await runAgent({ agent, session: testSession(agent), message: 'hi' });
    expect(systems.at(-1)).toBe(old(dates()));
    setContextDataSource(source);
    await runAgent({ agent, session: testSession(agent), message: 'hi' });
    expect(systems.at(-1)).not.toBe(old(dates()));
  });

  it('sets the switch through the agent config and keeps only valid values', () => {
    const agent = makeAgent({ projectContext: 'compact' });
    expect(agentStore.get(agent.id)!.projectContext).toBe('compact');
    expect(makeAgent({ projectContext: 'bogus' as never }).projectContext).toBeUndefined();
    expect(agentStore.saveDraft(agent.id, { projectContext: 'off' })!.projectContext).toBe('off');
  });

  it('pins the date for a whole run and moves it for the next', async () => {
    const agent = withProject({ tools: [{ id: 't1', type: 'node', name: 'Echo', description: 'Echo', nodeType: 'core.noOp', parameters: {} }] });
    script.push(call('Echo', { a: 1 }), call('Echo', { a: 2 }), reply('done'));
    await runAgent({ agent, session: testSession(agent), message: 'go' });
    expect(systems).toHaveLength(3);
    const date = (s: string) => /Current date and time: (\S+Z)\./.exec(s)![1];
    expect(new Set(systems.map(date)).size).toBe(1);
    await new Promise((r) => setTimeout(r, 5));
    script.push(reply('again'));
    await runAgent({ agent, session: testSession(agent), message: 'go' });
    expect(date(systems[3])).not.toBe(date(systems[0]));
  });

  it('reuses the context and its date when an approval resumes the run', async () => {
    const agent = withProject({ tools: [{ id: 't1', type: 'node', name: 'Echo', description: 'Echo', nodeType: 'core.noOp', parameters: {}, requireApproval: true }] });
    script.push(call('Echo', { ok: true }));
    const paused = await runAgent({ agent, session: testSession(agent), message: 'go' });
    const stored = agentStore.getSession(paused.session.id)!;
    expect(stored.context?.projectId).toBe('p_wf');
    await new Promise((r) => setTimeout(r, 5));
    script.push(reply('done'));
    await decide(agent, paused.session.id, 'call_Echo', true);
    expect(systems[1]).toBe(systems[0]);
    expect(agentStore.getSession(paused.session.id)!.context?.at).toBe(stored.context!.at);
  });

  it('gives a sub-agent the parent\'s project', async () => {
    const child = makeAgent({ name: 'Child', instructions: 'Child work.' });
    setHomeProject('agent', child.id, 'p_home');
    const parent = withProject({ tools: [{ id: 'd1', type: 'agent', agentId: child.id }] });
    script.push(() => ({ toolCalls: [{ id: 'c1', name: 'ask_Child', input: { task: 'do it' } }] }), reply('child done'), reply('parent done'));
    const result = await runAgent({ agent: parent, session: testSession(parent), message: 'go' });
    expect(result.reply).toBe('parent done');
    const childSystem = systems.find((s) => s.includes('Child work.'))!;
    expect(childSystem).toContain('(from project “Flow project”)');
    expect(childSystem).toContain('This run: a task from another agent.');
  });

  it('opens each run\'s usage scope inside that run\'s own context', async () => {
    const child = makeAgent({ name: 'Child', instructions: 'Child work.' });
    setHomeProject('agent', child.id, 'p_home');
    const parent = withProject({ tools: [{ id: 'd1', type: 'agent', agentId: child.id }] });
    script.push(() => ({ toolCalls: [{ id: 'c1', name: 'ask_Child', input: { task: 'do it' } }] }), reply('child done'), reply('parent done'));
    await runAgent({ agent: parent, session: testSession(parent), message: 'go' });
    // The parent's own project first, then the child's: the child is in the parent's project (it inherits), never an outer run's by accident.
    expect(scopeSeen).toEqual(['p_wf', 'p_wf']);
    const solo = makeAgent();
    setHomeProject('agent', solo.id, 'p_home');
    scopeSeen.length = 0;
    script.push(reply('ok'));
    await runAgent({ agent: solo, session: testSession(solo), message: 'hi' });
    expect(scopeSeen).toEqual(['p_home']);
  });

  it('runs on with the old prompt when the block cannot be built, and frees the session', async () => {
    const agent = withProject();
    setContextDataSource({ ...source, project: () => { throw new Error('database is locked'); } });
    const session = testSession(agent);
    script.push(reply('first'), reply('second'));
    expect((await runAgent({ agent, session, message: 'hi' })).reply).toBe('first');
    expect(systems[0]).not.toContain('## Where this work fits');
    expect((await runAgent({ agent, session, message: 'again' })).reply).toBe('second');
  });

  it('keeps the cache key as it was without a block, and separates contexts with one', () => {
    const agent = makeAgent();
    const config = configOf(agent);
    expect(cacheKey(agent.id, config, 'Hello', '')).toBe(cacheKey(agent.id, config, 'Hello'));
    expect(cacheKey(agent.id, config, 'Hello', 'abc')).not.toBe(cacheKey(agent.id, config, 'Hello'));
    expect(cacheKey(agent.id, config, 'Hello', 'abc')).not.toBe(cacheKey(agent.id, config, 'Hello', 'abd'));
    expect(configHash(agent.id, config)).toBe(configHash(agent.id, config, ''));
    expect(configHash(agent.id, config, 'abc')).not.toBe(configHash(agent.id, config));
  });

  it('builds every context with no practices and a short hash of the text', () => {
    const ref = { caller: 'chat', projectId: 'p_wf' } as const;
    const full = projectContextProvider.build(ref, 'full', AT);
    const compact = projectContextProvider.build(ref, 'compact', AT);
    const off = projectContextProvider.build(ref, 'off', AT);
    expect(full).toMatchObject({ projectId: 'p_wf', projectName: 'Flow project', goalId: 'goal_proj', goalTitle: 'Export invoices', mode: 'full', at: AT });
    expect(full.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(full.line).toBe('Project “Flow project” · goal: Export invoices');
    expect(compact.text).toBe(full.compact);
    expect(compact.hash).not.toBe(full.hash);
    expect(off).toMatchObject({ projectId: 'p_wf', text: '', compact: '', line: '', hash: '', mode: 'off' });
    for (const context of [full, compact, off, emptyContext(AT)]) expect(context.practices).toEqual([]);
    expect(emptyContext(AT)).toMatchObject({ text: '', hash: '', at: AT });
  });
});

describe('a team run', () => {
  it('gives the lead the team\'s project, goal and run line', async () => {
    const lead = makeAgent({ name: 'Lead' });
    setHomeProject('agent', lead.id, 'p_home');
    const team = agentTeamStore.create({ name: 'Desk', goalId: 'goal_team', members: [{ id: 'm_lead', title: 'Lead', kind: 'agent', agentId: lead.id }] } as never);
    setHomeProject('agentTeam', team.id, 'p_team');
    agentTeamStore.publish(team.id);
    const { runTeam } = await import('@/lib/server/agent-teams/runtime');
    script.push(reply('done'));
    await runTeam({ team: { id: team.id, name: 'Desk' }, config: agentTeamStore.get(team.id)!.published!, message: 'Go', userId: 'test' });
    expect(systems[0]).toContain('(from project “Team project”)');
    expect(systems[0]).toContain('Answer faster');
    expect(systems[0]).toContain('team “Desk”');
  });
});

describe('the test chat', () => {
  const post = (id: string, body: unknown) =>
    chat(new Request(`http://localhost/api/agents/${id}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

  it('refuses a project the caller has no role in, and runs in one they have', async () => {
    const agent = makeAgent();
    script.push(reply('ok'));
    const denied = await post(agent.id, { message: 'hi', projectId: 'p_none' });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({ error: 'Project not found' });
    expect(agentStore.listSessions(agent.id)).toHaveLength(0);
    expect((await post(agent.id, { message: 'hi', projectId: 'p_made_up' })).status).toBe(404);
    const real = createTeamProject({ name: 'Caller project' });
    projects[real.id] = { id: real.id, name: 'Caller project', brief: 'Caller brief.', goalIds: [] };
    const allowed = await post(agent.id, { message: 'hi', projectId: real.id });
    expect(allowed.status).toBe(200);
    await allowed.text();
    const session = agentStore.getSession(agentStore.listSessions(agent.id)[0].id)!;
    expect(session.context).toMatchObject({ projectId: real.id, projectName: 'Caller project' });
    expect(systems[0]).toContain('(from project “Caller project”)');
    // A follow-up without the projectId stays in the project the chat began in.
    script.push(reply('again'));
    await (await post(agent.id, { message: 'more', sessionId: session.id })).text();
    expect(systems[1]).toContain('(from project “Caller project”)');
  });
});
