import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { MeterProvider, MetricReader, type DataPoint } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import type { AgentMessage, AgentTool, LanguageModel, ModelTurn, ToolSpec } from '@landflow/engine';
import type { Agent, AgentConfig, AgentStreamEvent, RemoteRun } from '@/lib/shared/agents';
import { defineNode } from '@landflow/sdk';
import { startFakeA2a, type FakeA2a } from './fake-a2a';

type Step = (input: { messages: AgentMessage[]; tools: ToolSpec[] }) => Partial<ModelTurn>;
const script: Step[] = [];
const seen: Array<{ messages: AgentMessage[]; tools: ToolSpec[] }> = [];

vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:11434',
  modelOptions: async () => [],
  agentModel: (): LanguageModel => ({
    provider: 'scripted',
    model: 'scripted-1',
    async generate(input) {
      seen.push({ messages: structuredClone(input.messages), tools: input.tools });
      const step = script.shift();
      if (!step) throw new Error('The script ran out of turns');
      return { text: '', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 }, ...step(input) };
    },
  }),
}));

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { a2aAgentNode } = await import('@/lib/server/nodes/a2a');
const { agentStore } = await import('@/lib/server/agents/store');
const { decide, newSession, runAgent } = await import('@/lib/server/agents/runtime');
const { applyStreamEvent, endpointFrom, getAgentCard, remoteSaidOf, remoteStepsOf, replyOf, sendMessage, streamMessage } = await import('@/lib/server/a2a/client');
const { run, runFlow, outputsOf } = await import('./helpers');

class TestReader extends MetricReader {
  protected async onForceFlush() {}
  protected async onShutdown() {}
}

const spans = new InMemorySpanExporter();
const reader = new TestReader();
let fake: FakeA2a;

beforeAll(async () => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spans })] }));
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
  registry.registerBuiltin(corePlugin);
  fake = await startFakeA2a();
});
afterAll(async () => {
  await fake.close();
  trace.disable();
  metrics.disable();
  propagation.disable();
  context.disable();
});
beforeEach(() => {
  spans.reset();
  fake.calls.length = 0;
  fake.streaming = false;
  fake.legacyCard = false;
  script.length = 0;
  seen.length = 0;
});

const reply = (text: string): Step => () => ({ text });
const call = (name: string, input: Record<string, unknown>, id = `call_${name}`): Step => () => ({ toolCalls: [{ id, name, input }] });
// A fresh endpoint per test: the card cache is keyed by URL and headers.
const endpoint = () => endpointFrom({ agentUrl: `${fake.url}/.well-known/agent-card.json`, authentication: 'none', options: { timeout: 5_000 } }, {});
async function points(name: string) {
  const { resourceMetrics } = await reader.collect();
  return resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics).filter((m) => m.descriptor.name === name).flatMap((m) => m.dataPoints as DataPoint<number>[]);
}

