/**
 * Streamed replies: the model adapters stream tokens (OpenAI-compatible SSE, Ollama NDJSON, Anthropic Messages
 * SSE), the AI Agent turns them into node.chunk events, and they reach the editor's chat panel (run route SSE),
 * the Webhook trigger's "Streaming" response mode (NDJSON / SSE) and tool approvals decided in the chat panel
 * (POST /api/executions/:id/approvals). Everything runs against the local fakes in ./fake-ai-services.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import { readSse, startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-streaming-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://stream.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { publishDraft } = await import('@/lib/server/publish');
const { anthropicModel, ollamaModel, openAiConnection, openAiModel, thinkFilter } = await import('@/lib/server/nodes/models');
const runRoute = await import('@/app/api/workflows/[id]/run/route');
const approvalsRoute = await import('@/app/api/executions/[id]/approvals/route');
const webhookRoute = await import('@/app/api/webhook/[...path]/route');

registry.registerBuiltin(corePlugin);
const fake = await startFakeModels();
const openAi = credentials.create({ name: 'Fake OpenAI', type: 'core.openAiApi', data: { apiKey: 'sk-test', baseUrl: fake.url } });

afterAll(async () => {
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
const edge = (source: string, target: string, type: 'main' | 'ai_languageModel' | 'ai_tool' = 'main') => ({ id: `${source}-${target}`, type, source, target, sourceIndex: 0, targetIndex: 0 });
const model = () => node('Model', 'core.openAiChatModel', { model: 'gpt-test' }, { credentials: { openAiApi: { id: openAi.id, name: openAi.name } } });
const user = (content: string) => [{ role: 'user' as const, content }];
/** What the fake model answers after the Calculator ran (it echoes the tool result). */
const ANSWER = 'The answer is {"expression":"6*7","result":42}';

/** Chat trigger → AI Agent with the fake OpenAI model and the Calculator. */
function chatWorkflow(id: string, agent: Record<string, unknown> = {}): Workflow {
  return {
    id,
    name: `Chat ${id}`,
    nodes: [node('Chat', 'core.chatTrigger'), node('Agent', 'core.aiAgent', { prompt: '{{ $json.chatInput }}', ...agent }), model(), node('Calculator', 'core.calculatorTool')],
    connections: [edge('Chat', 'Agent'), edge('Model', 'Agent', 'ai_languageModel'), edge('Calculator', 'Agent', 'ai_tool')],
  };
}

type Chunk = { type: string; content?: string; itemIndex?: number; tool?: { id: string; name: string; status: string; input?: unknown; output?: string } };

/** The node.chunk events among a run route's SSE events. */
const chunksOf = (events: Array<{ event: string; data: { type?: string; chunk?: Chunk } }>) =>
  events.filter((e) => e.event === 'execution' && e.data.type === 'node.chunk').map((e) => e.data.chunk!);

