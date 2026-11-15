/**
 * Practices for remote agents (docs/practices.md#kagent-agents-and-a2a): the index a Landflow agent on kagent gets with a new
 * request (an A2A node, an A2A capability, a team's remote member), `practices_for` and `practice_cite` on its MCP server,
 * and the citations in a remote answer. A fake practices source and port stand in for the store.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runNode } from '@landflow/sdk';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { ApprovedPractice } from '@/lib/shared/practices';
import type { PracticesQuery, RunContext, RunContextProvider } from '@/lib/shared/project-context';
import type { AgentTeamConfig, TeamMember } from '@/lib/shared/agent-teams';
import { startFakeModels, type FakeReply } from './fake-ai-services';
import { startFakeA2a } from './fake-a2a';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-practices-remote-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { a2aAgentNode } = await import('@/lib/server/nodes/a2a');
const { a2aAgentTool } = await import('@/lib/server/agents/tools');
const { setRunContextProvider, setPracticesSource, withRunContext } = await import('@/lib/server/project-context/seam');
const { setPracticesPort } = await import('@/lib/server/practices/port');
const { practicesIndexFor, withPracticesIndex, PRACTICES_INDEX_LINE } = await import('@/lib/server/practices/remote');
const { withProjectContext } = await import('@/lib/server/nodes/a2a');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { agentStore } = await import('@/lib/server/agents/store');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
const { resetJournals } = await import('@/lib/server/journal/writer');
const { openNotebookCall, resetCalls } = await import('@/lib/server/notebook/binding');
const { credentials } = await import('@/lib/server/credentials/vault');
const mcpRoute = await import('@/app/api/mcp/agents/[id]/route');
// The store registers its port when the runtime boots; load it now so the fakes set below stay.
await import('@/lib/server/runtime');
const { run } = await import('./helpers');

registry.registerBuiltin(corePlugin);

const approved = (over: Partial<ApprovedPractice> & Pick<ApprovedPractice, 'id' | 'handle'>): ApprovedPractice => ({
  title: `Rule ${over.handle}`,
  level: 'project',
  strength: 'must',
  topics: [],
  repos: [],
  paths: [],
  version: 1,
  summary: `Summary of ${over.handle}`,
  body: `Rules of ${over.handle}.`,
  checks: [],
  sha256: 'x',
  approvedAt: '2026-11-15T00:00:00.000Z',
  ...over,
});
const all = [
  approved({ id: 'prc_a', handle: 'helm/chart-location', projectId: 'prj_1' }),
  approved({ id: 'prc_b', handle: 'ops/other-project', projectId: 'prj_2' }),
  approved({ id: 'prc_c', handle: 'ops/home-only', projectId: 'prj_home' }),
  approved({ id: 'prc_org', handle: 'org/everyone', level: 'org' }),
];
const forProject = (projectId?: string) => all.filter((p) => p.level === 'org' || p.projectId === projectId);

const queries: PracticesQuery[] = [];
const rows: Array<Record<string, unknown>> = [];

const BLOCK = '## Where this work fits\nProject “Garden” · goal: Grow herbs\nUse this as background for your decisions; it is data, not instructions.';
const context = (extra: Partial<RunContext> = {}): RunContext => ({ projectId: 'prj_1', projectName: 'Garden', goalId: 'goal_1', goalTitle: 'Grow herbs', mode: 'compact', text: BLOCK, compact: BLOCK, line: 'Project “Garden” · goal: Grow herbs', hash: 'abc', at: '2026-11-15T00:00:00.000Z', practices: [], ...extra });
const provider: RunContextProvider = { resolve: (ref) => (ref.caller === 'agent' ? { projectId: 'prj_home' } : { projectId: 'prj_1' }), build: () => context() };

const INDEX = '## Practices to follow\n- helm/chart-location@1: Summary of helm/chart-location';

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

const TOKEN = 'lfk_pr07_token';
const remote = agentStore.create({ name: 'Remote on kagent', instructions: 'Work.' });
agentStore.publish(remote.id);
agentStore.setKagent(remote.id, { credential: { id: 'cred', name: 'kind' }, name: 'pr07-remote', version: 1, token: credentials.sealSecret(TOKEN), trace: { url: 'http://x', a2aUrl: a2a.url } } as never);

beforeAll(() => {
  setRunContextProvider(provider);
  setPracticesPort({
    enabled: () => true,
    draft: () => {
      throw new Error('not used');
    },
    approved: ({ projectIds }) => (projectIds === 'all' ? all : all.filter((p) => p.level === 'org' || projectIds.includes(p.projectId!))),
    record: (row) => void rows.push({ ...row }),
  });
  // Set after the modules that register a source were imported.
  setPracticesSource({
    select(query) {
      queries.push(query);
      const list = forProject(query.projectId).filter((p) => p.handle !== 'org/everyone');
      const practices = list.map((p) => ({ handle: p.handle, version: p.version }));
      return { text: practices.length ? `## Practices to follow\n${practices.map((p) => `- ${p.handle}@${p.version}: Summary of ${p.handle}`).join('\n')}` : '', practices };
    },
  });
});
beforeEach(() => {
  a2a.calls.length = 0;
  queries.length = 0;
  rows.length = 0;
  resetCalls();
});
afterAll(async () => {
  setRunContextProvider(undefined);
  setPracticesSource(undefined);
  setPracticesPort(undefined);
  await fake.close();
  await a2a.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const sends = () => a2a.calls.filter((c) => c.method === 'SendMessage' || c.method === 'SendStreamingMessage');
// A Landflow agent on kagent also gets the trace marker (a comment before the text): not what these tests look at.
const textOf = (c: { params: { message?: { parts?: Array<{ text?: string }> } } }) => (c.params.message?.parts?.[0]?.text ?? '').replace(/^<!-- landflow-trace [^>]*-->\n*/, '');
const plain = { handle: 'helm/chart-location', version: 1 };

