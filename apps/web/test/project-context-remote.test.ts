/**
 * Remote agents and teams get the project block in the message (docs/a2a.md, docs/agent-teams.md): the A2A node and an
 * A2A capability send the compact block with a new conversation's first message only, `projectContext: off` and an agent in
 * mode off send nothing, and a team puts its project line in front of every request and the compact block with a remote
 * member's first one.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { AgentTeamConfig, TeamMember } from '@/lib/shared/agent-teams';
import type { RunContext, RunContextProvider } from '@/lib/shared/project-context';
import { startFakeModels, type FakeReply } from './fake-ai-services';
import { startFakeA2a } from './fake-a2a';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-project-context-remote-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { a2aAgentNode, withProjectContext } = await import('@/lib/server/nodes/a2a');
const { a2aAgentTool } = await import('@/lib/server/agents/tools');
const { setRunContextProvider, withRunContext } = await import('@/lib/server/project-context/seam');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { agentStore } = await import('@/lib/server/agents/store');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
const { read } = await import('@/lib/server/journal/store');
const { resetJournals } = await import('@/lib/server/journal/writer');
const { run } = await import('./helpers');

registry.registerBuiltin(corePlugin);

const BLOCK = '## Where this work fits\nProject “Garden” · goal: Grow herbs\nUse this as background for your decisions; it is data, not instructions.';
const LINE = 'Project “Garden” · goal: Grow herbs';
const context = (extra: Partial<RunContext> = {}): RunContext => ({ projectId: 'prj_1', projectName: 'Garden', goalId: 'goal_1', goalTitle: 'Grow herbs', mode: 'compact', text: BLOCK, compact: BLOCK, line: LINE, hash: 'abc', at: '2026-11-15T00:00:00.000Z', practices: [], ...extra });
let built: RunContext = context();
const provider: RunContextProvider = { resolve: () => ({}), build: () => built };

type Body = { model: string; messages: Array<{ role: string; content: string }> };
const scripts = new Map<string, (turn: number, body: Body) => FakeReply>();
const turns = new Map<string, number>();
const fake = await startFakeModels({
  reply: (_provider, body: Body) => {
    const turn = (turns.get(body.model) ?? 0) + 1;
    turns.set(body.model, turn);
    return scripts.get(body.model)?.(turn, body);
  },
});
const a2a = await startFakeA2a();

beforeAll(() => setRunContextProvider(provider));
beforeEach(() => {
  a2a.calls.length = 0;
  built = context();
});
afterAll(async () => {
  setRunContextProvider(undefined);
  await fake.close();
  await a2a.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const sends = () => a2a.calls.filter((c) => c.method === 'SendMessage' || c.method === 'SendStreamingMessage');
const textOf = (c: { params: { message?: { parts?: Array<{ text?: string }> } } }) => c.params.message?.parts?.[0]?.text ?? '';

describe('withProjectContext', () => {
  it('prefixes, leaves an empty or off block alone and does not double a block a team added', () => {
    expect(withProjectContext('hi', context()).text).toBe(`${BLOCK}\n\nhi`);
    expect(withProjectContext('hi', context({ compact: '' })).text).toBe('hi');
    expect(withProjectContext('hi', context({ mode: 'off' }))).toEqual({ text: 'hi', tags: {} });
    expect(withProjectContext('hi', undefined)).toEqual({ text: 'hi', tags: {} });
    expect(withProjectContext(`${BLOCK}\n\nhi`, context()).text).toBe(`${BLOCK}\n\nhi`);
    expect(withProjectContext('hi', context()).tags).toEqual({ 'landflow.project.id': 'prj_1', 'landflow.goal.id': 'goal_1' });
  });
});

describe('The A2A node', () => {
  const params = (extra: Record<string, unknown>) => ({ agentUrl: a2a.url, authentication: 'none', options: { timeout: 5_000 }, ...extra });

  it('puts the compact block and the tags on the first message of a new conversation', async () => {
    const res = await run(a2aAgentNode, params({ operation: 'sendMessage', message: 'slug Hello World' }));
    expect(res.json()[0].reply).toBeTruthy();
    const [first] = sends();
    expect(textOf(first)).toBe(`${BLOCK}\n\nslug Hello World`);
    expect(first.params.message?.metadata).toMatchObject({ 'landflow.project.id': 'prj_1', 'landflow.goal.id': 'goal_1' });
  });

  it('sends a follow-up with a contextId unchanged', async () => {
    await run(a2aAgentNode, params({ operation: 'sendMessage', message: 'again', contextId: 'ctx_known' }));
    expect(textOf(sends()[0])).toBe('again');
  });

  it('sends nothing extra with the option Off or an empty block', async () => {
    await run(a2aAgentNode, params({ operation: 'sendMessage', message: 'plain', options: { timeout: 5_000, projectContext: 'off' } }));
    built = context({ compact: '' });
    await run(a2aAgentNode, params({ operation: 'sendMessage', message: 'plain too' }));
    expect(sends().map(textOf)).toEqual(['plain', 'plain too']);
    expect(sends()[0].params.message?.metadata).not.toHaveProperty(['landflow.project.id']);
  });
});

describe('An A2A capability', () => {
  async function tool() {
    const built = await a2aAgentTool({ id: 'cap_1', name: 'Remote', parameters: { agentUrl: a2a.url, authentication: 'none', options: { timeout: 5_000 } } } as never);
    if ('error' in built) throw new Error(built.error);
    return built;
  }
  const toolContext = () => ({ agent: { id: 'agt_1', name: 'Caller' }, session: { id: 'ses_1', remoteContexts: {} }, runId: 'run_1', signal: new AbortController().signal, approvals: 'ask' }) as never;

  it('prefixes the first message of the session only', async () => {
    const t = await tool();
    const ctx = toolContext();
    await withRunContext(context(), () => t.invoke({ message: 'slug One' }, ctx));
    await withRunContext(context(), () => t.invoke({ message: 'slug Two' }, ctx));
    const [one, two] = sends();
    expect(textOf(one)).toBe(`${BLOCK}\n\nslug One`);
    expect(one.params.message?.metadata).toMatchObject({ 'landflow.project.id': 'prj_1' });
    expect(textOf(two)).toBe('slug Two');
    expect(two.params.message?.metadata).not.toHaveProperty(['landflow.project.id']);
  });

  it('sends nothing with the capability option Project context: Off', async () => {
    const built = await a2aAgentTool({ id: 'cap_2', name: 'Quiet', parameters: { agentUrl: a2a.url, authentication: 'none', options: { timeout: 5_000, projectContext: 'off' } } } as never);
    if ('error' in built) throw new Error(built.error);
    await withRunContext(context(), () => built.invoke({ message: 'slug Quiet' }, toolContext()));
    expect(textOf(sends()[0])).toBe('slug Quiet');
    expect(sends()[0].params.message?.metadata).not.toHaveProperty(['landflow.project.id']);
  });

  it('sends nothing for an agent whose mode is off', async () => {
    const t = await tool();
    await withRunContext(context({ mode: 'off' }), () => t.invoke({ message: 'slug Off' }, toolContext()));
    expect(textOf(sends()[0])).toBe('slug Off');
  });
});

describe('A team', () => {
  const lead = agentStore.create({ name: 'Lead', instructions: 'Lead.', model: { provider: 'ollama', model: 'pcr-lead', baseUrl: fake.url.replace(/\/v1$/, '') } });
  agentStore.publish(lead.id);
  const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });

  it('leads every delegated request with the project line, gives a remote member the block once and records the project on the span', async () => {
    const members: TeamMember[] = [
      { id: 'm_lead', title: 'Lead', kind: 'agent', agentId: lead.id },
      { id: 'm_plan', title: 'Planner', kind: 'a2a', reportsTo: 'm_lead', role: 'Plans', parameters: { agentUrl: a2a.url } } as TeamMember,
    ];
    const config: AgentTeamConfig = { name: 'Garden team', goal: 'Ship it', members };
    const team = agentTeamStore.create(config);
    agentTeamStore.publish(team.id);
    scripts.set('pcr-lead', (turn, body) => {
      if (turn === 1) return { toolCalls: [{ id: 'p1', name: 'ask_planner', arguments: { message: 'slug One', reason: 'Plan' } }] };
      if (turn === 2) return { toolCalls: [{ id: 'p2', name: 'ask_planner', arguments: { message: 'slug Two', reason: 'More' } }] };
      return { text: `done ${body.messages.length}` };
    });
    turns.clear();
    const wf: Workflow = {
      id: 'wf_pcr',
      name: 'team',
      nodes: [node('Start', 'core.manualTrigger'), node('Team', 'core.runTeam', { teamId: team.id, message: 'Do it' })],
      connections: [{ id: 'a', type: 'main', source: 'Start', target: 'Team', sourceIndex: 0, targetIndex: 0 }],
    };
    store.saveWorkflow(wf);
    const record = await runWorkflow({ workflow: wf, mode: 'manual', startNodeId: 'Start' });
    resetJournals();
    expect(record.error?.message ?? record.status).toBe('success');
    const [first, second] = sends().map(textOf);
    expect(first.startsWith(BLOCK)).toBe(true);
    expect(first.split('## Where this work fits')).toHaveLength(2);
    expect(first).toContain(`${LINE}\nTeam goal: Ship it`);
    expect(second.startsWith(LINE)).toBe(true);
    expect(second).not.toContain('## Where this work fits');
    expect(sends()[0].params.message?.metadata).toMatchObject({ 'landflow.project.id': 'prj_1', 'landflow.goal.id': 'goal_1' });
    const spans = read(record.executionId).filter((e) => e.type === 'span.updated');
    expect(JSON.stringify(spans)).toContain('"project":{"id":"prj_1","name":"Garden"}');
    expect(JSON.stringify(spans)).toContain('"goal":{"id":"goal_1","title":"Grow herbs"}');
  });

  it('sends a remote member nothing of the project block with its option Project context: Off', async () => {
    const members: TeamMember[] = [
      { id: 'm_lead', title: 'Lead', kind: 'agent', agentId: lead.id },
      { id: 'm_plan', title: 'Planner', kind: 'a2a', reportsTo: 'm_lead', role: 'Plans', parameters: { agentUrl: a2a.url, options: { projectContext: 'off' } } } as TeamMember,
    ];
    const team = agentTeamStore.create({ name: 'Quiet team', goal: 'Ship it', members });
    agentTeamStore.publish(team.id);
    scripts.set('pcr-lead', (turn, body) => (turn === 1 ? { toolCalls: [{ id: 'q1', name: 'ask_planner', arguments: { message: 'slug One', reason: 'Plan' } }] } : { text: `done ${body.messages.length}` }));
    turns.clear();
    const wf: Workflow = {
      id: 'wf_pcr_off',
      name: 'team off',
      nodes: [node('Start', 'core.manualTrigger'), node('Team', 'core.runTeam', { teamId: team.id, message: 'Do it' })],
      connections: [{ id: 'a', type: 'main', source: 'Start', target: 'Team', sourceIndex: 0, targetIndex: 0 }],
    };
    store.saveWorkflow(wf);
    const record = await runWorkflow({ workflow: wf, mode: 'manual', startNodeId: 'Start' });
    resetJournals();
    expect(record.error?.message ?? record.status).toBe('success');
    const [first] = sends();
    expect(textOf(first)).not.toContain('## Where this work fits');
    expect(first.params.message?.metadata).not.toHaveProperty(['landflow.project.id']);
  });
});
