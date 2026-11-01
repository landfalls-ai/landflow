/**
 * Run a Team (nodes/run-team.ts, agent-teams/runtime.ts): the lead runs as a Landflow agent with one `ask_<title>` tool per
 * report; agent members run their own loops, remote members answer over A2A (the fake kagent-style agent). Models are
 * scripted per agent (each agent has its own model name on the fake Ollama).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { toToolName, type Workflow, type WorkflowNode } from '@landflow/engine';
import type { AgentTeamConfig, TeamMember } from '@/lib/shared/agent-teams';
import type { TeamActivity } from '@/lib/shared/team-progress';
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
const { runWorkflow, resumeExecution } = await import('@/lib/server/runner');
const { agentStore } = await import('@/lib/server/agents/store');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
const { read } = await import('@/lib/server/journal/store');
const { resetJournals } = await import('@/lib/server/journal/writer');
const traceRoute = await import('@/app/api/agent-trace/[id]/route');

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
const qa = agent('QA agent', 'qa-model');

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
      expect.objectContaining({ title: 'Tech Lead', asked: 1, tokens: expect.any(Number) }),
      expect.objectContaining({ title: 'Planner', asked: 2, tokens: expect.any(Number) }),
      expect.objectContaining({ title: 'Developer', asked: 1, tokens: expect.any(Number) }),
      expect.objectContaining({ title: 'Tester', asked: 1, tokens: expect.any(Number) }),
    ]);
    // Each member's tokens in and out, its model and cost where known (a local model is free), and its time.
    const [leadReport, plannerReport] = done!.members as Array<Record<string, unknown>>;
    expect(leadReport).toMatchObject({ inputTokens: 48, outputTokens: 32, costUsd: 0, model: 'lead-model', ms: expect.any(Number) });
    // A remote member reports its usage (kagent's usage extension) but no model, so it isn't priced.
    expect(plannerReport).toMatchObject({ inputTokens: 240, outputTokens: 60 });
    expect(plannerReport).not.toHaveProperty('costUsd');
    // What the run did, for the canvases: every member's turns in order (the Tester asked by the Developer too), and the moments.
    const activity = done!.activity as { turns: Array<{ member: string; end?: number }>; moments: Array<{ text: string }> };
    expect(activity.turns.map((t) => t.member)).toEqual(['Tech Lead', 'Planner', 'Tech Lead', 'Planner', 'Tech Lead', 'Developer', 'Tester', 'Developer', 'Tech Lead']);
    expect(activity.turns.every((t) => typeof t.end === 'number')).toBe(true);
    expect(activity.moments.map((m) => m.text)).toEqual(expect.arrayContaining(['Asked the Planner', 'Planner reported back', 'Asked the Developer', 'Developer asked the Tester', 'Developer reported back']));
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
    // What each member works with, on the chart: the lead's model, a remote member's host (no Landflow agent behind it).
    const members = (snapshot && snapshot.type === 'span.updated' ? (snapshot.attrs?.team as { members: Array<{ title: string; connections?: Array<{ kind: string; name: string }> }> }).members : []) ?? [];
    expect(members.find((m) => m.title === 'Tech Lead')?.connections).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'model', name: 'lead-model' })]));
    expect(members.find((m) => m.title === 'Planner')?.connections).toEqual([expect.objectContaining({ kind: 'runtime', name: 'A2A agent' })]);
    // The team's usage names the lead's model and counts every model call: the lead's four, the developer's two, the remote members' reported ones.
    const ended = events.find((e) => e.type === 'span.ended' && e.usage && events.some((x) => x.type === 'span.updated' && x.attrs?.team && x.spanId === e.spanId));
    expect(ended && ended.type === 'span.ended' && ended.usage).toMatchObject({ model: 'lead-model', requests: expect.any(Number) });
    expect((leadReport as { requests?: number }).requests).toBe(4);
  });

  it('runs a member and the lead on the team’s model for them, leaving their agents unchanged', async () => {
    const baseUrl = fake.url.replace(/\/v1$/, '');
    const t = team([{ id: 'm_dev', title: 'Developer', kind: 'agent', agentId: developer.id, reportsTo: 'm_lead', model: { provider: 'ollama', model: 'team-dev-model', baseUrl } } as TeamMember]);
    // The lead too ("Lead on Claude", here a local model the fake server answers).
    const draft = agentTeamStore.get(t.id)!.draft;
    agentTeamStore.saveDraft(t.id, { ...draft, members: draft.members.map((m) => (m.id === 'm_lead' ? { ...m, model: { provider: 'ollama', model: 'team-lead-model', baseUrl } } : m)) });
    agentTeamStore.publish(t.id);
    scripts.set('team-lead-model', (turn, body) => (turn === 1 ? call('ask_developer', { message: 'Build it', reason: 'Work' }) : { text: `Lead on the team model: ${lastTool(body)}` }));
    scripts.set('team-dev-model', () => ({ text: 'built on the team model' }));
    scripts.set('lead-model', () => ({ text: 'wrong model: the agent’s own' }));
    scripts.set('dev-model', () => ({ text: 'wrong model: the agent’s own' }));
    turns.clear();
    const { done } = await run(t.id);
    expect(done!.reply).toBe('Lead on the team model: built on the team model');
    expect(done!.members).toContainEqual(expect.objectContaining({ title: 'Developer', model: 'team-dev-model' }));
    // The team keeps a model only on a Landflow agent member, with a known provider and a name.
    const { cleanConfig } = await import('@/lib/server/agent-teams/store');
    const cleaned = cleanConfig({
      name: 'x',
      members: [
        { id: 'a', title: 'A', kind: 'agent', agentId: 'ag', model: { provider: 'anthropic', model: 'claude-opus-5-5', credential: { id: 'cred_1', name: 'Anthropic' } } },
        { id: 'b', title: 'B', kind: 'agent', agentId: 'ag', reportsTo: 'a', model: { provider: 'nope', model: 'x' } as never },
        { id: 'c', title: 'C', kind: 'a2a', reportsTo: 'a', parameters: {}, model: { provider: 'anthropic', model: 'claude-opus-5-5' } } as never,
      ],
    });
    expect(cleaned.members.map((m) => (m as { model?: unknown }).model)).toEqual([{ provider: 'anthropic', model: 'claude-opus-5-5', credential: { id: 'cred_1', name: 'Anthropic' } }, undefined, undefined]);
    // The agents keep their own models.
    expect(agentStore.get(developer.id)?.published?.config.model?.model).toBe('dev-model');
    expect(agentStore.get(lead.id)?.published?.config.model?.model).toBe('lead-model');
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

  it('waits for a person to answer a member’s question, then the team goes on', async () => {
    const t = team([remote('m_plan', 'Planner', { questionsTo: 'person' })]);
    scripts.set('lead-model', (turn, body) => (turn === 1 ? call('ask_planner', { message: 'ask', reason: 'Need the plan' }) : { text: `Plan: ${lastTool(body)}` }));
    turns.clear();
    a2a.calls.length = 0;
    const { record } = await run(t.id);
    // The run waits on a form with the question, the team's state kept with the node.
    expect(record.status).toBe('waiting');
    expect(record.wait?.data).toMatchObject({ form: { title: 'Planner asks', description: 'Planner asks:\n- Which colour?' }, teamQuestion: { member: 'Planner' } });
    const resumed = await resumeExecution(record.executionId, { kind: 'form', outputs: [[{ json: { answer: 'blue' } }]] });
    resetJournals();
    expect(resumed.error?.message ?? resumed.status).toBe('success');
    const done = resumed.runData.Team?.at(-1)?.outputs?.[0]?.[0]?.json as Record<string, unknown>;
    // The answer went to the Planner's paused task, and the lead answered from what came back.
    expect(done.reply).toBe('Plan: You said: blue');
    expect(a2a.calls.filter((c) => c.method !== 'GetTask').at(-1)?.params.message?.taskId).toBeTruthy();
    expect(done.members).toContainEqual(expect.objectContaining({ title: 'Planner', asked: 1 }));
    const activity = done.activity as TeamActivity;
    // Before the wait and after: the lead picks the work up again, the Planner takes the answer, the lead finishes.
    expect(activity.turns.map((x) => x.member)).toEqual(['Tech Lead', 'Planner', 'Tech Lead', 'Planner', 'Tech Lead']);
    // The question stays a moment of the run (the Story's headlines), with the question in full.
    expect(activity.moments).toContainEqual(expect.objectContaining({ member: 'Planner', tone: 'warn', text: 'Planner asks a person', question: 'Planner asks:\n- Which colour?' }));
    // Each member's tokens, across the wait.
    expect(activity.usage?.map((u) => u.member)).toEqual(['Tech Lead', 'Planner']);
    expect(activity.usage?.every((u) => u.tokens > 0)).toBe(true);
  });

  it('takes the answer down to a member’s own report that asked', async () => {
    const t = team([
      { id: 'm_dev', title: 'Developer', kind: 'agent', agentId: developer.id, reportsTo: 'm_lead' } as TeamMember,
      remote('m_test', 'Tester', { reportsTo: 'm_dev', questionsTo: 'person' }),
    ]);
    scripts.set('lead-model', (turn, body) => (turn === 1 ? call('ask_developer', { message: 'Build it', reason: 'Needs code' }) : { text: `Lead: ${lastTool(body)}` }));
    scripts.set('dev-model', (turn, body) => (turn === 1 ? call('ask_tester', { message: 'ask', reason: 'Check it' }) : { text: `Developer: ${lastTool(body)}` }));
    turns.clear();
    const { record } = await run(t.id);
    expect(record.status).toBe('waiting');
    expect(record.wait?.data).toMatchObject({ form: { title: 'Tester asks' } });
    const resumed = await resumeExecution(record.executionId, { kind: 'form', outputs: [[{ json: { answer: 'green' } }]] });
    resetJournals();
    expect(resumed.error?.message ?? resumed.status).toBe('success');
    const done = resumed.runData.Team?.at(-1)?.outputs?.[0]?.[0]?.json as Record<string, unknown>;
    expect(done.reply).toBe('Lead: Developer: You said: green');
  });

  it('pauses at a tool that needs approval and goes on with the person’s decision, recording it as a check', async () => {
    const { decideApproval } = await import('@/lib/server/approvals');
    const comment = agentStore.create({
      name: 'Commenter',
      instructions: 'You comment.',
      model: { provider: 'ollama', model: 'comment-model', baseUrl: fake.url.replace(/\/v1$/, '') },
      tools: [{ id: 't1', type: 'node', name: 'Comment on pull request', description: 'Comment', nodeType: 'core.noOp', parameters: {}, requireApproval: true }],
    });
    agentStore.publish(comment.id);
    const t = team([{ id: 'm_dev', title: 'Developer', kind: 'agent', agentId: comment.id, reportsTo: 'm_lead' } as TeamMember]);
    const tool = toToolName('Comment on pull request');
    scripts.set('lead-model', (turn, body) => (turn === 1 ? call('ask_developer', { message: 'Comment on #5', reason: 'Tell them' }) : { text: `Lead: ${lastTool(body).slice(0, 60)}` }));
    scripts.set('comment-model', (turn, body) => (turn === 1 ? call(tool, { text: 'Review passed', pull_number: 5, reason: 'Tell them' }, 'c_comment') : { text: `Developer: ${lastTool(body).slice(0, 40)}` }));
    turns.clear();
    const { record } = await run(t.id);
    // The wait looks like the AI Agent node's, so Needs you, the execution view, Slack and email decide it the same way.
    expect(record.status).toBe('waiting');
    expect(record.wait?.data).toMatchObject({
      approval: { channel: 'chat', title: 'Developer wants to use Comment on pull request', calls: [{ id: expect.stringMatching(/^m_dev\//), tool: 'Comment on pull request', input: { text: 'Review passed' } }] },
      // What the tool acts on, so the node can say "Comment on pull request on #5".
      teamApproval: { team: 'Plugin team', member: 'Developer', tool: 'Comment on pull request', target: '#5' },
    });
    const callId = (record.wait?.data?.approval as { calls: Array<{ id: string }> }).calls[0].id;
    const outcome = await decideApproval(record.executionId, callId, true, { by: 'ana@example.com' });
    resetJournals();
    expect(outcome.status).toBe('resumed');
    const resumed = (outcome as { record: typeof record }).record;
    expect(resumed.error?.message ?? resumed.status).toBe('success');
    const done = resumed.runData.Team?.at(-1)?.outputs?.[0]?.[0]?.json as Record<string, unknown>;
    // The tool ran (the Developer saw its result), and the team went on.
    expect(String(done.reply)).toContain('Lead: Developer:');
    expect(String(done.reply)).not.toContain('rejected');
    const events = read(record.executionId);
    expect(events).toContainEqual(expect.objectContaining({ type: 'check', check: expect.objectContaining({ name: 'Approval', status: 'pass', subject: 'Developer', message: expect.stringContaining('ana@example.com approved Developer\'s use of Comment on pull request') }) }));
    // Needs you reads the tool, what it acts on and the member apart from the wait's name.
    expect(events).toContainEqual(expect.objectContaining({ type: 'span.started', kind: 'wait', name: 'Developer wants to use Comment on pull request on #5: Review passed', attrs: expect.objectContaining({ wait: 'approval', member: 'Developer', tool: 'Comment on pull request', target: '#5', summary: 'Review passed' }) }));
  });

  it('tells the member when the person rejects the tool call, and the team goes on without it', async () => {
    const { decideApproval } = await import('@/lib/server/approvals');
    const merger = agentStore.create({
      name: 'Merger',
      instructions: 'You merge.',
      model: { provider: 'ollama', model: 'merge-model', baseUrl: fake.url.replace(/\/v1$/, '') },
      tools: [{ id: 't1', type: 'node', name: 'Merge pull request', description: 'Merge', nodeType: 'core.noOp', parameters: {}, requireApproval: true }],
    });
    agentStore.publish(merger.id);
    const t = team([{ id: 'm_dev', title: 'Developer', kind: 'agent', agentId: merger.id, reportsTo: 'm_lead' } as TeamMember]);
    scripts.set('lead-model', (turn, body) => (turn === 1 ? call('ask_developer', { message: 'Merge #5', reason: 'Ship it' }) : { text: `Lead heard: ${lastTool(body)}` }));
    scripts.set('merge-model', (turn, body) => (turn === 1 ? call(toToolName('Merge pull request'), { reason: 'Ship it' }, 'c_merge') : { text: `Could not merge: ${lastTool(body)}` }));
    turns.clear();
    const { record } = await run(t.id);
    expect(record.status).toBe('waiting');
    const callId = (record.wait?.data?.approval as { calls: Array<{ id: string }> }).calls[0].id;
    const outcome = await decideApproval(record.executionId, callId, false, { by: 'ana@example.com' });
    resetJournals();
    const resumed = (outcome as { record: typeof record }).record;
    expect(resumed.status).toBe('success');
    const done = resumed.runData.Team?.at(-1)?.outputs?.[0]?.[0]?.json as Record<string, unknown>;
    expect(done.reply).toContain('Could not merge: A person rejected your call to Merge pull request; it did not run');
    expect(read(record.executionId)).toContainEqual(expect.objectContaining({ type: 'check', check: expect.objectContaining({ name: 'Approval', status: 'warn', message: expect.stringContaining('rejected Developer') }) }));
  });

  it('refuses a tool that needs approval outside a flow and ends in Needs a person with what was wanted', async () => {
    const { runTeam } = await import('@/lib/server/agent-teams/runtime');
    const poster = agentStore.create({
      name: 'Poster',
      instructions: 'You post.',
      model: { provider: 'ollama', model: 'post-model', baseUrl: fake.url.replace(/\/v1$/, '') },
      tools: [{ id: 't1', type: 'node', name: 'Post update', description: 'Post', nodeType: 'core.noOp', parameters: {}, requireApproval: true }],
    });
    agentStore.publish(poster.id);
    const t = team([{ id: 'm_dev', title: 'Developer', kind: 'agent', agentId: poster.id, reportsTo: 'm_lead' } as TeamMember]);
    scripts.set('lead-model', (turn, body) => (turn === 1 ? call('ask_developer', { message: 'Post it', reason: 'Tell' }) : { text: `Lead: ${lastTool(body).slice(0, 20)}` }));
    scripts.set('post-model', (turn) => (turn === 1 ? call(toToolName('Post update'), { reason: 'Tell' }, 'c_post') : { text: 'Could not post' }));
    turns.clear();
    const result = await runTeam({ team: { id: t.id, name: 'Plugin team' }, config: agentTeamStore.get(t.id)!.published!, message: 'Post', userId: 'test' });
    expect(result.waiting).toBeUndefined();
    expect(result.needsPerson).toContain("Developer wanted to use Post update, which needs a person's approval");
  });

  it('lets a member consult a peer, whose answer comes back to the member that asked', async () => {
    const t = team([
      { id: 'm_dev', title: 'Developer', kind: 'agent', agentId: developer.id, reportsTo: 'm_lead', consults: ['m_qa'] } as TeamMember,
      { id: 'm_qa', title: 'Reviewer', kind: 'agent', agentId: qa.id, reportsTo: 'm_lead', budgetTokens: 100_000 } as TeamMember,
    ]);
    const seen: string[][] = [];
    scripts.set('lead-model', (turn, body) => (turn === 1 ? call('ask_developer', { message: 'Add the tests', reason: 'Needs code' }) : { text: `Lead: ${lastTool(body)}` }));
    scripts.set('dev-model', (turn, body) => {
      seen.push((body.tools ?? []).map((tool) => tool.function.name));
      return turn === 1 ? call('consult_reviewer', { message: 'How do tests fake the API?', reason: 'how tests fake the API' }) : { text: `Developer: ${lastTool(body)}` };
    });
    scripts.set('qa-model', (_turn, body) => ({ text: `Reviewer says ${lastUser(body).includes('Developer') ? 'to the Developer' : 'to someone'}: use the fake server` }));
    turns.clear();
    const { done, events } = await run(t.id);
    // The Developer has the consult and the hand-off tool for its peer, the Reviewer (who has none: nobody may be consulted by it).
    expect(seen[0]).toEqual(expect.arrayContaining(['consult_reviewer', 'hand_off_to_reviewer']));
    // The Reviewer answered the Developer (its ask carried the Developer's task, not the lead's), and the lead got the Developer's answer.
    expect(String(done?.reply)).toContain('Developer: Reviewer says to the Developer: use the fake server');
    // The peer's tokens count against its own budget, and the ask is counted.
    expect(done?.members).toContainEqual(expect.objectContaining({ title: 'Reviewer', asked: 1, tokens: expect.any(Number) }));
    // The consult sits under the Developer's request in the journal.
    const spans = events.filter((e) => e.type === 'span.started');
    const consult = spans.find((e) => e.type === 'span.started' && e.attrs?.tool === 'consult_reviewer');
    const asked = spans.find((e) => e.type === 'span.started' && e.attrs?.tool === 'ask_developer');
    expect(consult).toMatchObject({ kind: 'delegate', name: 'Reviewer', attrs: { reason: 'how tests fake the API' } });
    expect(consult?.type === 'span.started' && consult.parentSpanId).toBe(asked?.type === 'span.started' && asked.spanId);
  });

  it('hands a task to a peer: the peer’s answer goes to the manager as the result of the original ask', async () => {
    const t = team([
      { id: 'm_plan', title: 'Planner', kind: 'agent', agentId: developer.id, reportsTo: 'm_lead', consults: ['m_qa'] } as TeamMember,
      { id: 'm_qa', title: 'Builder', kind: 'agent', agentId: qa.id, reportsTo: 'm_lead' } as TeamMember,
    ]);
    let planner = 0;
    scripts.set('lead-model', (turn, body) => (turn === 1 ? call('ask_planner', { message: 'Plan and build the slugify plugin', reason: 'Start' }) : { text: `Lead: ${lastTool(body)}` }));
    scripts.set('dev-model', (turn, body) => {
      planner++;
      return turn === 1 ? call('hand_off_to_builder', { message: 'Notes: use a regex', reason: 'You build it' }) : { text: `Planner extra turn ${lastTool(body)}` };
    });
    scripts.set('qa-model', (_turn, body) => ({ text: `Built it from: ${lastUser(body).includes('Notes: use a regex') ? 'the notes' : 'nothing'}` }));
    turns.clear();
    const { done, events } = await run(t.id);
    // The Planner stepped out after the hand-off (one model call), and the Builder's answer is what the lead heard.
    expect(planner).toBe(1);
    expect(String(done?.reply)).toContain('Built it from: the notes');
    expect(String(done?.reply)).toContain('Planner handed this task to Builder');
    expect(events).toContainEqual(expect.objectContaining({ type: 'check', check: expect.objectContaining({ name: 'Hand-off', message: 'Planner handed the task to Builder' }) }));
  });

  it('offers no consult back to a member in the chain, so peers can’t loop', async () => {
    const t = team([
      { id: 'm_dev', title: 'Developer', kind: 'agent', agentId: developer.id, reportsTo: 'm_lead', consults: ['m_qa'] } as TeamMember,
      { id: 'm_qa', title: 'Reviewer', kind: 'agent', agentId: qa.id, reportsTo: 'm_lead', consults: ['m_dev'] } as TeamMember,
    ]);
    const qaTools: string[][] = [];
    scripts.set('lead-model', (turn, body) => (turn === 1 ? call('ask_developer', { message: 'Go', reason: 'Start' }) : { text: `Lead: ${lastTool(body)}` }));
    scripts.set('dev-model', (turn, body) => (turn === 1 ? call('consult_reviewer', { message: 'Hi', reason: 'Ask' }) : { text: `Developer: ${lastTool(body)}` }));
    scripts.set('qa-model', (_turn, body) => {
      qaTools.push((body.tools ?? []).map((tool) => tool.function.name));
      return { text: 'Reviewer answer' };
    });
    turns.clear();
    const { done } = await run(t.id);
    expect(String(done?.reply)).toContain('Reviewer answer');
    // The Developer is waiting on the Reviewer, so the Reviewer isn't offered the Developer.
    expect(qaTools[0].some((name) => name.includes('developer'))).toBe(false);
  });

  it('ends in Needs a person when the run can’t wait for one', async () => {
    const { runTeam } = await import('@/lib/server/agent-teams/runtime');
    const t = team([remote('m_plan', 'Planner', { questionsTo: 'person' })]);
    scripts.set('lead-model', (turn, body) => (turn === 1 ? call('ask_planner', { message: 'ask', reason: 'Need the plan' }) : { text: `Stopped: ${lastTool(body).slice(0, 40)}` }));
    turns.clear();
    const result = await runTeam({ team: { id: t.id, name: 'Plugin team' }, config: agentTeamStore.get(t.id)!.published!, message: 'Build it', userId: 'test' });
    expect(result.waiting).toBeUndefined();
    expect(result.needsPerson).toContain('Planner has a question for a person: fake-agent asks');
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

  it('has the nearest manager of both see to a review across the chart', async () => {
    // The Reviewer reports to QA, the Developer to the lead: the lead sees to the review, through QA.
    const t = team([
      remote('m_dev', 'Developer'),
      { id: 'm_qa', title: 'QA', kind: 'agent', agentId: qa.id, reportsTo: 'm_lead' } as TeamMember,
      remote('m_rev', 'Reviewer', { reportsTo: 'm_qa', reviews: ['m_dev'] }),
    ]);
    scripts.set('lead-model', (turn, body) => {
      if (turn === 1) return call('ask_developer', { message: 'slug one', reason: 'Build' });
      if (turn === 2) return { text: 'Built.' };
      if (turn === 3) {
        expect(lastUser(body)).toContain("may not report done yet: Developer's work has not been reviewed by Reviewer. Ask Reviewer through QA (ask_qa) to review it first");
        return call('ask_qa', { message: 'Have the Reviewer review the slug', reason: 'Required review' });
      }
      return { text: 'Built and reviewed.' };
    });
    scripts.set('qa-model', (turn) => (turn === 1 ? call('ask_reviewer', { message: 'review the slug', reason: 'Asked by the lead' }) : { text: 'The Reviewer looked at it.' }));
    turns.clear();
    const { done, needs, events } = await run(t.id);
    expect(needs).toBeUndefined();
    expect(done!.reply).toBe('Built and reviewed.');
    expect(events.filter((e) => e.type === 'check' && e.check.name === 'Review').map((e) => e.type === 'check' && [e.check.status, e.check.message])).toEqual([['pass', "Reviewer was asked to review Developer's work"]]);
  });

  it('takes a reviewer’s verdict as the sign-off: changes go back to the member, then to the reviewer again', async () => {
    const t = team([remote('m_dev', 'Developer'), remote('m_rev', 'Reviewer', { reviews: ['m_dev'] })]);
    scripts.set('lead-model', (turn, body) => {
      if (turn === 1) return call('ask_developer', { message: 'slug one', reason: 'Build' }, 'd1');
      if (turn === 2) return call('ask_reviewer', { message: 'VERDICT: CHANGES the slug needs a test', reason: 'Review' }, 'r1');
      if (turn === 3) return { text: 'Done, the review had notes.' };
      if (turn === 4) {
        expect(lastUser(body)).toContain("may not report done yet: Reviewer asked for changes to Developer's work. Send them to Developer (ask_developer), then ask Reviewer (ask_reviewer) to review it again");
        return call('ask_developer', { message: 'slug one with a test', reason: 'The review asked for a test' }, 'd2');
      }
      if (turn === 5) return call('ask_reviewer', { message: 'VERDICT: APPROVE', reason: 'Review again' }, 'r2');
      return { text: 'Done and approved.' };
    });
    turns.clear();
    const { done, needs, events } = await run(t.id);
    expect(needs).toBeUndefined();
    expect(done!.reply).toBe('Done and approved.');
    expect(events.filter((e) => e.type === 'check' && e.check.name === 'Review').map((e) => e.type === 'check' && [e.check.status, e.check.message])).toEqual([
      ['warn', "Reviewer asked for changes to Developer's work"],
      ['pass', "Reviewer approved Developer's work"],
    ]);
  });

  it('sends the lead back once when its answer names files no report mentioned', async () => {
    const t = team([remote('m_rev', 'Reviewer')]);
    scripts.set('lead-model', (turn, body) => {
      if (turn === 1) {
        // Told to answer from what its reports give it.
        expect(lastUser(body)).toContain('name only the files, tests, commands and results your reports gave you');
        return call('ask_reviewer', { message: 'Review src/nodes/get-alerts.ts', reason: 'Review' });
      }
      if (turn === 2) return { text: 'Reviewed `src/getAlerts.ts` and src/nodes/get-alerts.ts on Node.js: fine.' };
      if (turn === 3) {
        expect(lastUser(body)).toContain('Your answer names getAlerts.ts, which none of your reports mentioned. The files your reports named: get-alerts.ts. Answer the request again for the person who asked');
        expect(lastUser(body)).toContain("where your instructions ask for something no report gave say it wasn't reported");
        return { text: 'Reviewed get-alerts.ts: fine.' };
      }
      return { text: 'Reviewed getAlerts.ts again.' };
    });
    turns.clear();
    const { done, events } = await run(t.id);
    expect(done!.reply).toBe('Reviewed get-alerts.ts: fine.');
    // Answered again without it: the check on the node passes (a span keeps one Grounded check per member, the latest).
    expect(events.filter((e) => e.type === 'check' && e.check.name === 'Grounded')).toEqual([
      expect.objectContaining({ check: expect.objectContaining({ status: 'warn', subject: 'Tech Lead', message: "Tech Lead's answer named getAlerts.ts, which no report mentioned" }) }),
      expect.objectContaining({ check: expect.objectContaining({ status: 'pass', subject: 'Tech Lead', message: 'Tech Lead answered again without getAlerts.ts, which no report mentioned' }) }),
    ]);
  });

  it('says so when the answer sent back still names them', async () => {
    const t = team([remote('m_rev', 'Reviewer')]);
    scripts.set('lead-model', (turn) => {
      if (turn === 1) return call('ask_reviewer', { message: 'Review src/nodes/get-alerts.ts', reason: 'Review' });
      if (turn === 2) return { text: 'Reviewed src/getAlerts.ts: fine.' };
      return { text: 'The review named getAlerts.ts, but no report listed it.' };
    });
    turns.clear();
    const { done, events } = await run(t.id);
    // What it still names goes on with a note, so a comment posted from the answer doesn't pass it off as reported.
    expect(done!.reply).toBe("The review named getAlerts.ts, but no report listed it.\n\n(Not in any team member's report: getAlerts.ts. Check before relying on them.)");
    expect(events.filter((e) => e.type === 'check' && e.check.name === 'Grounded').map((e) => e.type === 'check' && e.check.message)).toEqual([
      "Tech Lead's answer named getAlerts.ts, which no report mentioned",
      "Tech Lead's answer still names getAlerts.ts, which no report mentioned",
    ]);
  });

  it('sends the lead back for commits and test counts no report gave, and tells it the tools it has', async () => {
    const t = team([remote('m_rev', 'Reviewer')]);
    scripts.set('lead-model', (turn, body) => {
      if (turn === 1) {
        // Instructions written for another flow may name a tool the team doesn't give it here.
        const system = body.messages.find((m) => m.role === 'system')?.content ?? '';
        expect(system).toContain('## Your tools in this run\n- ask_reviewer (Reviewer)');
        expect(system).toContain("If your instructions name a tool that isn't listed here, you don't have it in this run");
        return call('ask_reviewer', { message: 'Review the plugin', reason: 'Review' });
      }
      if (turn === 2) return { text: 'Approved at commit 3f9a2c1, 14/14 tests passed, see PR #7.' };
      if (turn === 3) {
        expect(lastUser(body)).toContain('Your answer names commit 3f9a2c1, 14/14 tests, PR #7, which none of your reports mentioned. Answer the request again');
        return { text: 'Approved; the review gave no commit or test count.' };
      }
      return { text: 'unused' };
    });
    turns.clear();
    const { done, events } = await run(t.id);
    expect(done!.reply).toBe('Approved; the review gave no commit or test count.');
    expect(events.filter((e) => e.type === 'check' && e.check.name === 'Grounded').map((e) => e.type === 'check' && e.check.message)).toEqual([
      "Tech Lead's answer named commit 3f9a2c1, 14/14 tests, PR #7, which no report mentioned",
      'Tech Lead answered again without commit 3f9a2c1, 14/14 tests, PR #7, which no report mentioned',
    ]);
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
    expect(done!.members).toContainEqual(expect.objectContaining({ title: 'Developer', asked: 1, tokens: 20, overBudget: true }));
    // The node's usage is the whole team's: the lead's three calls and the Developer's one.
    const usage = done!.usage as { inputTokens: number; outputTokens: number };
    expect(usage.inputTokens + usage.outputTokens).toBe(80);
    expect(events.filter((e) => e.type === 'check' && e.check.name === 'Budget').map((e) => e.type === 'check' && e.check.status)).toEqual(['fail']);
    // The node's activity keeps the bar and the moment it was used up.
    const activity = done!.activity as TeamActivity;
    expect(activity.usage).toContainEqual({ member: 'Developer', tokens: 20, budget: 20 });
    expect(activity.moments).toContainEqual(expect.objectContaining({ member: 'Developer', tone: 'bad', text: 'Developer used up its budget' }));
    // The team page reads the same from its last run.
    const { GET } = await import('@/app/api/agent-teams/[id]/last-run/route');
    const last = (await (await GET(new Request(`http://localhost/api/agent-teams/${t.id}/last-run`), { params: Promise.resolve({ id: t.id }) })).json()) as { run?: { executionId: string; nodeName: string; members: unknown[] } };
    expect(last.run).toMatchObject({ nodeName: 'Team' });
    expect(last.run?.members).toContainEqual(expect.objectContaining({ title: 'Developer', tokens: 20, budgetTokens: 20, overBudget: true }));
  });

  it('estimates the usage of a remote member that reports none, and stops it at its budget', async () => {
    const t = team([remote('m_plan', 'Planner', { budgetTokens: 10 })]);
    scripts.set('lead-model', (turn, body) => (turn <= 2 ? call('ask_planner', { message: `slug job number ${turn} with enough words to cost tokens`, reason: 'Plan' }, `p${turn}`) : { text: `Result: ${lastTool(body)}` }));
    turns.clear();
    a2a.usage = false;
    try {
      const { done, events } = await run(t.id);
      expect(done!.reply).toContain('Planner is over its budget of 10 tokens');
      expect(done!.members).toContainEqual(expect.objectContaining({ title: 'Planner', asked: 1, tokens: expect.any(Number), estimated: true, overBudget: true }));
      expect((done!.members as Array<Record<string, unknown>>).find((m) => m.title === 'Planner')).not.toHaveProperty('inputTokens');
      const budget = events.find((e) => e.type === 'check' && e.check.name === 'Budget');
      expect(budget && budget.type === 'check' && budget.check.message).toMatch(/^Planner used about \d+ of its 10 tokens and was stopped \(estimated: it reports no usage\)$/);
      // An estimate counts against the budget, not in what the team used: that is the lead's alone here.
      const usage = done!.usage as { inputTokens: number; outputTokens: number };
      expect(usage.inputTokens + usage.outputTokens).toBe(60);
    } finally {
      a2a.usage = true;
    }
  });

  it('takes a Claude Code member’s real usage, cost and guardrail stops from its landflow-harness mod', async () => {
    // A Landflow agent deployed to kagent with the mod: calls to its A2A URL carry a trace marker.
    const onKagent = agentStore.create({ name: 'Reviewer on kagent', instructions: 'Review.', model: { provider: 'anthropic', model: 'claude-sonnet-5-5' } });
    const agentUrl = `${a2a.url}/agents/kagent/rt-reviewer`;
    agentStore.setKagent(onKagent.id, { credential: { id: 'cred', name: 'kind' }, name: 'rt-reviewer', trace: { url: 'http://landflow.test/api/agent-trace', a2aUrl: agentUrl } } as never);
    const t = team([remote('m_rev', 'Reviewer', { parameters: { agentUrl } })]);
    scripts.set('lead-model', (turn, body) => (turn === 1 ? call('ask_reviewer', { message: 'slug review it', reason: 'Review' }) : { text: `Result: ${lastTool(body)}` }));
    turns.clear();
    const seen: string[] = [];
    // What the mod does inside Claude Code: take the marker off the prompt and post what happened to the trace.
    a2a.mod = async (text) => {
      seen.push(text);
      const found = /^<!-- landflow-trace (\S+) -->\n/.exec(text);
      if (!found) return text;
      const events = [
        { type: 'start', mod: '0.2.0', guard: 'enforce' },
        { type: 'step', ms: 900, model: 'claude-sonnet-5-5', input: 1200, output: 80, cacheRead: 9000, cacheWrite: 300, tools: ['Bash'] },
        { type: 'tool', ms: 40, tool: 'Bash', ok: true, arg: 'pnpm test' },
        { type: 'guard', rule: 'git-push', tool: 'Bash', arg: 'git push origin main', reason: 'push to your own branch', action: 'deny' },
        { type: 'redact', kinds: ['GitHub token'] },
        { type: 'turn', ms: 1500, reason: 'answer' },
      ];
      const response = await traceRoute.POST(new Request(found[1], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events }) }), { params: Promise.resolve({ id: found[1].split('/').pop()! }) });
      expect(response.status).toBe(204);
      return text.slice(found[0].length);
    };
    a2a.usage = false;
    try {
      const { done, events } = await run(t.id);
      expect(seen[0]).toMatch(/^<!-- landflow-trace http:\/\/landflow\.test\/api\/agent-trace\/[A-Za-z0-9_-]{24} -->\nTeam goal:/);
      expect(done!.reply).toContain('The slug is review-it');
      // Real usage, priced at Sonnet 5.5: 1,200 fresh in at $2, 9,000 cache reads at $0.10, 300 cache writes at $2.50, 80 out at $10 (per 1M).
      const reviewer = (done!.members as Array<Record<string, unknown>>).find((m) => m.title === 'Reviewer');
      expect(reviewer).toMatchObject({ tokens: 10_580, inputTokens: 10_500, outputTokens: 80, cacheReadTokens: 9_000, costUsd: 0.00485, model: 'claude-sonnet-5-5', requests: 1 });
      expect(reviewer).not.toHaveProperty('estimated');
      expect((done!.usage as { costUsd?: number }).costUsd).toBeCloseTo(0.00485, 9);
      // The request's span carries the usage and cost; the guardrail stop and the masked secret are checks on it.
      const ended = events.find((e) => e.type === 'span.ended' && e.usage?.requests !== undefined);
      expect(ended && ended.type === 'span.ended' && ended.usage).toMatchObject({ inputTokens: 10_500, costUsd: 0.00485, requests: 1, model: 'claude-sonnet-5-5' });
      // Its one model request is a model span under the request, with the same tokens and cost, and no request count of its own.
      const modelStart = events.find((e) => e.type === 'span.started' && e.kind === 'model');
      expect(modelStart).toMatchObject({ name: 'claude-sonnet-5-5', parentSpanId: ended!.spanId });
      const modelEnd = events.find((e) => e.type === 'span.ended' && modelStart && e.spanId === modelStart.spanId);
      expect(modelEnd && modelEnd.type === 'span.ended' && modelEnd.usage).toMatchObject({ inputTokens: 10_500, outputTokens: 80, cacheReadTokens: 9_000, costUsd: 0.00485, model: 'claude-sonnet-5-5' });
      expect(modelEnd && modelEnd.type === 'span.ended' && modelEnd.usage).not.toHaveProperty('requests');
      const checks = events.flatMap((e) => (e.type === 'check' ? [e.check] : []));
      expect(checks).toContainEqual(expect.objectContaining({ name: 'Guardrail', status: 'warn', subject: 'Reviewer', message: 'Stopped Bash: git push origin main (git-push: push to your own branch)' }));
      expect(checks).toContainEqual(expect.objectContaining({ name: 'Secrets masked', message: 'Masked secrets in 1 tool result (GitHub token) before the model read them' }));
    } finally {
      a2a.usage = true;
      a2a.mod = undefined;
      agentStore.setKagent(onKagent.id, undefined as never);
    }
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

describe('what an answer names that no report gave', () => {
  it('reads commits, test counts and pull requests, and finds them in the source as reports write them', async () => {
    const { ungrounded } = await import('@/lib/server/agent-teams/runtime');
    const source = 'Pushed a1b2c3d4e5f6 to the branch. Tests  14 passed (14). Opened https://github.com/o/r/pull/12. Colour #10b981.';
    expect(ungrounded('Commit a1b2c3d, 14/14 tests, Tests passed: 14/14, PR #12 and pull request 12', source)).toEqual([]);
    expect(ungrounded('Commit 9e8d7c6, 3 tests passed, 12 failed, PR #13, deadbeef and 2026/10 on index.ts', source)).toEqual(['index.ts', 'commit 9e8d7c6', '3 tests passed', '12 failed', 'PR #13']);
  });
});

describe('file names in an answer', () => {
  it('reads names alone and at the end of a path, not products', async () => {
    const { fileNamesIn } = await import('@/lib/server/agent-teams/runtime');
    expect(fileNamesIn('Files: `plugins/grafana/src/index.ts`, PLAN.md and /tmp/w/get-alerts.test.ts on Node.js; v1.2 of package.json')).toEqual(['index.ts', 'PLAN.md', 'get-alerts.test.ts', 'package.json']);
  });
});