describe('withPracticesIndex', () => {
  it('puts the index and its line between the project block and the task, and nothing for an empty index', () => {
    const indexed = withPracticesIndex('do it', INDEX);
    expect(indexed).toBe(`${INDEX}\n\n${PRACTICES_INDEX_LINE}\n\ndo it`);
    expect(withProjectContext(indexed, context()).text).toBe(`${BLOCK}\n\n${INDEX}\n\n${PRACTICES_INDEX_LINE}\n\ndo it`);
    expect(withPracticesIndex(`${BLOCK}\n\ndo it`, INDEX, BLOCK)).toBe(`${BLOCK}\n\n${INDEX}\n\n${PRACTICES_INDEX_LINE}\n\ndo it`);
    expect(withPracticesIndex('do it', '')).toBe('do it');
    expect(withPracticesIndex(indexed, INDEX)).toBe(indexed);
  });

  it('is only built for a Landflow agent on kagent, with the option on', () => {
    expect(practicesIndexFor(a2a.url, undefined, 'task', 'prj_1')).toMatchObject({ agentId: remote.id, practices: [expect.objectContaining(plain)] });
    expect(practicesIndexFor('http://elsewhere.test/agents/kagent/other', undefined, 'task', 'prj_1')).toBeUndefined();
    expect(practicesIndexFor(a2a.url, 'off', 'task', 'prj_1')).toBeUndefined();
    expect(queries.at(-1)).toMatchObject({ size: 'index', projectId: 'prj_1', agentId: remote.id });
    expect(practicesIndexFor(a2a.url, undefined, 'x'.repeat(900), 'prj_1') && queries.at(-1)?.task).toHaveLength(500);
  });
});

