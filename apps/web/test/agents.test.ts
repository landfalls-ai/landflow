import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, LanguageModel, ModelTurn, ToolSpec } from '@landflow/engine';
import type { Agent, AgentConfig, AgentStreamEvent } from '@/lib/shared/agents';

/** The model each test scripts: one function per model turn, called with what the runtime sent. */
type Step = (input: { system?: string; messages: AgentMessage[]; tools: ToolSpec[] }) => Partial<ModelTurn> | Promise<Partial<ModelTurn>>;
const script: Step[] = [];
const seen: Array<{ system?: string; messages: AgentMessage[]; tools: ToolSpec[] }> = [];

vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:11434',
  modelOptions: async () => [],
  agentModel: (config: { model?: string } | undefined): LanguageModel => {
    if (!config?.model) throw new Error('Choose a model for this agent first');
    return {
      provider: 'scripted',
      model: config.model,
      async generate(input) {
        // Copy: the runtime keeps appending to the same transcript.
        seen.push({ system: input.system, messages: structuredClone(input.messages), tools: input.tools });
        const step = script.shift();
        if (!step) throw new Error('The script ran out of turns');
        return { text: '', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 }, ...(await step(input)) };
      },
    };
  },
}));

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { configFor, decide, newSession, runAgent } = await import('@/lib/server/agents/runtime');
const { isDue, parseCron, scheduleCron, timeParts } = await import('@/lib/server/agents/cron');
const { allowed } = await import('@/lib/server/agents/triggers');
const { messageAgentNode, workflowTrigger } = await import('@/lib/server/nodes/agents');
const { run } = await import('./helpers');

const reply = (text: string): Step => () => ({ text });
const call = (name: string, input: Record<string, unknown> = {}, id = `call_${name}`): Step => () => ({ toolCalls: [{ id, name, input }] });

function makeAgent(config: Partial<AgentConfig> = {}): Agent {
  return agentStore.create({ name: 'Helper', instructions: 'Be brief.', model: { provider: 'ollama', model: 'scripted-1' }, ...config });
}

const testSession = (agent: Agent) => newSession(agent, { source: 'test', userId: 'you', version: 'draft' });

/** Tool results the model saw in its last turn. */
const lastToolResults = () => {
  const messages = seen.at(-1)!.messages;
  const last = messages.at(-1)!;
  return last.role === 'tool' ? last.results : [];
};

beforeAll(() => {
  registry.registerBuiltin(corePlugin);
});

beforeEach(() => {
  script.length = 0;
  seen.length = 0;
});