describe('model adapters stream tokens', () => {
  it('OpenAI-compatible: SSE deltas, usage from the last chunk, tool calls put back together', async () => {
    const tokens: string[] = [];
    const llm = openAiModel(openAiConnection({ apiKey: 'sk-test', baseUrl: fake.url }), { model: 'gpt-test' });
    const turn = await llm.generate({ messages: user('Say hello'), tools: [], onToken: (delta) => tokens.push(delta) });
    expect(turn.text).toBe('Echo: Say hello');
    expect(tokens.length).toBeGreaterThan(2);
    expect(tokens.join('')).toBe('Echo: Say hello');
    expect(turn.usage).toEqual({ inputTokens: 12, outputTokens: 8 });
    expect(fake.last('/v1/chat/completions')!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });

    const withTool = await llm.generate({ messages: user('6*7?'), tools: [{ name: 'calculator', description: 'math', inputSchema: { type: 'object' } }], onToken: () => {} });
    expect(withTool.toolCalls).toEqual([{ id: 'call_1', name: 'calculator', input: { expression: '6*7' } }]);
  });

  it('OpenAI-compatible without onToken stays a plain request', async () => {
    const llm = openAiModel(openAiConnection({ apiKey: 'sk-test', baseUrl: fake.url }), { model: 'gpt-test' });
    expect((await llm.generate({ messages: user('plain'), tools: [] })).text).toBe('Echo: plain');
    expect(fake.last('/v1/chat/completions')!.body.stream).toBeUndefined();
  });

  it('Ollama: NDJSON deltas with <think> hidden, token counts from the last line', async () => {
    const thinking = await startFakeModels({ reply: () => ({ text: '<think>secret plan</think>Hello there', usage: { input: 30, output: 5 } }) });
    try {
      const tokens: string[] = [];
      const turn = await ollamaModel({ baseUrl: thinking.origin, model: 'qwen-test' }).generate({ messages: user('hi'), tools: [], onToken: (delta) => tokens.push(delta) });
      expect(tokens.length).toBeGreaterThan(1);
      expect(tokens.join('')).toBe('Hello there');
      expect(turn.text).not.toContain('secret');
      expect(turn.usage).toEqual({ inputTokens: 30, outputTokens: 5 });
      expect(thinking.last('/api/chat')!.body.stream).toBe(true);
    } finally {
      await thinking.close();
    }
  });

  it('Anthropic: Messages SSE through the official SDK, text deltas and tool use', async () => {
    const tokens: string[] = [];
    const claude = anthropicModel({ model: 'claude-test', effort: 'low', maxTokens: 1024, fallback: false, apiKey: 'sk-ant-test', baseUrl: fake.origin });
    const turn = await claude.generate({ messages: user('Stream please'), tools: [], onToken: (delta) => tokens.push(delta) });
    expect(turn.text).toBe('Echo: Stream please');
    expect(tokens.join('')).toBe('Echo: Stream please');
    expect(tokens.length).toBeGreaterThan(2);
    expect(turn.usage).toEqual({ inputTokens: 12, outputTokens: 8 });
    expect(fake.last('/v1/messages')!.body.stream).toBe(true);

    const tool = await claude.generate({ messages: user('6*7'), tools: [{ name: 'calculator', description: 'math', inputSchema: { type: 'object' } }], onToken: () => {} });
    expect(tool.toolCalls).toEqual([{ id: 'call_1', name: 'calculator', input: { expression: '6*7' } }]);
  });

  it('thinkFilter hides tags split across deltas', () => {
    const filter = thinkFilter();
    const out = ['Hi <thi', 'nk>do not', ' show</th', 'ink> there', ' <', 'b>bold</b>'].map(filter).join('');
    expect(out).toBe('Hi  there <b>bold</b>');
  });
});

