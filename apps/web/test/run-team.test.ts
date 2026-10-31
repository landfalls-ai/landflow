/**
 * Run a Team (nodes/run-team.ts, agent-teams/runtime.ts): the lead runs as a Landflow agent with one `ask_<title>` tool per
 * report; agent members run their own loops, remote members answer over A2A (the fake kagent-style agent). Models are
 * scripted per agent (each agent has its own model name on the fake Ollama).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { AgentTeamConfig, TeamMember } from '@/lib/shared/agent-teams';
import { startFakeModels, type FakeReply } from './fake-ai-services';
import { startFakeA2a } from './fake-a2a';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-run-team-'));
const ENV = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
};
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { agentStore } = await import('@/lib/server/agents/store');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
const { read } = await import('@/lib/server/journal/store');
const { resetJournals } = await import('@/lib/server/journal/writer');

registry.registerBuiltin(corePlugin);

type Body = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  tools?: Array<{ function: { name: string } }>;
};
/** What each agent's model does, by its model name: the calls made so far to it decide the turn. */
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
const call = (name: string, args: Record<string, unknown>, id = `c_${name}`) => ({ toolCalls: [{ id, name, arguments: args }] });
const lastTool = (body: Body) => [...body.messages].reverse().find((m) => m.role === 'tool')?.content ?? '';
const lastUser = (body: Body) => [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

afterAll(async () => {
  await fake.close();
  await a2a.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

function agent(name: string, model: string) {
  const created = agentStore.create({
    name,
    instructions: `You are ${name}.`,
    model: {
      provider: 'ollama',
      model,
      baseUrl: fake.url.replace(/\/v1$/, ''),
    },
  });
  agentStore.publish(created.id);
  return created;
}
const lead = agent('Tech Lead', 'lead-model');
const developer = agent('Developer agent', 'dev-model');

const remote = (id: string, title: string, extra: Partial<TeamMember> = {}): TeamMember =>
  ({
    id,
    title,
    kind: 'a2a',
    reportsTo: 'm_lead',
    role: `${title} role`,
    parameters: { agentUrl: a2a.url },
    ...extra,
  }) as TeamMember;

function team(members: TeamMember[], name = 'Plugin team') {
  const config: AgentTeamConfig = {
    name,
    goal: 'Ship the plugin, tested and reviewed',
    members: [{ id: 'm_lead', title: 'Tech Lead', kind: 'agent', agentId: lead.id }, ...members],
  };
  const created = agentTeamStore.create(config);
  agentTeamStore.publish(created.id);
  return created;
}

const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({
  id,
  name: id,
  type,
  typeVersion: 1,
  position: [0, 0],
  parameters,
});
const edge = (source: string, target: string, sourceIndex = 0) => ({
  id: `${source}-${target}-${sourceIndex}`,
  type: 'main' as const,
  source,
  target,
  sourceIndex,
  targetIndex: 0,
});

let n = 0;
async function run(teamId: string, message = 'Build the slugify plugin') {
  const wf: Workflow = {
    id: `wf_team_${++n}`,
    name: 'team',
    nodes: [node('Start', 'core.manualTrigger'), node('Team', 'core.runTeam', { teamId, message })],
    connections: [edge('Start', 'Team')],
  };
  store.saveWorkflow(wf);
  const record = await runWorkflow({
    workflow: wf,
    mode: 'manual',
    startNodeId: 'Start',
  });
  resetJournals();
  const outputs = record.runData.Team?.at(-1)?.outputs ?? [];
  return {
    record,
    done: outputs[0]?.[0]?.json as Record<string, unknown> | undefined,
    needs: outputs[1]?.[0]?.json as Record<string, unknown> | undefined,
    events: read(record.executionId),
  };
}

describe('Run a Team', () => {
  it('asks members by title with a reason, keeps one A2A conversation per member and carries the goal', async () => {
    const t = team([
      remote('m_plan', 'Planner'),
      {
        id: 'm_dev',
        title: 'Developer',
        kind: 'agent',
        agentId: developer.id,
        reportsTo: 'm_lead',
      } as TeamMember,
      remote('m_test', 'Tester', { reportsTo: 'm_dev' }),
    ]);
    scripts.set('lead-model', (turn, body) => {
      if (turn === 1) return call('ask_planner', { message: 'slug Hello World', reason: 'Plan first' }, 'p1');
      if (turn === 2) return call('ask_planner', { message: 'and again', reason: 'Follow up' }, 'p2');
      if (turn === 3) return call('ask_developer', { message: 'Build it', reason: 'Needs code' }, 'd1');
      return { text: `All done. Developer said: ${lastTool(body)}` };
    });
    scripts.set('dev-model', (turn, body) =>
      turn === 1 ? call('ask_tester', { message: 'slug test me', reason: 'Check it' }) : { text: `built, tests said ${lastTool(body).slice(0, 30)}` },
    );
    turns.clear();
    a2a.calls.length = 0;
    const { record, done, events } = await run(t.id);
    expect(record.error?.message ?? record.status).toBe('success');
    expect(done).toMatchObject({
      reply: expect.stringContaining('All done. Developer said: built'),
      team: { id: t.id, name: 'Plugin team', version: 1 },
    });
    expect(done!.members).toEqual([
      { title: 'Tech Lead', asked: 1, tokens: expect.any(Number) },
      { title: 'Planner', asked: 2, tokens: expect.any(Number) },
      { title: 'Developer', asked: 1, tokens: expect.any(Number) },
      { title: 'Tester', asked: 1, tokens: expect.any(Number) },
    ]);
    // The planner kept its conversation, and its first request carried the goal.
    const sends = a2a.calls.filter((c) => c.method === 'SendMessage' || c.method === 'SendStreamingMessage');
    const planner = sends.filter((c) => c.params.message?.parts?.[0]?.text?.includes('Hello World') || c.params.message?.parts?.[0]?.text?.includes('and again'));
    expect(planner).toHaveLength(2);
    expect(planner[0].params.message?.parts?.[0]?.text).toContain('Team goal: Ship the plugin, tested and reviewed');
    expect(planner[0].params.message?.parts?.[0]?.text).toContain("Tech Lead's current task: Build the slugify plugin");
    expect(planner[0].params.message?.contextId).toBeUndefined();
    expect(planner[1].params.message?.contextId).toBeTruthy();
    // The developer (a Landflow agent) got the lead's task as ancestry and ran with its own report.
    const devFirst = fake.requests.find((r) => r.body?.model === 'dev-model')!;
    expect(JSON.stringify(devFirst.body.messages)).toContain("Tech Lead's current task: Build the slugify plugin");
    expect(devFirst.body.tools.map((x: { function: { name: string } }) => x.function.name)).toContain('ask_tester');
    // The journal: members by title, the reason on the request, the chart on the node's span.
    const started = events.filter((e) => e.type === 'span.started' && e.kind === 'delegate');
    expect(started.map((e) => e.type === 'span.started' && e.name)).toEqual(expect.arrayContaining(['Planner', 'Developer', 'Tester']));
    const p1 = started.find((e) => e.type === 'span.started' && e.name === 'Planner');
    expect(p1).toMatchObject({
      actor: { name: 'Planner' },
      attrs: { reason: 'Plan first' },
    });
    const tester = started.find((e) => e.type === 'span.started' && e.name === 'Tester');
    const dev = started.find((e) => e.type === 'span.started' && e.name === 'Developer');
    // The tester was asked by the developer: its request hangs under the developer's.
    expect(tester && tester.type === 'span.started' && tester.parentSpanId).toBe(dev?.spanId);
    expect(tester && tester.type === 'span.started' && tester.caller?.name).toBe('Developer');
    const snapshot = events.find((e) => e.type === 'span.updated' && e.attrs?.team);
    expect(snapshot && snapshot.type === 'span.updated' && snapshot.attrs?.team).toMatchObject({
      id: t.id,
      version: 1,
      members: expect.arrayContaining([expect.objectContaining({ title: 'Tester', reportsTo: 'm_dev' })]),
    });
  });

  it('sends a remote member’s question to its manager, who answers with the next call', async () => {
    const t = team([remote('m_plan', 'Planner')]);
    scripts.set('lead-model', (turn, body) => {
      if (turn === 1) return call('ask_planner', { message: 'ask', reason: 'Need the plan' });
      if (turn === 2) {
        expect(lastTool(body)).toContain('Which colour?');
        return call('ask_planner', {
          message: 'blue',
          reason: 'Answering the colour question',
        });
      }
      return { text: `Plan: ${lastTool(body)}` };
    });
    turns.clear();
    a2a.calls.length = 0;
    const { done, needs } = await run(t.id);
    expect(needs).toBeUndefined();
    expect(done!.reply).toBe('Plan: You said: blue');
    const sends = a2a.calls.filter((c) => c.method !== 'GetTask');
    expect(sends[1].params.message?.taskId).toBeTruthy();
  });

  it('routes a question to a person when the member says so: Needs a person', async () => {
    const t = team([remote('m_plan', 'Planner', { questionsTo: 'person' })]);
    scripts.set('lead-model', (turn, body) =>
      turn === 1 ? call('ask_planner', { message: 'ask', reason: 'Need the plan' }) : { text: `Stopped: ${lastTool(body).slice(0, 40)}` },
    );
    turns.clear();
    const { done, needs } = await run(t.id);
    expect(done).toBeUndefined();
    expect(needs).toMatchObject({
      reason: expect.stringContaining('Planner has a question for a person: fake-agent asks'),
    });
  });

  it('makes the manager ask the reviewer before it reports done', async () => {
    const t = team([remote('m_dev', 'Developer'), remote('m_rev', 'Reviewer', { reviews: ['m_dev'] })]);
    scripts.set('lead-model', (turn, body) => {
      if (turn === 1) return call('ask_developer', { message: 'slug one', reason: 'Build' });
      if (turn === 2) return { text: 'Finished, no review needed.' };
      if (turn === 3) {
        expect(lastUser(body)).toContain("may not report done yet: Developer's work has not been reviewed by Reviewer");
        return call('ask_reviewer', {
          message: 'Please review the slug',
          reason: 'Required review',
        });
      }
      return { text: 'Finished after review.' };
    });
    turns.clear();
    a2a.calls.length = 0;
    const { done, needs, events } = await run(t.id);
    expect(needs).toBeUndefined();
    expect(done!.reply).toBe('Finished after review.');
    expect(a2a.calls.some((c) => JSON.stringify(c.params).includes('Please review the slug'))).toBe(true);
    expect(events.some((e) => e.type === 'check' && e.check.name === 'Review' && e.check.status === 'pass')).toBe(true);
  });

  it('sends the run to Needs a person when the reviewer is still not asked after two reminders', async () => {
    const t = team([remote('m_dev', 'Developer'), remote('m_rev', 'Reviewer', { reviews: ['m_dev'] })]);
    scripts.set('lead-model', (turn) => (turn === 1 ? call('ask_developer', { message: 'slug one', reason: 'Build' }) : { text: `Done, honest (${turn}).` }));
    turns.clear();
    const { done, needs, events } = await run(t.id);
    expect(done).toBeUndefined();
    expect(needs).toMatchObject({
      reply: 'Done, honest (4).',
      reason: "Reviewer has not reviewed Developer's work",
    });
    expect(events.some((e) => e.type === 'check' && e.check.name === 'Review' && e.check.status === 'fail')).toBe(true);
  });

  it('stops a member at its budget and tells its manager', async () => {
    // Every call of the fake model costs 20 tokens.
    const t = team([
      {
        id: 'm_dev',
        title: 'Developer',
        kind: 'agent',
        agentId: developer.id,
        reportsTo: 'm_lead',
        budgetTokens: 20,
      } as TeamMember,
    ]);
    scripts.set('lead-model', (turn, body) => (turn <= 2 ? call('ask_developer', { message: `job ${turn}`, reason: 'Work' }, `d${turn}`) : { text: `Result: ${lastTool(body)}` }));
    scripts.set('dev-model', () => ({ text: 'did it' }));
    turns.clear();
    const { done, events } = await run(t.id);
    expect(done!.reply).toContain('Developer is over its budget of 20 tokens');
    expect(done!.members).toContainEqual({
      title: 'Developer',
      asked: 1,
      tokens: 20,
      overBudget: true,
    });
    expect(events.filter((e) => e.type === 'check' && e.check.name === 'Budget').map((e) => e.type === 'check' && e.check.status)).toEqual(['fail']);
  });

  it('keeps what is connected to the node on the lead', async () => {
    const t = team([remote('m_plan', 'Planner')]);
    scripts.set('lead-model', () => ({ text: 'unused' }));
    const wf: Workflow = {
      id: `wf_team_${++n}`,
      name: 'team model',
      nodes: [node('Start', 'core.manualTrigger'), node('Team', 'core.runTeam', { teamId: t.id, message: 'go' }), node('Calculator', 'core.calculatorTool')],
      connections: [
        edge('Start', 'Team'),
        {
          id: 'c-t',
          type: 'ai_tool',
          source: 'Calculator',
          target: 'Team',
          sourceIndex: 0,
          targetIndex: 0,
        },
      ],
    };
    store.saveWorkflow(wf);
    turns.clear();
    const before = fake.requests.length;
    await runWorkflow({ workflow: wf, mode: 'manual', startNodeId: 'Start' });
    const names = fake.requests[before].body.tools.map((x: { function: { name: string } }) => x.function.name);
    expect(names).toEqual(expect.arrayContaining(['Calculator', 'ask_planner']));
  });

  it('is refused for a team that was never published', async () => {
    const draft = agentTeamStore.create({
      name: 'Draft',
      members: [{ id: 'm_lead', title: 'Lead', kind: 'agent', agentId: lead.id }],
    });
    const wf: Workflow = {
      id: `wf_team_${++n}`,
      name: 'draft',
      nodes: [node('Start', 'core.manualTrigger'), node('Team', 'core.runTeam', { teamId: draft.id, message: 'go' })],
      connections: [edge('Start', 'Team')],
    };
    store.saveWorkflow(wf);
    const record = await runWorkflow({
      workflow: wf,
      mode: 'manual',
      startNodeId: 'Start',
    });
    expect(record.status).toBe('error');
    expect(record.error?.message).toContain('Publish “Draft” first');
  });
});
