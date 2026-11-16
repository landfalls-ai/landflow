/** SB05: an Ollama tool-call parse error ends no reply: the step is asked once more, with the same request. */
import { trace } from '@opentelemetry/api';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { NodeOperationError } from '@landflow/sdk';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { isParseError, withParseRetry } from '@/lib/server/assistant/parse-retry';
import { runChat, type ChatEvent } from '@/lib/server/assistant/chat';

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

const flow = (): Workflow => ({ id: 'wf', name: 'W', nodes: [{ id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }], connections: [] });
const good: Partial<ModelTurn> = { toolCalls: [{ id: 'c', name: 'propose_changes', input: { summary: 'Add a step', ops: [{ op: 'addNode', ref: 'n', type: 'core.noOp', name: 'Done', after: 'Start' }] } }] };

function model(steps: Array<Partial<ModelTurn> | Error>) {
  const calls: unknown[] = [];
  const m: LanguageModel = {
    provider: 'ollama',
    model: 'scripted',
    async generate(input) {
      calls.push(input);
      const next = steps.shift();
      if (!next) return { text: 'Done.', toolCalls: [], stopReason: 'stop' };
      if (next instanceof Error) throw next;
      return { text: '', toolCalls: [], stopReason: 'stop', ...next };
    },
  };
  return { m, calls };
}

async function run(steps: Array<Partial<ModelTurn> | Error>, extra: { signal?: AbortSignal } = {}) {
  const { m, calls } = model(steps);
  const events: ChatEvent[] = [];
  let thrown: unknown;
  await runChat({ messages: [{ role: 'user', content: 'add a step' }], workflow: flow(), model: m, types, trace: true, onEvent: (e) => events.push(e), ...extra }).catch((e) => (thrown = e));
  return { events, calls, thrown };
}

describe('the chat retries a tool-call parse error once', () => {
  it('shows the card of the second try, with no error', async () => {
    // the adapter's real shape (nodes/models.ts): the message is short, Ollama's words are in the description
    const { events, calls } = await run([new NodeOperationError('Ollama error', { description: 'XML syntax error on line 1: unexpected EOF' }), good]);
    expect(events.filter((e) => e.type === 'proposal')).toHaveLength(1);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(calls.length).toBe(3); // the failed call, the retry, the closing turn
    expect((calls[0] as { messages: unknown[] }).messages).toEqual((calls[1] as { messages: unknown[] }).messages);
  });

  it('asks only once more', async () => {
    const { events } = await run([new Error('Ollama error 500: unexpected end of JSON'), new Error('Ollama error 500: unexpected end of JSON')]);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('does not retry an abort', async () => {
    const controller = new AbortController();
    controller.abort();
    const { calls } = await run([new Error('XML syntax error: aborted'), good], { signal: controller.signal });
    expect(calls).toHaveLength(1);
  });

  it('asks once for a 500 that says what it was (out of memory)', async () => {
    const { calls, events } = await run([new Error('Ollama error 500: out of memory'), good]);
    expect(calls).toHaveLength(1);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('does not retry a usage cap, even when its message matches the parse pattern', async () => {
    const cap = Object.assign(new Error('Your monthly AI usage cap is reached (XML syntax error)'), { name: 'UsageCapError' });
    expect(isParseError(cap)).toBe(true); // only isUsageCapError keeps it from being retried
    const { calls, events } = await run([cap, good]);
    expect(calls).toHaveLength(1);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('does not retry another error', async () => {
    const { calls } = await run([new Error('connection refused'), good]);
    expect(calls).toHaveLength(1);
  });
});

describe('the retry is recorded', () => {
  it('writes the message and the description, cut to 200, in the span event', async () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const spy = vi.spyOn(trace, 'getActiveSpan').mockReturnValue({ addEvent: (n: string, a: Record<string, unknown>) => events.push([n, a]) } as never);
    const steps: Array<Error | ModelTurn> = [new NodeOperationError('Ollama error', { description: `XML syntax error ${'x'.repeat(300)}` }), { text: 'ok', toolCalls: [], stopReason: 'stop' }];
    const wrapped = withParseRetry({ provider: 'ollama', model: 'm', async generate() { const n = steps.shift()!; if (n instanceof Error) throw n; return n; } });
    await wrapped.generate({ system: '', messages: [], tools: [] } as never);
    spy.mockRestore();
    const reason = String(events[0][1]['landflow.reason']);
    expect(events[0][0]).toBe('assistant.retry');
    expect(reason.startsWith('Ollama error XML syntax error')).toBe(true);
    expect(reason).toHaveLength(200);
  });
});
