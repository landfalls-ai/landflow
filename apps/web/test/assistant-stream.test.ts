/**
 * The assistant's stream (docs/assistant.md#the-stream): step.start, text.delta, thinking and text, timed tool events,
 * checkpoints after an error and `resume`, for Spotlight and the Agent architect. Models are scripted fakes that stream tokens.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import type { NodeTypeInfo } from '@/lib/shared/types';
import type { GenerateInput } from '@/lib/server/nodes/models';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-assistant-stream-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { corePlugin } = await import('@/lib/server/nodes');
const { registry } = await import('@/lib/server/plugins/registry');
const { runChat } = await import('@/lib/server/assistant/chat');
const { runArchitect } = await import('@/lib/server/assistant/architect');
const { saveCheckpoint, takeCheckpoint, CheckpointExpiredError, MAX_CHECKPOINTS, CHECKPOINT_TTL_MS } = await import('@/lib/server/assistant/checkpoints');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const chatRoute = await import('@/app/api/assistant/chat/route');
const agentRoute = await import('@/app/api/assistant/agent/route');
import type { ChatEvent, ChatState } from '@/lib/server/assistant/chat';

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

const workflow = (): Workflow => ({
  id: 'wf_stream',
  name: 'Stream',
  nodes: [
    { id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'b', name: 'Code', type: 'core.code', typeVersion: 1, position: [280, 0], parameters: { mode: 'each', codeEach: 'return $json;' } },
  ],
  connections: [{ id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'b', targetIndex: 0 }],
});

type Script = Array<{ tokens?: string[]; error?: Error } & Partial<ModelTurn>>;

/** A model that streams each scripted turn's tokens through onToken, then answers; an `error` turn throws. */
function streaming(script: Script) {
  const calls: GenerateInput[] = [];
  const model: LanguageModel = {
    provider: 'test',
    model: 'streaming',
    async generate(input) {
      calls.push({ ...input, messages: [...input.messages] });
      const next = script.shift();
      if (!next) throw new Error('No scripted turn left');
      if (next.error) throw next.error;
      for (const token of next.tokens ?? []) input.onToken?.(token);
      const { tokens, error: _error, ...turn } = next;
      return { text: tokens?.join('') ?? '', toolCalls: [], stopReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 }, ...turn };
    },
  };
  return { model, calls };
}

const search = (id: string, query: string) => ({ id, name: 'search_nodes', input: { query } });

async function chat(model: LanguageModel, extra: Partial<Parameters<typeof runChat>[0]> = {}) {
  const events: ChatEvent[] = [];
  await runChat({ messages: [{ role: 'user', content: 'How do I dedupe items?' }], workflow: workflow(), model, types, trace: true, userId: TEST_OWNER.id, onEvent: (e) => events.push(e), ...extra });
  return events;
}

describe('the chat stream', () => {
  it('sends the step, its tokens, the timed tool, and the guarded final text', async () => {
    const { model } = streaming([
      { tokens: ['Let me ', 'search.'], toolCalls: [search('c1', 'remove duplicates')] },
      { tokens: ['Use ', 'Remove Duplicates.'] },
    ]);
    const events = await chat(model);
    // The first token goes out at once, the rest in a batch: at most one delta per 50 ms.
    expect(events.map((e) => e.type)).toEqual(['step.start', 'text.delta', 'text.delta', 'thinking', 'tool', 'step.start', 'text.delta', 'text.delta', 'text', 'done']);
    expect(events[0]).toEqual({ type: 'step.start', step: 1, label: 'Reading your request' });
    // Tokens come in batches, never lost: the deltas of a step add up to what the model streamed.
    expect(events.filter((e) => e.type === 'text.delta' && e.step === 1).map((e) => (e as { text: string }).text).join('')).toBe('Let me search.');
    expect(events[3]).toMatchObject({ type: 'thinking', step: 1, text: 'Let me search.' });
    const tool = events[4] as Extract<ChatEvent, { type: 'tool' }>;
    expect(tool).toMatchObject({ name: 'search_nodes', step: 1, ok: true, detail: expect.stringContaining('remove duplicates') });
    expect(tool.id).toMatch(/^t_/);
    expect(tool.durationMs).toBeGreaterThanOrEqual(0);
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'Use Remove Duplicates.', step: 2 }]);
    expect(events.at(-1)).toMatchObject({ type: 'done', steps: 2, local: false, usage: { inputTokens: 20, outputTokens: 10 } });
  });

  it('cuts narration from the final text only: the deltas are provisional', async () => {
    const said = 'Let me check the node. Remove Duplicates drops repeated items.';
    const { model } = streaming([{ tokens: [said] }]);
    const events = await chat(model);
    expect(events.filter((e) => e.type === 'text.delta').map((e) => (e as { text: string }).text).join('')).toBe(said);
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'Remove Duplicates drops repeated items.', step: 1 }]);
  });

  it('never leaves a reply of deltas alone: the last step always ends with a text event', async () => {
    const { model } = streaming([{ tokens: ['<think>hmm</think>'] }]);
    const events = await chat(model);
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: '', step: 1 }]);
  });

  it('keeps the older events without trace', async () => {
    const { model } = streaming([{ tokens: ['Looking at it.'], toolCalls: [search('c1', 'sort')] }, { tokens: ['Sorted.'] }]);
    const events = await chat(model, { trace: false });
    expect(events.map((e) => e.type)).toEqual(['text', 'tool', 'text', 'done']);
  });

  it('gives a checkpoint when the model fails after two tool steps, and resume goes on at step 3 without running the tools again', async () => {
    const first = streaming([{ toolCalls: [search('c1', 'sort')] }, { toolCalls: [search('c2', 'merge')] }, { error: new Error('Ollama error 500: out of memory') }]);
    const events = await chat(first.model);
    const failure = events.at(-1) as Extract<ChatEvent, { type: 'error' }>;
    expect(failure).toMatchObject({ type: 'error', kind: 'model', step: 3, message: expect.stringContaining('out of memory') });
    expect(failure.checkpoint).toMatch(/^ck_/);
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(events.filter((e) => e.type === 'tool')).toHaveLength(2);

    const state = takeCheckpoint<ChatState>(TEST_OWNER.id, failure.checkpoint!);
    const second = streaming([{ tokens: ['Use Sort.'] }]);
    const resumed = await chat(second.model, { resume: state });
    expect(resumed.filter((e) => e.type === 'tool')).toHaveLength(0);
    expect(resumed[0]).toMatchObject({ type: 'step.start', step: 3 });
    expect(resumed.at(-1)).toMatchObject({ type: 'done', steps: 3 });
    // The model sees both earlier tool results, and the checkpoint is used up.
    expect(second.calls[0]!.messages.filter((m) => m.role === 'tool')).toHaveLength(2);
    expect(() => takeCheckpoint(TEST_OWNER.id, failure.checkpoint!)).toThrow(CheckpointExpiredError);
  });

  it('gives no checkpoint when nothing ran yet', async () => {
    const { model } = streaming([{ error: new Error('boom') }]);
    const events = await chat(model);
    expect(events.at(-1)).toEqual({ type: 'error', kind: 'model', message: 'boom' });
  });

  it('ends a reply that only repeats as a stalled error with a checkpoint', async () => {
    const { model } = streaming(Array.from({ length: 5 }, (_, i) => ({ toolCalls: [{ id: `c${i}`, name: 'get_workflow', input: {} }] })));
    const events = await chat(model);
    expect(events.at(-1)).toMatchObject({ type: 'error', kind: 'stalled', checkpoint: expect.stringMatching(/^ck_/), step: 3 });
  });
});