describe('The A2A node', () => {
  const params = (extra: Record<string, unknown>) => ({ agentUrl: a2a.url, authentication: 'none', options: { timeout: 5_000 }, ...extra });

  it('sends the index with the first message only, after the project block', async () => {
    await run(a2aAgentNode, params({ operation: 'sendMessage', message: 'slug One' }));
    await run(a2aAgentNode, params({ operation: 'sendMessage', message: 'again', contextId: 'ctx_known' }));
    const [first, second] = sends().map(textOf);
    expect(first).toBe(`${BLOCK}\n\n${INDEX}\n\n${PRACTICES_INDEX_LINE}\n\nslug One`);
    expect(second).toBe('again');
    expect(rows.filter((r) => r.kind === 'delivered')).toEqual([]);
  });

  it('sends nothing with the option Off, and nothing new to an endpoint that is not a Landflow agent on kagent', async () => {
    await run(a2aAgentNode, params({ operation: 'sendMessage', message: 'quiet', options: { timeout: 5_000, practices: 'off' } }));
    expect(textOf(sends()[0])).toBe(`${BLOCK}\n\nquiet`);
    // The same fake agent, reached by an address no Landflow agent has.
    const other = agentStore.get(remote.id)!;
    agentStore.setKagent(remote.id, { ...other.kagent!, trace: { url: 'http://x', a2aUrl: 'http://elsewhere.test/agents/kagent/else' } });
    try {
      await run(a2aAgentNode, params({ operation: 'sendMessage', message: 'unchanged' }));
      expect(textOf(sends()[1])).toBe(`${BLOCK}\n\nunchanged`);
    } finally {
      agentStore.setKagent(remote.id, other.kagent);
    }
  });

  it('records one cited row for an indexed practice an answer cites, and none for one it was not given', async () => {
    await run(a2aAgentNode, params({ operation: 'sendMessage', message: 'Done.\nPractices followed: [helm/chart-location@1], [ops/other-project@1]' }));
    const cited = rows.filter((r) => r.kind === 'cited');
    expect(cited).toHaveLength(1);
    expect(cited[0]).toMatchObject({ practiceId: 'prc_a', version: 1, agentId: remote.id, executionId: 'ex_test' });
  });
});

describe('The A2A node used as a tool', () => {
  it('records one row when the answer to the remote agent’s question cites, from the node state', async () => {
    let saved: Record<string, unknown> | undefined;
    const extras = { mode: 'tool', getNodeState: () => saved, setNodeState: (v: Record<string, unknown>) => void (saved = v) } as never;
    const params = (message: string) => ({ agentUrl: a2a.url, authentication: 'none', options: { timeout: 5_000 }, operation: 'sendMessage', message });
    const asTool = (message: string) =>
      runNode(a2aAgentNode, { protocol: 'landflow.plugin/v1', executionId: 'ex_tool', workflowId: 'wf_tool', mode: 'tool', node: { id: 'n1', name: 'Remote', type: 'core.a2aAgent', typeVersion: 1 }, parameters: params(message), itemParameters: [params(message)], inputs: [[{ json: {} }]] } as never, extras);
    await withRunContext(context(), () => asTool('ask'));
    expect(saved?.practices).toBeTruthy();
    expect(rows.filter((r) => r.kind === 'cited')).toHaveLength(0);
    await withRunContext(context(), () => asTool('Done.\nPractices followed: [helm/chart-location@1]'));
    expect(rows.filter((r) => r.kind === 'cited')).toHaveLength(1);
  });
});

describe('An A2A capability', () => {
  const toolContext = () => ({ agent: { id: 'agt_1', name: 'Caller' }, session: { id: 'ses_1', remoteContexts: {}, execution: { executionId: 'exec_cap', workflowId: 'wf', nodeId: 'n' } }, runId: 'run_1', signal: new AbortController().signal, approvals: 'ask' }) as never;
  async function tool(options: Record<string, unknown> = {}) {
    const built = await a2aAgentTool({ id: 'cap_1', name: 'Remote', parameters: { agentUrl: a2a.url, authentication: 'none', options: { timeout: 5_000, ...options } } } as never);
    if ('error' in built) throw new Error(built.error);
    return built;
  }

  it('sends the index with the session’s first message and records its citation; a follow-up goes as it is', async () => {
    const t = await tool();
    const ctx = toolContext();
    await withRunContext(context(), () => t.invoke({ message: 'Done.\nPractices followed: [helm/chart-location@1]' }, ctx));
    await withRunContext(context(), () => t.invoke({ message: 'next' }, ctx));
    const [one, two] = sends().map(textOf);
    expect(one).toContain(INDEX);
    expect(one).toBe(`${BLOCK}\n\n${INDEX}\n\n${PRACTICES_INDEX_LINE}\n\nDone.\nPractices followed: [helm/chart-location@1]`);
    expect(two).toBe('next');
    expect(rows.filter((r) => r.kind === 'cited')).toHaveLength(1);
    expect(rows[0]).toMatchObject({ executionId: 'exec_cap' });
  });

  it('records the citation of an answer after a tool approval, through a tool built again for the resumed run', async () => {
    const ctx = toolContext();
    const paused = await withRunContext(context(), async () => (await tool()).invoke({ message: 'upper hello\nPractices followed: [helm/chart-location@1]' }, ctx));
    expect(paused.pause).toBeTruthy();
    expect(rows.filter((r) => r.kind === 'cited')).toHaveLength(0);
    // The saved state is JSON; the resumed run builds its tool again.
    const state = JSON.parse(JSON.stringify(paused.pause!.remote.state));
    const second = await tool();
    const done = await second.resume!(state, true, ctx);
    expect(String(done.output)).toContain('HELLO');
    const cited = rows.filter((r) => r.kind === 'cited');
    expect(cited).toHaveLength(1);
    expect(cited[0]).toMatchObject({ practiceId: 'prc_a', executionId: 'exec_cap' });
  });

  it('records nothing for a question to the caller, and one row for the answering call', async () => {
    const t = await tool();
    const ctx = toolContext();
    const asked = await withRunContext(context(), () => t.invoke({ message: 'ask' }, ctx));
    expect(String(asked.output)).toContain('Which colour?');
    expect(rows.filter((r) => r.kind === 'cited')).toHaveLength(0);
    await withRunContext(context(), () => t.invoke({ message: 'Done.\nPractices followed: [helm/chart-location@1]' }, ctx));
    expect(rows.filter((r) => r.kind === 'cited')).toHaveLength(1);
  });

  it('sends no index with the capability option Off', async () => {
    const t = await tool({ practices: 'off' });
    await withRunContext(context(), () => t.invoke({ message: 'plain' }, toolContext()));
    expect(textOf(sends()[0])).toBe(`${BLOCK}\n\nplain`);
  });
});