describe('A2A client', () => {
  it('reads the card from the endpoint and refuses agents that speak an older A2A', async () => {
    const card = await getAgentCard(endpoint(), { fresh: true });
    expect(card).toMatchObject({ name: 'fake-agent' });
    fake.legacyCard = true;
    await expect(getAgentCard(endpoint(), { fresh: true })).rejects.toThrow(/speaks A2A 0\.3\.0.*Landflow speaks A2A 1\.0/);
  });

  it('sends a message, follows a working task with GetTask, and reads the tool calls', async () => {
    const slow = await sendMessage(endpoint(), { text: 'slow' });
    expect(slow.kind === 'task' && slow.task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(replyOf(slow)).toBe('finally done');
    expect(fake.calls.map((c) => c.method)).toEqual(['SendMessage', 'GetTask']);
    expect(fake.calls[0].headers['a2a-version']).toBe('1.0');

    const result = await sendMessage(endpoint(), { text: 'slug Deep Tracing' });
    expect(replyOf(result)).toBe('The slug is deep-tracing');
    if (result.kind !== 'task') throw new Error('expected a task');
    expect(remoteStepsOf(result.task)).toEqual([
      { id: 'call-1', name: 'slugify', args: { text: 'Deep Tracing' }, output: { slug: 'deep-tracing' }, status: 'success', startedAt: '2026-10-30T09:00:01.000Z', endedAt: '2026-10-30T09:00:02.000Z' },
    ]);
  });

  it('streams: appended chunks build the answer, and each event updates the task', async () => {
    const updates: string[] = [];
    const result = await streamMessage(endpoint(), { text: 'slug Live Steps' }, { onUpdate: (task) => updates.push(task.status.state) });
    expect(fake.calls[0].method).toBe('SendStreamingMessage');
    expect(replyOf(result)).toBe('The slug is live-steps');
    expect(updates[0]).toBe('TASK_STATE_SUBMITTED');
    expect(updates.at(-1)).toBe('TASK_STATE_COMPLETED');

    const chunked = applyStreamEvent(
      applyStreamEvent(undefined, { artifactUpdate: { taskId: 't', contextId: 'c', artifact: { artifactId: 'a', parts: [{ text: 'Hel' }] } } }),
      { artifactUpdate: { taskId: 't', contextId: 'c', append: true, artifact: { artifactId: 'a', parts: [{ text: 'lo' }] } } },
    );
    expect(replyOf({ kind: 'task', task: chunked! })).toBe('Hello');
  });

  it('marks a response that says isError as a failed step, also inside output', () => {
    const part = (kind: string, data: Record<string, unknown>) => ({ data, metadata: { 'kagent.dev/a2a/part-type': kind } });
    const task = {
      id: 't',
      contextId: 'c',
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [
        { artifactId: 'a1', parts: [part('function_call', { id: 'push', name: 'bash', args: { command: 'git push' } })] },
        { artifactId: 'a2', parts: [part('function_response', { id: 'push', name: 'bash', response: { output: { isError: true, result: 'Exit code 128\nfatal: no remote' } } })] },
        { artifactId: 'a3', parts: [part('function_call', { id: 'ls', name: 'bash' }), part('function_response', { id: 'ls', name: 'bash', response: { isError: true, content: 'denied' } })] },
        { artifactId: 'a4', parts: [part('function_call', { id: 'ok', name: 'bash' }), part('function_response', { id: 'ok', name: 'bash', response: { output: { isError: false, result: 'fine' } } })] },
      ],
    } as unknown as Parameters<typeof remoteStepsOf>[0];
    expect(remoteStepsOf(task).map((s) => [s.id, s.status, s.error])).toEqual([
      ['push', 'error', 'Exit code 128\nfatal: no remote'],
      ['ls', 'error', 'denied'],
      ['ok', 'success', undefined],
    ]);
  });

  it('marks the call a pause waits on as awaiting approval', async () => {
    const result = await sendMessage(endpoint(), { text: 'upper quiet' });
    if (result.kind !== 'task') throw new Error('expected a task');
    expect(result.task.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(remoteStepsOf(result.task)).toEqual([expect.objectContaining({ id: 'call-2', name: 'changeCase', status: 'awaiting_approval', args: { text: 'quiet', case: 'upper' } })]);
  });
});

describe('A2A Agent node', () => {
  const params = (extra: Record<string, unknown>) => ({ agentUrl: fake.url, authentication: 'none', options: { timeout: 5_000 }, ...extra });

  it('reports the remote agent’s steps through ctx.sendProgress while it streams', async () => {
    fake.streaming = true;
    const reports: Array<Record<string, unknown>> = [];
    const res = await run(a2aAgentNode, { ...params({ operation: 'sendMessage', message: 'slug Hello World' }), agentUrl: `${fake.url}-progress` }, [{}], undefined, { sendProgress: (data) => reports.push(data) });
    expect(res.error).toBeUndefined();
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]).toMatchObject({ agent: 'fake-agent' });
    expect(reports.at(-1)).toMatchObject({ agent: 'fake-agent', state: 'completed', steps: [{ name: 'slugify', status: 'success', args: '{"text":"Hello World"}' }] });
    // The first report with a step carries its arguments whole: the journal records the step from that report.
    const first = reports.find((r) => (r.steps as unknown[] | undefined)?.length);
    expect(first).toMatchObject({ steps: [{ name: 'slugify', args: { text: 'Hello World' } }] });
    // The output is the same as without progress.
    expect(res.json()[0]).toMatchObject({ reply: 'The slug is hello-world', steps: [{ name: 'slugify', status: 'success' }] });
  });

  it('sends a message in a traced client span, with the trace context and landflow tags', async () => {
    const res = await run(a2aAgentNode, params({ operation: 'sendMessage', message: 'slug Hello World' }));
    expect(res.error).toBeUndefined();
    expect(res.json()[0]).toMatchObject({ reply: 'The slug is hello-world', state: 'completed', agent: 'fake-agent', steps: [{ name: 'slugify', status: 'success' }] });

    const span = spans.getFinishedSpans().find((s) => s.name === 'invoke_agent fake-agent')!;
    expect(span.kind).toBe(2); // CLIENT
    expect(span.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'rpc.system': 'jsonrpc',
      'rpc.method': 'SendMessage',
      'a2a.task.state': 'completed',
      'gen_ai.usage.input_tokens': 120,
      'gen_ai.usage.output_tokens': 30,
      'landflow.a2a.caller': 'node',
    });
    expect(span.events.map((e) => [e.name, e.attributes?.['gen_ai.tool.name']])).toEqual([['a2a.tool_call', 'slugify']]);
    const sent = fake.calls.find((c) => c.method === 'SendMessage')!;
    expect(sent.headers.traceparent).toContain(span.spanContext().traceId);
    expect(sent.params.message?.metadata).toMatchObject({ 'landflow.execution.id': 'ex_test', 'landflow.workflow.id': 'wf_test' });
    expect((await points('landflow.a2a.calls')).some((p) => p.attributes['a2a.task.state'] === 'completed')).toBe(true);
    expect((await points('landflow.a2a.tool.calls')).some((p) => p.attributes['gen_ai.tool.name'] === 'slugify')).toBe(true);
  });

  it('returns a pause and answers it', async () => {
    const paused = (await run(a2aAgentNode, params({ operation: 'sendMessage', message: 'upper calm' }))).json()[0];
    expect(paused).toMatchObject({ state: 'input-required', pause: { type: 'approval', calls: [{ name: 'changeCase', callId: 'call-2' }] } });
    const approved = (await run(a2aAgentNode, params({ operation: 'respond', taskId: paused.taskId, response: 'approve' }))).json()[0];
    expect(approved).toMatchObject({ state: 'completed', reply: 'CALM' });
    const answer = fake.calls.filter((c) => c.method === 'SendMessage').at(-1)!;
    expect(answer.params.message).toMatchObject({ taskId: paused.taskId, extensions: ['https://kagent.dev/extensions/hitl/v1'] });
  });

  it('fails the item when the task fails', async () => {
    const res = await run(a2aAgentNode, params({ operation: 'sendMessage', message: 'fail' }));
    expect(res.error?.message).toBe('fake-agent: the task failed');
  });
});

