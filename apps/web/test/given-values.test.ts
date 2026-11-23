/**
 * SB03: a test-and-fix session's fix never removes a step the person asked for or changes a URL, channel, address or id
 * they gave. `givenValuesKept` is the server's half (the chat route's guard); the session has the same check in the client.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import type { NodeTypeInfo } from '@/lib/shared/types';
import type { GenerateInput } from '@/lib/server/nodes/models';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { givenValuesKept, runChat, type ChatEvent } from '@/lib/server/assistant/chat';

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

const flow = (): Workflow => ({
  id: 'wf_given',
  name: 'Orders',
  nodes: [
    { id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'b', name: 'Notify VIP', type: 'core.httpRequest', typeVersion: 1, position: [280, 0], parameters: { method: 'POST', url: 'http://127.0.0.1:3399/vip' } },
    { id: 'c', name: 'Notify Standard', type: 'core.httpRequest', typeVersion: 1, position: [560, 0], parameters: { method: 'POST', url: 'http://127.0.0.1:3399/standard' } },
  ],
  connections: [
    { id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'b', targetIndex: 0 },
    { id: 'e2', type: 'main', source: 'b', sourceIndex: 0, target: 'c', targetIndex: 0 },
  ],
});
const goal = 'POST big orders to http://127.0.0.1:3399/vip (Notify VIP) and the rest to http://127.0.0.1:3399/standard';

describe('givenValuesKept', () => {
  it('keeps the httpbin swap: a URL the messages hold, changed', () => {
    const reason = givenValuesKept([{ op: 'setParameters', node: 'Notify VIP', parameters: { url: 'https://httpbin.org/post' } }], flow(), goal);
    expect(reason).toContain('url');
    expect(reason).toContain('http://127.0.0.1:3399/vip');
  });

  it('keeps removing a step the request names', () => {
    expect(givenValuesKept([{ op: 'removeNode', node: 'Notify VIP' }], flow(), goal)).toContain('“Notify VIP”');
  });

  it('lets a change to a value nobody gave through, and an unchanged one', () => {
    expect(givenValuesKept([{ op: 'setParameters', node: 'Notify VIP', parameters: { url: 'https://httpbin.org/post' } }], flow(), 'Tell the desk about big orders')).toBeUndefined();
    expect(givenValuesKept([{ op: 'setParameters', node: 'Notify VIP', parameters: { method: 'PUT' } }], flow(), goal)).toBeUndefined();
    expect(givenValuesKept([{ op: 'setParameters', node: 'Notify VIP', parameters: { url: 'http://127.0.0.1:3399/vip' } }], flow(), goal)).toBeUndefined();
    expect(givenValuesKept([{ op: 'removeNode', node: 'Start' }], flow(), 'Tell the desk about big orders')).toBeUndefined();
  });
});

describe('given-value edge cases', () => {
  it('keeps turning off a step the request names', () => {
    expect(givenValuesKept([{ op: 'setNodeSettings', node: 'Notify VIP', settings: { disabled: true } }], flow(), goal)).toContain('turn off “Notify VIP”');
    expect(givenValuesKept([{ op: 'setNodeSettings', node: 'Notify VIP', settings: { retryOnFail: true } }], flow(), goal)).toBeUndefined();
  });

  it('a plain word is not a given value', () => {
    const wf = flow();
    wf.nodes[1].parameters = { resource: 'messages' };
    expect(givenValuesKept([{ op: 'setParameters', node: 'Notify VIP', parameters: { resource: 'channels' } }], wf, 'send messages to the desk')).toBeUndefined();
  });

  it('a URL stored with a leading = is kept too', () => {
    const wf = flow();
    wf.nodes[1].parameters = { url: '=http://127.0.0.1:3399/vip' };
    expect(givenValuesKept([{ op: 'setParameters', node: 'Notify VIP', parameters: { url: 'http://127.0.0.1:3399/other' } }], wf, goal)).toContain('url');
  });
});

describe('the chat route in an auto session', () => {
  const run = async (ops: unknown[], message = 'change Notify VIP as I say') => {
    const turns: Array<Partial<ModelTurn>> = [{ toolCalls: [{ id: 'c1', name: 'propose_changes', input: { summary: 'Change', ops } }] }, { text: 'Done.' }, { text: 'Done.' }];
    const model: LanguageModel = {
      provider: 'test',
      model: 'scripted',
      async generate() {
        const next = turns.shift();
        if (!next) throw new Error('No scripted turn left');
        return { text: '', toolCalls: [], stopReason: 'stop', ...next };
      },
    };
    const events: ChatEvent[] = [];
    const wf = { ...flow(), description: goal } as Workflow;
    await runChat({ messages: [{ role: 'user', content: message }], workflow: wf, model, types, session: 'auto', onEvent: (e) => events.push(e) });
    return events.filter((e) => e.type === 'proposal');
  };

  it('shows an asked-for URL change', async () => {
    expect(await run([{ op: 'setParameters', node: 'Notify VIP', parameters: { url: 'http://127.0.0.1:3399/vip2' } }])).toHaveLength(1);
  });

  it('shows an asked-for removal', async () => {
    expect(await run([{ op: 'removeNode', node: 'Notify Standard' }], 'remove Notify Standard')).toHaveLength(1);
  });
});

describe('the chat route in a fix session', () => {
  it('does not show the swap, and tells the model why', async () => {
    const calls: GenerateInput[] = [];
    const turns: Array<Partial<ModelTurn>> = [
      { toolCalls: [{ id: 'c1', name: 'propose_changes', input: { summary: 'Use httpbin', ops: [{ op: 'setParameters', node: 'Notify VIP', parameters: { url: 'https://httpbin.org/post' } }] } }] },
      { text: 'Only you can change the address you gave; I changed nothing.' },
      { text: 'Only you can change the address you gave; I changed nothing.' },
    ];
    const model: LanguageModel = {
      provider: 'test',
      model: 'scripted',
      async generate(input) {
        calls.push({ ...input, messages: [...input.messages] });
        const next = turns.shift();
        if (!next) throw new Error('No scripted turn left');
        return { text: '', toolCalls: [], stopReason: 'stop', ...next };
      },
    };
    const events: ChatEvent[] = [];
    await runChat({
      messages: [{ role: 'user', content: `Test run 1 failed at “Notify VIP”: HTTP 500. I asked for: “${goal}”. Fix it.` }],
      workflow: flow(),
      model,
      types,
      session: 'fix',
      onEvent: (e) => events.push(e),
    });
    expect(events.filter((e) => e.type === 'proposal')).toEqual([]);
    expect(JSON.stringify(calls[1].messages.at(-1))).toContain('Only the person can change that');
    expect(calls[0].system).toContain('Never change a URL, channel, address or id the person gave');
  });
});