describe('A team', () => {
  const lead = agentStore.create({ name: 'Lead', instructions: 'Lead.', model: { provider: 'ollama', model: 'pr07-lead', baseUrl: fake.url.replace(/\/v1$/, '') } });
  agentStore.publish(lead.id);
  const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });

  it('gives a remote member the index on its first request, and not on a follow-up', async () => {
    const members: TeamMember[] = [
      { id: 'm_lead', title: 'Lead', kind: 'agent', agentId: lead.id },
      { id: 'm_plan', title: 'Planner', kind: 'a2a', reportsTo: 'm_lead', role: 'Plans', parameters: { agentUrl: a2a.url } } as TeamMember,
    ];
    const config: AgentTeamConfig = { name: 'Practice team', goal: 'Ship it', members };
    const team = agentTeamStore.create(config);
    agentTeamStore.publish(team.id);
    scripts.set('pr07-lead', (turn, body) => {
      if (turn === 1) return { toolCalls: [{ id: 'p1', name: 'ask_planner', arguments: { message: 'Practices followed: [helm/chart-location@1]', reason: 'Plan' } }] };
      if (turn === 2) return { toolCalls: [{ id: 'p2', name: 'ask_planner', arguments: { message: 'slug Two', reason: 'More' } }] };
      return { text: `done ${body.messages.length}` };
    });
    turns.clear();
    const wf: Workflow = {
      id: 'wf_pr07',
      name: 'team',
      nodes: [node('Start', 'core.manualTrigger'), node('Team', 'core.runTeam', { teamId: team.id, message: 'Do it' })],
      connections: [{ id: 'a', type: 'main', source: 'Start', target: 'Team', sourceIndex: 0, targetIndex: 0 }],
    };
    store.saveWorkflow(wf);
    const record = await runWorkflow({ workflow: wf, mode: 'manual', startNodeId: 'Start' });
    resetJournals();
    expect(record.error?.message ?? record.status).toBe('success');
    const [first, second] = sends().map(textOf);
    expect(first.split(PRACTICES_INDEX_LINE)).toHaveLength(2);
    expect(first.split(BLOCK)).toHaveLength(2);
    expect(first.startsWith(`${BLOCK}\n\n${INDEX}\n\n${PRACTICES_INDEX_LINE}\n\n`)).toBe(true);
    expect(first.indexOf(INDEX)).toBeLessThan(first.indexOf('Practices followed: [helm'));
    expect(second).not.toContain(PRACTICES_INDEX_LINE);
    const cited = rows.filter((r) => r.kind === 'cited');
    expect(cited).toHaveLength(1);
    expect(cited[0]).toMatchObject({ practiceId: 'prc_a', executionId: record.executionId });
  });
});