describe('agent runtime', () => {
  it('answers, saves the session and streams the timeline', async () => {
    const agent = makeAgent();
    script.push(reply('Hi there.'));
    const events: AgentStreamEvent[] = [];
    const result = await runAgent({ agent, session: testSession(agent), message: 'hello', onEvent: (e) => events.push(e) });

    expect(result).toMatchObject({ reason: 'completed', reply: 'Hi there.', usage: { inputTokens: 10, outputTokens: 5 } });
    expect(seen[0].system).toContain('Be brief.');
    const saved = agentStore.getSession(result.session.id)!;
    expect(saved).toMatchObject({ status: 'idle', title: 'hello', source: 'test' });
    expect(saved.timeline.map((e) => e.type)).toEqual(['user', 'assistant']);
    expect(events.map((e) => e.type)).toEqual(['run.started', 'entry', 'entry', 'run.finished']);
    expect(agentStore.listSessions(agent.id)[0]).toMatchObject({ id: saved.id, turns: 1 });
  });

  it('saves a running session as its timeline grows, with the execution link', async () => {
    const agent = makeAgent({ tools: [{ id: 't1', type: 'node', name: 'Echo', description: 'Echo the input', nodeType: 'core.noOp', parameters: {} }] });
    const session = newSession(agent, { source: 'workflow', userId: 'workflow:wf_1', version: 'draft' });
    session.execution = { workflowId: 'wf_1', executionId: 'ex_1', nodeId: 'n1', nodeName: 'Tech Lead' };
    let midRun: ReturnType<typeof agentStore.getSession>;
    script.push(call('Echo', { word: 'ping' }), async () => {
      // Past the save throttle: the tool call made so far is on disk although the run has not finished.
      await new Promise((resolve) => setTimeout(resolve, 1700));
      midRun = agentStore.getSession(session.id);
      return { text: 'Done.' };
    });
    await runAgent({ agent, session, message: 'echo ping' });

    expect(midRun!).toMatchObject({ status: 'running', execution: { executionId: 'ex_1', nodeId: 'n1', nodeName: 'Tech Lead' } });
    expect(midRun!.timeline.map((e) => e.type)).toEqual(['user', 'tool']);
    expect(midRun!.timeline[1]).toMatchObject({ status: 'success' });
    expect(agentStore.getSession(session.id)).toMatchObject({ status: 'idle', execution: { executionId: 'ex_1' } });
    expect(agentStore.listSessions(agent.id)[0].execution).toMatchObject({ nodeId: 'n1' });
  });

  it('keeps the transcript between messages (session memory)', async () => {
    const agent = makeAgent();
    script.push(reply('Noted.'), reply('You said blue.'));
    const first = await runAgent({ agent, session: testSession(agent), message: 'My color is blue' });
    await runAgent({ agent, session: agentStore.getSession(first.session.id)!, message: 'What did I say?' });
    expect(seen[1].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('runs a plugin node as a tool and feeds the result back', async () => {
    const agent = makeAgent({ tools: [{ id: 't1', type: 'node', name: 'Echo', description: 'Echo the input', nodeType: 'core.noOp', parameters: {} }] });
    script.push(call('Echo', { word: 'ping' }), reply('Echoed.'));
    const result = await runAgent({ agent, session: testSession(agent), message: 'echo ping' });

    expect(seen[0].tools.map((t) => t.name)).toEqual(['Echo']);
    expect(lastToolResults()).toEqual([{ id: 'call_Echo', name: 'Echo', content: JSON.stringify({ word: 'ping' }) }]);
    const tool = result.session.timeline.find((e) => e.type === 'tool');
    expect(tool).toMatchObject({ status: 'success', kind: 'node', nodeType: 'core.noOp', output: { word: 'ping' } });
  });

  it('runs a workflow from its "When Called by an Agent" trigger', async () => {
    store.saveWorkflow({
      id: 'wf_agent_tool',
      name: 'Lookup',
      nodes: [
        { id: 'in', name: 'When Called by an Agent', type: 'core.workflowTrigger', typeVersion: 1, position: [0, 0], parameters: { inputs: { fields: [{ name: 'count', type: 'number', required: true }] } } },
        { id: 'out', name: 'Done', type: 'core.noOp', typeVersion: 1, position: [300, 0], parameters: {} },
      ],
      connections: [{ id: 'e1', type: 'main', source: 'in', sourceIndex: 0, target: 'out', targetIndex: 0 }],
    } as never);
    const agent = makeAgent({ tools: [{ id: 't1', type: 'workflow', workflowId: 'wf_agent_tool', name: 'Lookup', description: 'Look things up' }] });
    script.push(call('Lookup', { count: '3' }), reply('Done.'));
    const result = await runAgent({ agent, session: testSession(agent), message: 'look up 3' });

    expect(seen[0].tools[0].inputSchema).toMatchObject({ properties: { count: { type: 'number' } }, required: ['count'] });
    // The trigger coerced the string argument to the declared type.
    expect(lastToolResults()[0].content).toBe(JSON.stringify({ count: 3 }));
    const entry = result.session.timeline.find((e) => e.type === 'tool');
    expect(entry).toMatchObject({ status: 'success', kind: 'workflow', workflowId: 'wf_agent_tool' });
    expect(entry?.type === 'tool' && entry.executionId).toBeTruthy();
  });

  it('reports unknown tools and tool errors to the model instead of failing', async () => {
    const agent = makeAgent();
    script.push(call('nope'), reply('Sorry.'));
    const result = await runAgent({ agent, session: testSession(agent), message: 'x' });
    expect(result.reason).toBe('completed');
    expect(lastToolResults()[0]).toMatchObject({ isError: true });
    expect(lastToolResults()[0].content).toContain('Unknown tool "nope"');
  });

  it('loads skills on demand and lists them in the system prompt', async () => {
    const agent = makeAgent({
      skills: [{ id: 's1', name: 'triage', whenToUse: 'Use when sorting tickets', instructions: '1. Read. 2. Label.', references: [{ name: 'labels.md', content: 'bug, feature' }] }],
    });
    script.push(call('load_skill', { name: 'triage' }), call('read_skill_reference', { skill: 'triage', file: 'labels.md' }), reply('Labeled.'));
    await runAgent({ agent, session: testSession(agent), message: 'triage this' });

    expect(seen[0].system).toContain('- triage: Use when sorting tickets');
    expect(seen[1].messages.at(-1)).toMatchObject({ role: 'tool', results: [{ content: expect.stringContaining('1. Read. 2. Label.') }] });
    expect(lastToolResults()[0].content).toBe('bug, feature');
  });

  it('pauses for approval and continues once approved', async () => {
    const agent = makeAgent({ tools: [{ id: 't1', type: 'node', name: 'Echo', description: 'Echo', nodeType: 'core.noOp', parameters: {}, requireApproval: true }] });
    script.push(call('Echo', { ok: true }));
    const paused = await runAgent({ agent, session: testSession(agent), message: 'do it' });

    expect(paused.reason).toBe('awaiting_approval');
    const waiting = agentStore.getSession(paused.session.id)!;
    expect(waiting.status).toBe('awaiting_approval');
    expect(waiting.pending?.calls).toEqual([{ callId: 'call_Echo', tool: 'Echo', input: { ok: true } }]);
    expect(waiting.timeline.find((e) => e.type === 'tool')).toMatchObject({ status: 'awaiting_approval' });

    script.push(reply('Done after approval.'));
    const resumed = await decide(agent, paused.session.id, 'call_Echo', true);
    expect(resumed).toMatchObject({ status: 'resumed', reason: 'completed', reply: 'Done after approval.' });
    expect(lastToolResults()).toEqual([{ id: 'call_Echo', name: 'Echo', content: JSON.stringify({ ok: true }) }]);
    const done = agentStore.getSession(paused.session.id)!;
    expect(done.pending).toBeUndefined();
    expect(done.timeline.find((e) => e.type === 'tool')).toMatchObject({ status: 'success' });
  });

  it('tells the model to stop when a call is denied, and waits for every decision of the turn', async () => {
    const agent = makeAgent({
      tools: [
        { id: 't1', type: 'node', name: 'A', description: 'a', nodeType: 'core.noOp', parameters: {}, requireApproval: true },
        { id: 't2', type: 'node', name: 'B', description: 'b', nodeType: 'core.noOp', parameters: {}, requireApproval: true },
        { id: 't3', type: 'node', name: 'C', description: 'c', nodeType: 'core.noOp', parameters: {} },
      ],
    });
    script.push(() => ({ toolCalls: [{ id: 'a', name: 'A', input: {} }, { id: 'c', name: 'C', input: { n: 1 } }, { id: 'b', name: 'B', input: {} }] }));
    const paused = await runAgent({ agent, session: testSession(agent), message: 'go' });
    // C needs no approval: it already ran.
    expect(agentStore.getSession(paused.session.id)!.pending?.results.map((r) => r.id)).toEqual(['c']);

    expect(await decide(agent, paused.session.id, 'a', false)).toMatchObject({ status: 'waiting' });
    await expect(decide(agent, paused.session.id, 'a', true)).rejects.toThrow('Already denied');

    script.push(reply('Stopping.'));
    await decide(agent, paused.session.id, 'b', true);
    // Results go back in the order the model made the calls.
    const results = lastToolResults();
    expect(results.map((r) => r.id)).toEqual(['a', 'c', 'b']);
    expect(results[0]).toMatchObject({ isError: true, content: expect.stringContaining('The user rejected the tool call to A') });
  });

  it('refuses an immediate retry of a tool the person just denied', async () => {
    const agent = makeAgent({ tools: [{ id: 't1', type: 'node', name: 'Echo', description: 'Echo', nodeType: 'core.noOp', parameters: {}, requireApproval: true }] });
    script.push(call('Echo', {}, 'first'));
    const paused = await runAgent({ agent, session: testSession(agent), message: 'do it' });
    script.push(call('Echo', {}, 'again'), reply('Okay, I will wait.'));
    const resumed = await decide(agent, paused.session.id, 'first', false);
    expect(resumed).toMatchObject({ status: 'resumed', reason: 'completed', reply: 'Okay, I will wait.' });
    expect(lastToolResults()[0]).toMatchObject({ id: 'again', isError: true, content: expect.stringContaining('Do not call it again now') });
  });

  it('refuses approval tools in unattended runs', async () => {
    const agent = makeAgent({ tools: [{ id: 't1', type: 'node', name: 'Echo', description: 'Echo', nodeType: 'core.noOp', parameters: {}, requireApproval: true }] });
    script.push(call('Echo'), reply('Could not.'));
    const result = await runAgent({ agent, session: testSession(agent), message: 'x', approvals: 'deny' });
    expect(result.reason).toBe('completed');
    expect(lastToolResults()[0]).toMatchObject({ isError: true, content: expect.stringContaining("needs a person's approval") });
    expect(result.session.timeline.find((e) => e.type === 'tool')).toMatchObject({ status: 'denied' });
  });

  it('delegates to a sub-agent in a child session, up to the depth limit', async () => {
    const researcher = makeAgent({ name: 'Researcher', description: 'Finds facts' });
    const lead = makeAgent({ name: 'Lead', tools: [{ id: 't1', type: 'agent', agentId: researcher.id }] });
    script.push(call('ask_Researcher', { task: 'Find X' }), reply('X is 42.'), reply('The answer is 42.'));
    const result = await runAgent({ agent: lead, session: testSession(lead), message: 'what is X?' });

    expect(result.reply).toBe('The answer is 42.');
    expect(seen[1].messages[0]).toEqual({ role: 'user', content: 'Find X' });
    const entry = result.session.timeline.find((e) => e.type === 'tool');
    expect(entry).toMatchObject({ kind: 'agent', output: 'X is 42.', childAgentId: researcher.id });
    const child = agentStore.getSession(entry?.type === 'tool' ? entry.childSessionId! : '')!;
    expect(child).toMatchObject({ source: 'agent', parentSessionId: result.session.id, parentAgentId: lead.id, userId: `agent:${lead.id}` });

    // Depth: a Lead limited to 1 level can't have its sub-agent delegate further.
    const deep = makeAgent({ name: 'Deep', tools: [{ id: 't1', type: 'agent', agentId: lead.id }], settings: { maxDelegationDepth: 1, maxIterations: 12, toolConcurrency: 5, sessionTokenBudget: 0 } });
    script.push(call('ask_Lead', { task: 't' }), call('ask_Researcher', { task: 't2' }), reply('Lead gave up.'), reply('ok'));
    await runAgent({ agent: deep, session: testSession(deep), message: 'go deep' });
    expect(seen.at(-2)!.messages.at(-1)).toMatchObject({ role: 'tool', results: [{ isError: true, content: expect.stringContaining('Delegation depth 1 reached') }] });
  });

  it('stops at the token budget and at max iterations', async () => {
    const budgeted = makeAgent({ tools: [{ id: 't1', type: 'node', name: 'Echo', description: 'e', nodeType: 'core.noOp', parameters: {} }], settings: { maxIterations: 12, toolConcurrency: 5, sessionTokenBudget: 20, maxDelegationDepth: 2 } });
    script.push(call('Echo'), call('Echo'));
    const over = await runAgent({ agent: budgeted, session: testSession(budgeted), message: 'loop' });
    expect(over.reason).toBe('budget');
    expect(seen).toHaveLength(2);

    const looping = makeAgent({ tools: [{ id: 't1', type: 'node', name: 'Echo', description: 'e', nodeType: 'core.noOp', parameters: {} }], settings: { maxIterations: 2, toolConcurrency: 5, sessionTokenBudget: 0, maxDelegationDepth: 2 } });
    script.length = 0;
    script.push(call('Echo'), call('Echo'), call('Echo'));
    const stuck = await runAgent({ agent: looping, session: testSession(looping), message: 'loop' });
    expect(stuck.reason).toBe('max_iterations');
    expect(stuck.session.timeline.at(-1)).toMatchObject({ type: 'notice', message: expect.stringContaining('Stopped after 2 iterations') });
  });

  it('remembers facts across sessions for the same user only', async () => {
    const agent = makeAgent({ memory: { crossSession: true } });
    script.push(call('remember', { fact: 'Prefers metric units' }), reply('Saved.'), reply('Hi again.'), reply('Hello stranger.'));
    await runAgent({ agent, session: testSession(agent), message: 'I use metric' });
    await runAgent({ agent, session: testSession(agent), message: 'hi' });
    expect(seen[2].system).toContain('Prefers metric units');
    await runAgent({ agent, session: newSession(agent, { source: 'telegram', userId: 'telegram:9', version: 'draft' }), message: 'hi' });
    expect(seen[3].system).not.toContain('Prefers metric units');
  });

  it('reports a missing model as a run error', async () => {
    const agent = agentStore.create({ name: 'No model' });
    const result = await runAgent({ agent, session: testSession(agent), message: 'x' });
    expect(result.reason).toBe('error');
    expect(result.session.timeline.at(-1)).toMatchObject({ type: 'error', message: 'Choose a model for this agent first' });
  });

  it('refuses a second run on a busy session', async () => {
    const agent = makeAgent();
    script.push(reply('one'));
    const session = testSession(agent);
    // The lock is taken synchronously, before the first await.
    const first = runAgent({ agent, session, message: 'one' });
    await expect(runAgent({ agent, session, message: 'two' })).rejects.toThrow('already running');
    await expect(first).resolves.toMatchObject({ reason: 'completed' });
  });
});

describe('agent versions', () => {
  it('publishes snapshots and runs sessions on the version they started with', () => {
    const agent = makeAgent({ instructions: 'v1 instructions' });
    const v1 = agentStore.publish(agent.id)!;
    expect(v1.published?.version).toBe(1);
    agentStore.saveDraft(agent.id, { instructions: 'draft instructions' });
    const v2 = agentStore.publish(agent.id)!;
    expect(v2.history.map((v) => v.version)).toEqual([2, 1]);
    expect(agentStore.summaries().find((s) => s.id === agent.id)).toMatchObject({ publishedVersion: 2, draftChanged: false });

    agentStore.saveDraft(agent.id, { instructions: 'newer draft' });
    const current = agentStore.get(agent.id)!;
    expect(configFor(current, 1).instructions).toBe('v1 instructions');
    expect(configFor(current, 2).instructions).toBe('draft instructions');
    expect(configFor(current, 'draft').instructions).toBe('newer draft');
    expect(agentStore.summaries().find((s) => s.id === agent.id)?.draftChanged).toBe(true);
    expect(agentStore.unpublish(agent.id)!.published).toBeUndefined();
  });

  it('restores an earlier version into the draft without publishing it, and names what changed', async () => {
    const { diffConfigs } = await import('@/lib/shared/agents');
    const { configOf } = await import('@/lib/server/agents/store');
    const agent = makeAgent({ instructions: 'first' });
    agentStore.publish(agent.id);
    agentStore.saveDraft(agent.id, { instructions: 'second', description: 'changed' });
    const v2 = agentStore.publish(agent.id)!;
    expect(diffConfigs(v2.history[1]!.config, v2.history[0]!.config).map((c) => c.field)).toEqual(['description', 'instructions']);

    const restored = agentStore.restore(agent.id, 1)!;
    expect(restored.instructions).toBe('first');
    expect(restored.published?.version).toBe(2);
    expect(diffConfigs(configOf(restored), v2.history[1]!.config)).toEqual([]);
    expect(agentStore.restore(agent.id, 99)).toBeUndefined();
  });

  it('restores a version that lacked the optional parts without keeping the draft\'s cache, router or access rules', () => {
    const agent = makeAgent({ instructions: 'plain' });
    agentStore.publish(agent.id);
    agentStore.saveDraft(agent.id, {
      cache: { enabled: true, ttlSeconds: 60 },
      router: { mode: 'auto', maxChars: 100, allowTools: false, cheapModel: { provider: 'ollama', model: 'small' } },
      access: { rules: [{ id: 'r', tool: '*', who: {}, effect: 'deny' }] },
    });
    expect(agentStore.get(agent.id)!.cache).toBeDefined();
    const restored = agentStore.restore(agent.id, 1)!;
    expect(restored.cache).toBeUndefined();
    expect(restored.router).toBeUndefined();
    expect(restored.access).toBeUndefined();
  });
});

describe('agent nodes', () => {
  it('"When Called by an Agent" coerces arguments and fills examples for manual runs', async () => {
    const parameters = { inputs: { fields: [{ name: 'n', type: 'number', required: true }, { name: 'flag', type: 'boolean' }, { name: 'data', type: 'json' }] } };
    const manual = await run(workflowTrigger, parameters, [{}]);
    expect(manual.json()).toEqual([{ n: 0, flag: false, data: {} }]);
    const passed = await run(workflowTrigger, parameters, [{ n: '7', flag: 'true', data: '{"a":1}' }]);
    expect(passed.json()).toEqual([{ n: 7, flag: true, data: { a: 1 } }]);
  });

  it('"Message an Agent" needs a published agent and returns its reply', async () => {
    const agent = makeAgent({ name: 'Replier' });
    const unpublished = await run(messageAgentNode, { agentId: agent.id, message: 'hi', conversation: 'new' });
    expect(unpublished.error?.message).toBe('Publish “Replier” first');

    agentStore.publish(agent.id);
    script.push(reply('Hello from the agent.'));
    const ok = await run(messageAgentNode, { agentId: agent.id, message: 'hi', conversation: 'new' });
    expect(ok.json()[0]).toMatchObject({ reply: 'Hello from the agent.', agentId: agent.id, version: 1, endReason: 'completed' });
    expect(agentStore.getSession(ok.json()[0].sessionId as string)).toMatchObject({ source: 'workflow', version: 1, execution: { workflowId: 'wf_test', executionId: 'ex_test', nodeId: 'n1' } });
  });
});

describe('agent schedules and channels', () => {
  it('turns schedules into cron expressions', () => {
    expect(scheduleCron({ frequency: 'hourly', time: '00:15' })).toBe('15 * * * *');
    expect(scheduleCron({ frequency: 'hourly', time: '15' })).toBe('15 * * * *');
    expect(scheduleCron({ frequency: 'daily', time: '09:30' })).toBe('30 9 * * *');
    expect(scheduleCron({ frequency: 'weekly', time: '08:00', weekday: 5 })).toBe('0 8 * * 5');
    expect(scheduleCron({ frequency: 'monthly', time: '07:05', dayOfMonth: 31 })).toBe('5 7 28 * *');
    expect(scheduleCron({ frequency: 'cron', cron: '*/10 9-17 * * 1-5' })).toBe('*/10 9-17 * * 1-5');
  });

  it('matches cron fields, including steps, ranges, lists and Sunday as 7', () => {
    const at = (minute: number, hour: number, day = 1, month = 1, weekday = 1) => ({ minute, hour, day, month, weekday });
    expect(parseCron('*/15 9-17 * * 1-5').matches(at(30, 10))).toBe(true);
    expect(parseCron('*/15 9-17 * * 1-5').matches(at(31, 10))).toBe(false);
    expect(parseCron('0 9 * * 7').matches(at(0, 9, 1, 1, 0))).toBe(true);
    expect(parseCron('0 0 1,15 * *').matches(at(0, 0, 15))).toBe(true);
    // Both day fields restricted: either matches (classic cron).
    expect(parseCron('0 0 13 * 5').matches(at(0, 0, 2, 1, 5))).toBe(true);
    expect(() => parseCron('61 * * * *')).toThrow('out of range');
    expect(() => parseCron('* * *')).toThrow('five fields');
  });

  it('checks schedules in their time zone', () => {
    const instant = new Date('2026-10-25T07:00:00Z');
    expect(timeParts(instant, 'Asia/Jerusalem')).toMatchObject({ hour: 9, minute: 0, weekday: 0 });
    const schedule = { id: 's', prompt: 'p', frequency: 'daily' as const, time: '09:00', timezone: 'Asia/Jerusalem', enabled: true };
    expect(isDue(schedule, instant)).toBe(true);
    expect(isDue({ ...schedule, timezone: 'UTC' }, instant)).toBe(false);
  });

  it('lets only allowed Telegram users talk to a private agent', () => {
    const channel = { access: 'private' as const, allowedUsers: ['@Alice', '12345'] };
    expect(allowed(channel, { id: 1, username: 'alice' })).toBe(true);
    expect(allowed(channel, { id: 12345 })).toBe(true);
    expect(allowed(channel, { id: 2, username: 'mallory' })).toBe(false);
    expect(allowed(channel, null)).toBe(false);
    expect(allowed({ access: 'public', allowedUsers: [] }, { id: 2 })).toBe(true);
  });
});