describe('agents: A2A capability', () => {
  /** `path`: another URL on the fake, so the agent card isn't one cached by an earlier test. */
  function makeAgent(config: Partial<AgentConfig> = {}, path = ''): Agent {
    return agentStore.create({
      name: 'Caller',
      instructions: 'Use the remote agent.',
      model: { provider: 'ollama', model: 'scripted-1' },
      tools: [{ id: 'remote1', type: 'a2a', name: 'texter', parameters: { agentUrl: `${fake.url}${path}`, authentication: 'none', options: { timeout: 5_000 } } }],
      ...config,
    });
  }
  const session = (agent: Agent) => newSession(agent, { source: 'test', userId: 'you', version: 'draft' });

  it('offers ask_<name> from the card, streams the remote steps into the timeline and keeps the conversation', async () => {
    fake.streaming = true;
    const agent = makeAgent({}, '-streaming');
    script.push(call('ask_texter', { message: 'slug One Two' }), reply('Done.'), call('ask_texter', { message: 'again' }), reply('Ok.'));
    const events: AgentStreamEvent[] = [];
    const result = await runAgent({ agent, session: session(agent), message: 'slugify it', onEvent: (e) => events.push(e) });
    expect(result).toMatchObject({ reason: 'completed', reply: 'Done.' });
    expect(seen[0].tools.find((t) => t.name === 'ask_texter')?.description).toContain('A fake kagent agent');
    expect(seen[0].tools.find((t) => t.name === 'ask_texter')?.inputSchema).toMatchObject({ required: ['message', 'reason'] });

    const entry = result.session.timeline.find((e) => e.type === 'tool')!;
    expect(entry).toMatchObject({ kind: 'a2a', status: 'success', output: 'The slug is one-two', remote: { agent: 'fake-agent', state: 'completed', usage: { inputTokens: 120, outputTokens: 30 } } });
    // Live progress: a running entry with the remote step before the final one.
    const running = events.flatMap((e) => (e.type === 'entry' && e.entry.type === 'tool' && e.entry.status === 'running' ? [e.entry.remote] : [])).filter(Boolean) as RemoteRun[];
    expect(running.some((r) => r.steps.some((s) => s.name === 'slugify'))).toBe(true);
    expect(fake.calls[0].params.message?.metadata).toMatchObject({ 'landflow.agent.id': agent.id, 'landflow.session.id': result.session.id });

    // The next message in the session continues the same remote conversation.
    const contextId = result.session.remoteContexts?.remote1?.contextId;
    expect(contextId).toBeTruthy();
    await runAgent({ agent, session: agentStore.getSession(result.session.id)!, message: 'more' });
    expect(fake.calls.at(-1)!.params.message?.contextId).toBe(contextId);
    // invoke_agent (client) runs inside the agent's execute_tool span.
    const client = spans.getFinishedSpans().find((s) => s.name === 'invoke_agent fake-agent')!;
    const parent = spans.getFinishedSpans().find((s) => s.spanContext().spanId === client.parentSpanContext?.spanId);
    expect(parent?.name).toBe('execute_tool ask_texter');
  });

  it('turns the remote agent’s approval request into a pause, and sends the decision when a person decides', async () => {
    const agent = makeAgent();
    script.push(call('ask_texter', { message: 'upper loud' }));
    const paused = await runAgent({ agent, session: session(agent), message: 'make it loud' });
    expect(paused.reason).toBe('awaiting_approval');
    const saved = agentStore.getSession(paused.session.id)!;
    expect(saved.pending?.calls[0]).toMatchObject({ tool: 'ask_texter', remote: { agent: 'fake-agent', calls: [{ name: 'changeCase', args: { text: 'loud', case: 'upper' } }] } });
    expect(saved.timeline.find((e) => e.type === 'tool')).toMatchObject({ status: 'awaiting_approval', approval: { message: 'fake-agent wants to run changeCase' } });

    script.push(reply('It is LOUD now.'));
    const resumed = await decide(agent, paused.session.id, 'call_ask_texter', true);
    expect(resumed).toMatchObject({ status: 'resumed', reason: 'completed', reply: 'It is LOUD now.' });
    const decision = fake.calls.at(-1)!.params.message!;
    expect(decision.metadata?.['https://kagent.dev/extensions/hitl/v1']).toMatchObject({ type: 'tool_approval_response', approvals: [{ id: 'adk-1', approved: true }] });
    // The model got the remote agent's answer as the tool result.
    const results = seen.at(-1)!.messages.at(-1)!;
    expect(results.role === 'tool' && results.results[0]).toMatchObject({ id: 'call_ask_texter', content: 'LOUD' });
  });

  it('a rejected remote call reaches the agent with the reason, and the model may ask again', async () => {
    const agent = makeAgent();
    script.push(call('ask_texter', { message: 'upper soft' }));
    const paused = await runAgent({ agent, session: session(agent), message: 'x' });
    script.push(call('ask_texter', { message: 'slug soft' }), reply('Used a slug instead.'));
    const resumed = await decide(agent, paused.session.id, 'call_ask_texter', false);
    expect(resumed).toMatchObject({ status: 'resumed', reason: 'completed' });
    const rejection = fake.calls.find((c) => (c.params.message?.metadata?.['https://kagent.dev/extensions/hitl/v1'] as { type?: string })?.type === 'tool_approval_response')!;
    expect(rejection.params.message?.metadata?.['https://kagent.dev/extensions/hitl/v1']).toMatchObject({ approvals: [{ approved: false, rejection_reason: 'A person rejected this tool call.' }] });
    // Not refused as "just rejected": the second ask_texter call ran.
    expect(fake.calls.at(-1)!.params.message?.parts?.[0]?.text).toBe('slug soft');
  });

  it('rejects remote approvals itself when no one can approve (unattended runs)', async () => {
    const agent = makeAgent();
    script.push(call('ask_texter', { message: 'upper none' }), reply('Could not.'));
    const result = await runAgent({ agent, session: session(agent), message: 'x', approvals: 'deny' });
    expect(result).toMatchObject({ reason: 'completed', reply: 'Could not.' });
    const decision = fake.calls.at(-1)!.params.message?.metadata?.['https://kagent.dev/extensions/hitl/v1'];
    expect(decision).toMatchObject({ type: 'tool_approval_response', approvals: [{ approved: false }] });
  });

  it('relays a remote question to the model and sends its next call as the answer', async () => {
    const agent = makeAgent();
    script.push(call('ask_texter', { message: 'ask' }, 'c1'), call('ask_texter', { message: 'blue' }, 'c2'), reply('Blue it is.'));
    const result = await runAgent({ agent, session: session(agent), message: 'x' });
    expect(result.reply).toBe('Blue it is.');
    const first = seen[1].messages.at(-1)!;
    expect(first.role === 'tool' && first.results[0].content).toContain('fake-agent asks:\n- Which colour?');
    const answer = fake.calls.at(-1)!.params.message!;
    expect(answer.metadata?.['https://kagent.dev/extensions/hitl/v1']).toEqual({ type: 'ask_user_response', id: 'q-1', answers: [{ answer: ['blue'] }] });
    const tool = result.session.timeline.filter((e) => e.type === 'tool').at(-1);
    expect(tool).toMatchObject({ output: 'You said: blue' });
  });

  it('shows an unreachable agent as a notice', async () => {
    const agent = makeAgent({ tools: [{ id: 'gone', type: 'a2a', name: 'gone', parameters: { agentUrl: 'http://127.0.0.1:1/agents/x', authentication: 'none', options: { timeout: 1_000 } } }] });
    script.push(reply('Alone.'));
    const result = await runAgent({ agent, session: session(agent), message: 'x' });
    expect(result.session.timeline.find((e) => e.type === 'notice')).toMatchObject({ message: expect.stringContaining('Tool unavailable: gone: Could not reach') });
  });
});