describe('the tools on the agent’s kagent MCP server', () => {
  type Rpc = { result?: { tools?: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>; content?: Array<{ text: string }>; isError?: boolean } };
  async function rpc(method: string, params: unknown): Promise<Rpc> {
    const request = new Request(`http://localhost/api/mcp/agents/${remote.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const raw = await (await (mcpRoute.POST as unknown as (r: Request, c: unknown) => Promise<Response>)(request, { params: Promise.resolve({ id: remote.id }) })).text();
    return JSON.parse(raw.includes('data:') ? raw.split('\n').find((l) => l.startsWith('data:'))!.slice(5) : raw) as Rpc;
  }
  const call = async (name: string, args: Record<string, unknown>) => (await rpc('tools/call', { name, arguments: args })).result!;
  const bind = (runId: string, projectId?: string) =>
    ({ team: { id: 'team_x', name: 'T' }, runId, ...(projectId && { projectId }), member: { id: 'm', title: 'M' }, manager: false, content: 'full' as const });

  it('lists both tools whatever the run', async () => {
    const listed = (await rpc('tools/list', {})).result!.tools!;
    expect(listed.map((t) => t.name)).toEqual(expect.arrayContaining(['practices_for', 'practice_cite']));
  });

  it('practices_for with one open call gives that project’s rules in full and records them as delivered for the run', async () => {
    const open = openNotebookCall(a2a.url, bind('exec_one', 'prj_1'));
    try {
      const answer = await call('practices_for', {});
      expect(answer.isError).toBeFalsy();
      const body = JSON.parse(answer.content![0].text) as { practices: Array<{ handle: string; body: string }> };
      expect(body.practices).toMatchObject([{ handle: 'helm/chart-location', body: 'Rules of helm/chart-location.' }]);
      expect(queries.at(-1)).toMatchObject({ projectId: 'prj_1', agentId: remote.id, size: 'full' });
      expect(rows).toEqual([expect.objectContaining({ practiceId: 'prc_a', kind: 'delivered', executionId: 'exec_one', agentId: remote.id })]);
      const one = await call('practices_for', { handle: 'ops/other-project' });
      expect(one.content![0].text).toBe('No approved practice ops/other-project applies here');
    } finally {
      open.close();
    }
  });

  it('with no open call it uses the agent’s home project', async () => {
    const answer = await call('practices_for', { handle: 'ops/home-only', repo: 'acme/app' });
    expect(JSON.parse(answer.content![0].text).practices).toMatchObject([{ handle: 'ops/home-only' }]);
    expect(queries.at(-1)).toMatchObject({ projectId: 'prj_home', repo: 'acme/app' });
    expect(rows[0]).toMatchObject({ practiceId: 'prc_c', kind: 'delivered' });
    expect(rows[0]).not.toHaveProperty('executionId');
  });

  it('with two open calls it asks for the run key, and the key picks the run', async () => {
    const one = openNotebookCall(a2a.url, bind('exec_a', 'prj_1'));
    const two = openNotebookCall(a2a.url, bind('exec_b', 'prj_2'));
    try {
      const unclear = await call('practices_for', {});
      expect(unclear.isError).toBe(true);
      expect(unclear.content![0].text).toContain(one.key);
      expect(unclear.content![0].text).toContain(two.key);
      expect(rows).toEqual([]);
      const keyed = await call('practices_for', { run: two.key });
      expect(JSON.parse(keyed.content![0].text).practices).toMatchObject([{ handle: 'ops/other-project' }]);
      expect(rows[0]).toMatchObject({ practiceId: 'prc_b', executionId: 'exec_b' });
    } finally {
      one.close();
      two.close();
    }
  });

  it('practice_cite records a practice that applies in the project and not one that does not', async () => {
    const open = openNotebookCall(a2a.url, bind('exec_cite', 'prj_1'));
    try {
      const answer = await call('practice_cite', { cited: ['helm/chart-location@1', 'ops/other-project@1', 'nope@3'] });
      expect(JSON.parse(answer.content![0].text)).toEqual({ recorded: ['helm/chart-location@1'], unknown: ['ops/other-project@1', 'nope@3'] });
      expect(rows).toEqual([expect.objectContaining({ practiceId: 'prc_a', kind: 'cited', executionId: 'exec_cite' })]);
      expect((await call('practice_cite', { cited: Array.from({ length: 21 }, (_, i) => `a/b@${i + 1}`) })).isError).toBe(true);
    } finally {
      open.close();
    }
  });
});