describe('streamed chat replies (editor chat panel)', () => {
  it('streams the AI Agent’s text and tool calls through the Chat trigger as they happen', async () => {
    const id = 'wf_stream_chat';
    store.saveWorkflow(chatWorkflow(id));
    const response = await runRoute.POST(
      new Request(`http://stream.test/api/workflows/${id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat: { message: 'What is 6*7?', sessionId: 's1' } }) }),
      params({ id }),
    );
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const events = await readSse(response);
    const result = events.find((e) => e.event === 'result')!.data;
    expect(result.status).toBe('success');

    const chunks = chunksOf(events);
    expect(chunks[0]).toMatchObject({ type: 'begin', itemIndex: 0 });
    expect(chunks.at(-1)).toMatchObject({ type: 'end' });
    const tools = chunks.filter((c) => c.type === 'tool').map((c) => [c.tool!.name, c.tool!.status]);
    expect(tools).toEqual([
      ['Calculator', 'started'],
      ['Calculator', 'finished'],
    ]);
    const text = chunks.filter((c) => c.type === 'item').map((c) => c.content).join('');
    expect(text).toBe(ANSWER);
    expect(chunks.filter((c) => c.type === 'item').length).toBeGreaterThan(3);

    // Chunks arrive while the Agent runs: before its node.finished event.
    const order = events.filter((e) => e.event === 'execution').map((e) => `${e.data.type}:${e.data.nodeId ?? ''}`);
    expect(order.indexOf('node.chunk:Agent')).toBeLessThan(order.indexOf('node.finished:Agent'));
    expect(order.lastIndexOf('node.chunk:Agent')).toBeLessThan(order.indexOf('node.finished:Agent'));

    // The record keeps the answer; chunks are not stored.
    const saved = store.getExecution(result.executionId)!;
    expect(saved.runData.Agent[0].outputs[0][0].json).toMatchObject({ output: ANSWER });
    expect(JSON.stringify(saved)).not.toContain('node.chunk');
  });

  it('pauses for a tool approval, then streams the rest once approved in the chat panel', async () => {
    const id = 'wf_stream_approval';
    store.saveWorkflow(chatWorkflow(id, { requireApproval: 'all' }));
    const first = await readSse(
      await runRoute.POST(
        new Request(`http://stream.test/api/workflows/${id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat: { message: 'What is 6*7?' } }) }),
        params({ id }),
      ),
    );
    const result = first.find((e) => e.event === 'result')!.data;
    expect(result.status).toBe('waiting');
    expect(result.approval).toMatchObject({ nodeName: 'Agent', channel: 'chat', calls: [{ id: 'call_1', tool: 'Calculator', input: { expression: '6*7' } }] });
    expect(chunksOf(first).filter((c) => c.type === 'tool')).toMatchObject([{ tool: { name: 'Calculator', status: 'approval' } }]);

    const executionId = result.executionId as string;
    const pending = await approvalsRoute.GET(new Request(`http://stream.test/api/executions/${executionId}/approvals`), params({ id: executionId }));
    expect((await pending.json()).approval.calls).toHaveLength(1);

    const decided = await readSse(
      await approvalsRoute.POST(
        new Request(`http://stream.test/api/executions/${executionId}/approvals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId: 'call_1', approved: true }) }),
        params({ id: executionId }),
      ),
    );
    expect(decided[0]).toMatchObject({ event: 'decision', data: { status: 'resumed' } });
    expect(decided.find((e) => e.event === 'result')!.data).toMatchObject({ executionId, status: 'success' });
    const chunks = chunksOf(decided);
    expect(chunks.filter((c) => c.type === 'tool').map((c) => c.tool!.status)).toEqual(['started', 'finished']);
    expect(chunks.filter((c) => c.type === 'item').map((c) => c.content).join('')).toBe(ANSWER);

    const record = store.getExecution(executionId)!;
    expect(record.status).toBe('success');
    expect(record.runData.Agent.at(-1)!.outputs[0][0].json).toMatchObject({ output: expect.stringContaining('42'), steps: [{ tool: 'Calculator', output: { result: 42 } }] });

    // Deciding twice is refused.
    const again = await approvalsRoute.POST(
      new Request(`http://stream.test/api/executions/${executionId}/approvals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId: 'call_1', approved: false }) }),
      params({ id: executionId }),
    );
    expect(again.status).toBe(409);
  });

  it('a rejected call does not run and the model is told so', async () => {
    const id = 'wf_stream_reject';
    store.saveWorkflow(chatWorkflow(id, { requireApproval: 'selected', approvalTools: 'Calculator' }));
    const first = await readSse(
      await runRoute.POST(
        new Request(`http://stream.test/api/workflows/${id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat: { message: 'What is 6*7?' } }) }),
        params({ id }),
      ),
    );
    const executionId = first.find((e) => e.event === 'result')!.data.executionId as string;
    const decided = await readSse(
      await approvalsRoute.POST(
        new Request(`http://stream.test/api/executions/${executionId}/approvals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId: 'call_1', approved: false }) }),
        params({ id: executionId }),
      ),
    );
    expect(decided.find((e) => e.event === 'result')!.data.status).toBe('success');
    expect(chunksOf(decided).find((c) => c.type === 'tool')).toMatchObject({ tool: { status: 'failed', output: expect.stringContaining('rejected') } });
    const steps = (store.getExecution(executionId)!.runData.Agent.at(-1)!.outputs[0][0].json as { steps: Array<{ output: string; isError?: boolean }> }).steps;
    expect(steps[0]).toMatchObject({ isError: true, output: expect.stringContaining('Not run: rejected') });
  });
});

describe('Webhook trigger “Streaming” response mode', () => {
  function hookWorkflow(id: string, path: string): Workflow {
    return {
      id,
      name: `Hook ${id}`,
      nodes: [node('Hook', 'core.webhook', { path, method: 'POST', respond: 'streaming' }), node('Agent', 'core.aiAgent', { prompt: '{{ $json.body.question }}' }), model()],
      connections: [edge('Hook', 'Agent'), edge('Model', 'Agent', 'ai_languageModel')],
    };
  }
  const call = (path: string, accept: string) =>
    webhookRoute.POST(
      new Request(`http://stream.test/api/webhook/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept }, body: JSON.stringify({ question: 'Are you streaming?' }) }),
      params({ path: [path] }),
    );

  it('answers NDJSON chunks then a done line with the last node’s output', async () => {
    store.saveWorkflow(hookWorkflow('wf_stream_hook', 'stream-hook'));
    await publishDraft('wf_stream_hook', 'tester', 'stream');
    const response = await call('stream-hook', 'application/json');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    const lines = (await response.text())
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; content?: string; metadata?: { nodeName: string }; output?: { output: string }; status?: string });
    expect(lines[0]).toMatchObject({ type: 'begin', metadata: { nodeName: 'Agent' } });
    const text = lines.filter((l) => l.type === 'item').map((l) => l.content).join('');
    expect(text).toBe('Echo: Are you streaming?');
    expect(lines.at(-1)).toMatchObject({ type: 'done', status: 'success', output: { output: 'Echo: Are you streaming?' } });
  });

  it('answers SSE when the client asks for text/event-stream', async () => {
    const response = await call('stream-hook', 'text/event-stream');
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const events = await readSse(response);
    expect(events.map((e) => e.data.type)).toContain('item');
    expect(events.at(-1)!.data).toMatchObject({ type: 'done', status: 'success' });
  });
});