describe('checkpoints', () => {
  it('belong to their user, expire after 15 minutes and keep at most 200', () => {
    const id = saveCheckpoint('usr_a', { n: 1 });
    expect(() => takeCheckpoint('usr_b', id)).toThrow(CheckpointExpiredError);
    expect(takeCheckpoint('usr_a', id)).toEqual({ n: 1 });
    const old = saveCheckpoint('usr_a', {}, Date.now() - CHECKPOINT_TTL_MS - 1);
    expect(() => takeCheckpoint('usr_a', old)).toThrow(CheckpointExpiredError);
    const first = saveCheckpoint('usr_c', { first: true });
    for (let i = 0; i < MAX_CHECKPOINTS; i++) saveCheckpoint('usr_c', { i });
    expect(() => takeCheckpoint('usr_c', first)).toThrow(CheckpointExpiredError);
  });

  const post = (route: { POST: (request: Request) => Promise<Response> }, path: string, body: unknown) => route.POST(new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const message = [{ role: 'user', content: 'Hi' }];

  it('answers 409 checkpoint_expired for an unknown or another user’s checkpoint, in both routes', async () => {
    const foreign = saveCheckpoint('usr_someone_else', { history: [], steps: 1 });
    for (const checkpoint of ['ck_unknown', foreign]) {
      const response = await post(chatRoute, '/api/assistant/chat', { messages: message, workflow: { name: 'W', nodes: [], connections: [] }, resume: { checkpoint } });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'checkpoint_expired' });
      const agent = await post(agentRoute, '/api/assistant/agent', { messages: message, resume: { checkpoint } });
      expect(agent.status).toBe(409);
    }
    expect((await post(chatRoute, '/api/assistant/chat', { messages: message, workflow: { name: 'W', nodes: [], connections: [] }, resume: { checkpoint: 'x'.repeat(65) } })).status).toBe(400);
  });
});

describe('the architect stream', () => {
  const run = async (model: LanguageModel, extra: Partial<Parameters<typeof runArchitect>[0]> = {}) => {
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    await runArchitect({ messages: [{ role: 'user', content: 'An agent that sorts mail' }], model, types, actor: TEST_OWNER, trace: true, onEvent: (e) => events.push(e), ...extra });
    return events;
  };

  it('has step.start, timed tools and a done with cost fields', async () => {
    const { model } = streaming([{ toolCalls: [search('c1', 'send email')] }, { tokens: ['Here is the plan.'] }]);
    const events = await run(model);
    expect(events.map((e) => e.type)).toEqual(['step.start', 'tool', 'step.start', 'text', 'done']);
    expect(events[1]).toMatchObject({ name: 'search_nodes', step: 1, ok: true, durationMs: expect.any(Number), detail: expect.stringContaining('send email') });
    expect(events.at(-1)).toMatchObject({ steps: 2, local: false });
  });

  it('gives a checkpoint after an error and continues from it with resume', async () => {
    const first = streaming([{ toolCalls: [search('c1', 'send email')] }, { toolCalls: [search('c2', 'slack')] }, { error: new Error('Ollama error 500: no memory') }]);
    const events = await run(first.model);
    const failure = events.at(-1)!;
    expect(failure).toMatchObject({ type: 'error', kind: 'model', step: 3, checkpoint: expect.stringMatching(/^ck_/) });
    const state = takeCheckpoint<Parameters<typeof runArchitect>[0]['resume'] & object>(TEST_OWNER.id, failure.checkpoint as string);
    const second = streaming([{ tokens: ['Done.'] }]);
    const resumed = await run(second.model, { resume: state });
    expect(resumed.map((e) => e.type)).toEqual(['step.start', 'text', 'done']);
    expect(resumed[0]).toMatchObject({ step: 3 });
    expect(second.calls[0]!.messages.filter((m) => m.role === 'tool')).toHaveLength(2);
  });
});