describe('A2A node as an agent’s tool', () => {
  // A node that calls the attached tool with scripted arguments and returns each result.
  const caller = defineNode({
    description: { name: 'caller', displayName: 'Caller', description: '', version: 1, kind: 'action', inputs: [{ type: 'main' }, { type: 'ai_tool' }], outputs: [{ type: 'main' }], properties: [{ name: 'calls', displayName: 'Calls', type: 'string' }] },
    async execute(ctx) {
      const [tool] = await ctx.getInputConnectionData!<AgentTool>('ai_tool');
      const results: unknown[] = [];
      for (const message of String(ctx.getNodeParameter('calls')).split('|')) results.push(await tool.invoke({ message, reason: 'testing' }));
      return [[{ json: { schema: tool.inputSchema, name: tool.name, results } as never }]];
    },
  });
  const flow = (calls: string, options: Record<string, unknown> = {}, path = '-tool') =>
    runFlow(
      [
        { name: 'Caller', type: 'test.caller', parameters: { calls } },
        { name: 'Planner', type: 'core.a2aAgent', parameters: { agentUrl: `${fake.url}${path}`, authentication: 'none', operation: 'sendMessage', message: '', options: { timeout: 5_000, ...options } } },
      ],
      [['Start', 'Caller'], ['Planner', 'Caller', 'ai_tool', 0, 1]],
      { extra: { caller } },
    );
  const out = (result: Awaited<ReturnType<typeof flow>>) => outputsOf(result, 'Caller')[0][0] as { schema: { required: string[] }; name: string; results: Array<Record<string, unknown>> };

  it('asks for a reason and keeps the conversation across calls', async () => {
    const result = await flow('slug One|again');
    const { schema, results } = out(result);
    expect(schema.required).toEqual(['message', 'reason']);
    expect(results[0]).toMatchObject({ reply: 'The slug is one', agent: 'fake-agent' });
    const sends = fake.calls.filter((c) => c.method === 'SendMessage');
    expect(sends[0].params.message?.contextId).toBeUndefined();
    expect(sends[1].params.message?.contextId).toBe(results[0].contextId);
    expect(results[1].contextId).toBe(results[0].contextId);
    // The reason is for the record: the remote agent gets only the message.
    expect(sends[0].params.message?.parts?.[0]?.text).toBe('slug One');
    const started = result.runData.Planner[0].inputs[0][0].json;
    expect(started).toMatchObject({ message: 'slug One', reason: 'testing' });
  });

  it('hands the remote agent’s question to the calling agent and routes its next call as the answer', async () => {
    const result = await flow('ask|blue', {}, '-ask');
    const { results, name } = out(result);
    expect(results[0]).toMatchObject({ state: 'input-required', asksCaller: true, reply: `fake-agent asks:\n- Which colour?\nCall ${name} again with your answer as the message.` });
    expect(results[0].pause).toBeUndefined();
    expect(results[1]).toMatchObject({ state: 'completed', reply: 'You said: blue' });
    const answer = fake.calls.filter((c) => c.method === 'SendMessage').at(-1)!.params.message!;
    expect(answer.taskId).toBe(results[0].taskId);
    expect(answer.metadata?.['https://kagent.dev/extensions/hitl/v1']).toEqual({ type: 'ask_user_response', id: 'q-1', answers: [{ answer: ['blue'] }] });
  });

  it('with “Questions go to: a person” returns the pause as today and sends the next call as a new message', async () => {
    const result = await flow('ask|blue', { questionsGoTo: 'person' }, '-person');
    const { results } = out(result);
    expect(results[0]).toMatchObject({ state: 'input-required', pause: { type: 'question', questions: ['Which colour?'] } });
    expect(results[0].asksCaller).toBeUndefined();
    const last = fake.calls.filter((c) => c.method === 'SendMessage').at(-1)!.params.message!;
    expect(last.taskId).toBeUndefined();
    expect(last.parts?.[0]?.text).toBe('blue');
  });

  it('keeps tool approvals as they are: the pause reaches the caller as a result', async () => {
    const { results } = out(await flow('upper calm', {}, '-approve'));
    expect(results[0]).toMatchObject({ state: 'input-required', pause: { type: 'approval' } });
  });

  it('reports what the agent said between its tool calls, in order with the steps', async () => {
    const task = (await sendMessage(endpoint(), { text: 'chatty Hello There' })) as { kind: 'task'; task: Parameters<typeof remoteSaidOf>[0] };
    expect(remoteStepsOf(task.task).map((s) => s.name)).toEqual(['slugify']);
    // The last artifact is the answer; the text before it is said: one before the call, one after.
    expect(remoteSaidOf(task.task).map((w) => [w.text, w.afterSteps])).toEqual([['Let me slugify that first.', 0], ['The slug looks right.', 1]]);
    expect(replyOf(task)).toBe('Done: hello-there');
  });

  it('joins words streamed a token at a time into what was said between two tool calls', () => {
    const call = (id: string, type: string) => ({ artifactId: `a-${id}-${type}`, parts: [{ data: { id, name: 'Bash' }, metadata: { 'kagent.dev/a2a/part-type': type } }] });
    const tokens = (id: string, ...words: string[]) => ({ artifactId: id, parts: words.map((text) => ({ text })) });
    const task = {
      id: 't',
      contextId: 'c',
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [tokens('a1', 'I', "'ll", ' clone', ' it', '.', '\n\nThen', ' look.'), call('c1', 'function_call'), call('c1', 'function_response'), tokens('a2', 'Cloned', '.'), call('c2', 'function_call'), tokens('a3', 'Done', '.')],
    } as unknown as Parameters<typeof remoteSaidOf>[0];
    expect(remoteSaidOf(task)).toEqual([
      { id: 'a1:0', text: "I'll clone it.\n\nThen look.", afterSteps: 0 },
      { id: 'a2:0', text: 'Cloned.', afterSteps: 1 },
    ]);
  });
});
