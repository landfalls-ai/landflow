/**
 * Pausing a team member and taking over (agent-teams/pause.ts): a Landflow agent member stops at its next step boundary and
 * goes on with the person's instruction; a remote member is stopped and redirected in the same conversation; the pause and the
 * instruction are in the journal. Same harness as run-team.test.ts (a fake model per agent, a fake A2A agent).
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

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-pause-team-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
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
const { allActiveMembers, requestPause, continueMember } = await import('@/lib/server/agent-teams/pause');
const pauseRoute = await import('@/app/api/executions/[id]/agents/[member]/pause/route');
const continueRoute = await import('@/app/api/executions/[id]/agents/[member]/continue/route');
const listRoute = await import('@/app/api/executions/[id]/agents/route');

registry.registerBuiltin(corePlugin);

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
  const created = agentStore.create({ name, instructions: `You are ${name}.`, model: { provider: 'ollama', model, baseUrl: fake.url.replace(/\/v1$/, '') } });
  agentStore.publish(created.id);
  return created;
}
const lead = agent('Tech Lead', 'pl-lead');
const developer = agent('Developer agent', 'pl-dev');

const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });

function team(members: TeamMember[]) {
  const config: AgentTeamConfig = { name: 'Pause team', goal: 'Ship it', members: [{ id: 'm_lead', title: 'Tech Lead', kind: 'agent', agentId: lead.id }, ...members] };
  const created = agentTeamStore.create(config);
  agentTeamStore.publish(created.id);
  return created;
}

let n = 0;
function start(teamId: string) {
  const wf: Workflow = {
    id: `wf_pause_${++n}`,
    name: 'pause',
    nodes: [node('Start', 'core.manualTrigger'), node('Team', 'core.runTeam', { teamId, message: 'Build it' })],
    connections: [{ id: 'a', type: 'main', source: 'Start', target: 'Team', sourceIndex: 0, targetIndex: 0 }],
  };
  store.saveWorkflow(wf);
  return runWorkflow({ workflow: wf, mode: 'manual', startNodeId: 'Start' });
}

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const member = (title: string) => allActiveMembers().find((m) => m.member === title);
const req = (method = 'POST', body?: unknown) => new Request('http://localhost/x', { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
const ctx = (id: string, who: string) => ({ params: Promise.resolve({ id, member: who }) });

describe('pausing a team member', () => {
  it('stops a Landflow agent member after its step, adds the person’s instruction and lets it go on', async () => {
    const t = team([
      { id: 'm_dev', title: 'Developer', kind: 'agent', agentId: developer.id, reportsTo: 'm_lead' } as TeamMember,
      { id: 'm_test', title: 'Tester', kind: 'a2a', reportsTo: 'm_dev', role: 'Tester role', parameters: { agentUrl: a2a.url } } as TeamMember,
    ]);
    let seen = '';
    scripts.set('pl-lead', (turn, body) => (turn === 1 ? call('ask_developer', { message: 'Build it', reason: 'Needs code' }) : { text: `Lead: ${lastTool(body)}` }));
    scripts.set('pl-dev', (turn, body) => {
      if (turn === 1) {
        // A person pauses the Developer while its first model call is on: it stops after the step that call asks for.
        const running = allActiveMembers().find((m) => m.member === 'Developer')!;
        void requestPause(running.executionId, 'Developer', { id: 'u1', name: 'Jonathan' });
        return call('ask_tester', { message: 'slug one', reason: 'Check it' });
      }
      seen = lastUser(body);
      return { text: `Developer did: ${seen.split('\n').at(-1)}` };
    });
    turns.clear();
    const running = start(t.id);
    await until(() => member('Developer')?.state === 'paused', 'the Developer to pause');
    const executionId = member('Developer')!.executionId;
    // Not paused again, and the lead keeps waiting on the Developer's request.
    expect(member('Tech Lead')?.state).toBe('working');
    expect((await (await listRoute.GET(req('GET'), { params: Promise.resolve({ id: executionId }) })).json()).members).toEqual(expect.arrayContaining([expect.objectContaining({ member: 'Developer', state: 'paused' })]));
    // Continuing a member that isn't paused, or one that isn't there, is refused.
    expect((await continueRoute.POST(req('POST', {}), ctx(executionId, 'Tech Lead'))).status).toBe(409);
    expect((await continueRoute.POST(req('POST', {}), ctx(executionId, 'Nobody'))).status).toBe(404);
    expect((await pauseRoute.POST(req(), ctx(executionId, 'Nobody'))).status).toBe(404);
    const res = await continueRoute.POST(req('POST', { message: 'use the other approach' }), ctx(executionId, 'Developer'));
    expect(res.status).toBe(200);
    const record = await running;
    resetJournals();
    expect(record.error?.message ?? record.status).toBe('success');
    expect(seen).toContain('use the other approach');
    expect((record.runData.Team.at(-1)!.outputs[0][0].json as { reply: string }).reply).toContain('Developer did: use the other approach');
    // Nothing is held after the run.
    expect(allActiveMembers().filter((m) => m.executionId === executionId)).toEqual([]);
    // The journal: a wait span under the Developer's request, the person's words, and the member going on.
    const events = read(executionId);
    const wait = events.find((e) => e.type === 'span.started' && e.kind === 'wait' && e.attrs?.wait === 'pause');
    expect(wait).toMatchObject({ name: 'Developer is paused', attrs: { member: 'Developer', mode: 'pause' } });
    const dev = events.find((e) => e.type === 'span.started' && e.kind === 'delegate' && e.name === 'Developer');
    expect(wait && wait.type === 'span.started' && wait.parentSpanId).toBe(dev?.spanId);
    expect(events).toContainEqual(expect.objectContaining({ type: 'message', spanId: wait!.spanId, text: 'use the other approach', from: expect.objectContaining({ type: 'human' }) }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'span.ended', spanId: wait!.spanId, status: 'success' }));
  });

  it('stops a remote member and sends the instruction to the same conversation', async () => {
    const t = team([{ id: 'm_plan', title: 'Planner', kind: 'a2a', reportsTo: 'm_lead', role: 'Planner role', parameters: { agentUrl: a2a.url } } as TeamMember]);
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    // The Planner's first request hangs in its mod (a task that is still being created); the second is answered.
    a2a.mod = async (text) => {
      if (text.includes('hold this')) {
        await hold;
        return 'slow';
      }
      return text.includes('A person stopped you') ? 'slug use tabs' : text;
    };
    scripts.set('pl-lead', (turn, body) => (turn === 1 ? call('ask_planner', { message: 'hold this', reason: 'Plan' }) : { text: `Lead: ${lastTool(body)}` }));
    turns.clear();
    a2a.calls.length = 0;
    const running = start(t.id);
    await until(() => member('Planner')?.kind === 'remote', 'the Planner to be asked');
    const executionId = member('Planner')!.executionId;
    expect((await pauseRoute.POST(req(), ctx(executionId, 'Planner'))).status).toBe(200);
    await until(() => member('Planner')?.state === 'paused', 'the Planner to stop');
    release();
    const res = await continueRoute.POST(req('POST', { message: 'use tabs' }), ctx(executionId, 'Planner'));
    expect(res.status).toBe(200);
    const record = await running;
    resetJournals();
    a2a.mod = undefined;
    expect(record.error?.message ?? record.status).toBe('success');
    expect((record.runData.Team.at(-1)!.outputs[0][0].json as { reply: string }).reply).toBe('Lead: The slug is use-tabs');
    const events = read(executionId);
    expect(events).toContainEqual(expect.objectContaining({ type: 'span.started', kind: 'wait', name: 'Planner is paused', attrs: expect.objectContaining({ mode: 'redirect' }) }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'message', text: 'use tabs' }));
  });

  it('lets a paused member go on by itself when no one takes over in time', async () => {
    const previous = process.env.LANDFLOW_TEAM_PAUSE_MINUTES;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      process.env.LANDFLOW_TEAM_PAUSE_MINUTES = '1';
      const { holdMember } = await import('@/lib/server/agent-teams/pause');
      const held = holdMember('ex_timeout', 'Dev', 'agent', { actor: { id: 'agent:a', name: 'Dev', type: 'agent' } });
      await requestPause('ex_timeout', 'Dev');
      expect(held.requested()).toBe(true);
      const waiting = held.wait({ summary: 'Paused' });
      expect(member('Dev')?.state).toBe('paused');
      await vi.advanceTimersByTimeAsync(61_000);
      await expect(waiting).resolves.toBeUndefined();
      expect(member('Dev')?.state).toBe('working');
      held.release();
      expect(member('Dev')).toBeUndefined();
      expect(() => continueMember('ex_timeout', 'Dev', 'x')).toThrow(/not working/);
    } finally {
      vi.useRealTimers();
      if (previous === undefined) delete process.env.LANDFLOW_TEAM_PAUSE_MINUTES;
      else process.env.LANDFLOW_TEAM_PAUSE_MINUTES = previous;
    }
  });
});
