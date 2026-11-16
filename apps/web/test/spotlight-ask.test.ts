/**
 * SB11: Spotlight asks when it is not clear. The chat offers `ask_user` (not in a test-and-fix session), a valid question
 * ends the reply with an `ask` event and no further model call, the editor keeps it as a part with chips, and a chip is
 * sent as a typed message. A change to one of several steps of a kind, with none named or selected, is sent back to ask.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Workflow } from '@landflow/engine';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { recoverToolCalls, runChat, TOOLS, type ChatEvent } from '@/lib/server/assistant/chat';
import { scriptedModel, call } from './spotlight-scenarios/scenario';
import { applyStreamEvent, useAssistant, type AssistantTurn } from '@/components/editor/assistant';
import { AskRow } from '@/components/editor/spotlight/reply';
import { askedLine, requestAcrossAsk } from '@/lib/shared/spotlight-wire';
import { useEditor } from '@/components/editor/store';

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

/** A trigger and two HTTP steps. */
const flow = (): Workflow => ({
  id: 'wf_ask',
  name: 'Two calls',
  nodes: [
    { id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'b', name: 'Open status incident', type: 'core.httpRequest', typeVersion: 1, position: [280, 0], parameters: { url: 'http://127.0.0.1:3412/status' } },
    { id: 'c', name: 'Read Linear bugs', type: 'core.httpRequest', typeVersion: 1, position: [560, 0], parameters: { url: 'http://127.0.0.1:3412/linear' } },
  ],
  connections: [
    { id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'b', targetIndex: 0 },
    { id: 'e2', type: 'main', source: 'b', sourceIndex: 0, target: 'c', targetIndex: 0 },
  ],
});

const CHOICES = ['Open status incident', 'Read Linear bugs'];
const retry = (node: string) => call('propose_changes', { summary: 'Set retry to 3 tries', ops: [{ op: 'setNodeSettings', node, settings: { retryOnFail: true, maxTries: 3 } }] });

async function chat(content: string, turns: Parameters<typeof scriptedModel>[0], extra: Partial<Parameters<typeof runChat>[0]> = {}) {
  const { model, calls } = scriptedModel(turns);
  const events: ChatEvent[] = [];
  await runChat({ messages: [{ role: 'user', content }], workflow: flow(), model, types, onEvent: (e) => events.push(e), ...extra });
  return { events, calls };
}
const toolNames = (calls: Array<{ tools?: Array<{ name: string }> }>) => calls[0].tools?.map((t) => t.name) ?? [];

describe('ask_user in the chat', () => {
  it('is in TOOLS, offered for a typed change and a question, not for a test session', async () => {
    expect(TOOLS.map((t) => t.name)).toContain('ask_user');
    for (const content of ['it should retry 3 times', 'why did it fail?']) {
      const { calls } = await chat(content, [{ text: 'ok' }]);
      expect(toolNames(calls)).toContain('ask_user');
    }
    for (const session of ['fix', 'review'] as const) {
      const { calls } = await chat('Fix “Open status incident”: it failed.', [{ text: 'Only you can fix that.' }, { text: 'Only you can fix that.' }], { session });
      expect(toolNames(calls)).not.toContain('ask_user');
    }
  });

  it('a valid question gives tool and ask events, then done, and no further model call', async () => {
    const { events, calls } = await chat('it should retry 3 times', [call('ask_user', { question: 'Which step?', choices: CHOICES }), { text: 'SECOND TURN MUST STAY UNUSED' }]);
    expect(calls).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(['tool', 'ask', 'text', 'done']);
    expect(events.find((e) => e.type === 'tool')).toMatchObject({ name: 'ask_user', ok: true });
    expect(events.find((e) => e.type === 'ask')).toMatchObject({ question: 'Which step?', choices: CHOICES });
    expect(events.find((e) => e.type === 'text')).toMatchObject({ text: 'Which step?' });
  });

  it.each([
    ['one choice', { question: 'Which?', choices: ['Only one'] }],
    ['five choices', { question: 'Which?', choices: ['a', 'b', 'c', 'd', 'e'] }],
    ['an empty question', { question: '  ', choices: CHOICES }],
  ])('%s: a tool error, and the second bad call ends the reply with the question as text', async (_name, bad) => {
    const { events, calls } = await chat('it should retry 3 times', [call('ask_user', bad), call('ask_user', bad), { text: 'UNUSED' }]);
    expect(events.some((e) => e.type === 'ask')).toBe(false);
    const tools = events.filter((e) => e.type === 'tool');
    expect(tools.map((t) => t.ok)).toEqual([false, true]); // the second is shown as the question in words
    expect((calls[1].messages.at(-1) as { results: Array<{ isError?: boolean }> }).results[0].isError).toBe(true);
    expect(calls).toHaveLength(2);
    if (bad.question.trim()) expect(events.findLast((e) => e.type === 'text')).toMatchObject({ text: 'Which?' });
    expect(events.at(-1)?.type).toBe('done');
  });

  it('ask_user and propose_changes in the same step: no proposal', async () => {
    const both = { text: '', toolCalls: [...retry('Open status incident').toolCalls!, ...call('ask_user', { question: 'Which step?', choices: CHOICES }).toolCalls!], stopReason: 'tool_use' as const };
    const { events, calls } = await chat('it should retry 3 times', [both, { text: 'UNUSED' }]);
    expect(events.some((e) => e.type === 'proposal')).toBe(false);
    expect(events.some((e) => e.type === 'ask')).toBe(true);
    expect(events.some((e) => e.type === 'tool' && e.name === 'propose_changes' && /Held the change/.test(e.label))).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('a text-form tool call is recovered', () => {
    const { calls } = recoverToolCalls('<function=ask_user><parameter=question>Which step?</parameter><parameter=choices>["A","B"]</parameter></function>');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'ask_user', input: { question: 'Which step?', choices: ['A', 'B'] } });
  });

  it('a test session that calls it anyway is told it is not offered', async () => {
    const { events, calls } = await chat('Fix it', [call('ask_user', { question: 'Which?', choices: CHOICES }), { text: 'Only you can fix that.' }, { text: 'Only you can fix that.' }], { session: 'fix' });
    expect(events.some((e) => e.type === 'ask')).toBe(false);
    expect(calls.length).toBeGreaterThan(1);
  });
});

describe('the backstop: several steps fit', () => {
  it('"it should retry 3 times" with nothing selected: a proposal on one of two HTTP steps is sent back', async () => {
    const { events, calls } = await chat('it should retry 3 times', [retry('Open status incident'), call('ask_user', { question: 'Which step?', choices: CHOICES }), { text: 'UNUSED' }]);
    expect((calls[1].messages.at(-1) as { results: Array<{ content: string }> }).results[0].content).toContain('Several steps fit');
    expect(events.some((e) => e.type === 'proposal')).toBe(false);
    expect(events.some((e) => e.type === 'ask')).toBe(true);
  });

  it('is sent back once: the same proposal after the send-back goes through', async () => {
    const { events } = await chat('it should retry 3 times', [retry('Open status incident'), retry('Open status incident'), { text: 'Done.' }]);
    expect(events.filter((e) => e.type === 'proposal')).toHaveLength(1);
  });

  it('with the step selected, or named, or "all", it is not sent back', async () => {
    for (const [content, extra] of [['it should retry 3 times', { selectedNodeId: 'b' }], ['make Open status incident retry 3 times', {}], ['make all the HTTP steps retry 3 times', {}]] as const) {
      const { events, calls } = await chat(content, [retry('Open status incident'), { text: 'Done.' }], extra);
      expect(events.filter((e) => e.type === 'proposal')).toHaveLength(1);
      expect(calls).toHaveLength(2);
    }
  });

  it('a change to every one of them, with none asked for by "all", is sent back too', async () => {
    const both = { text: '', toolCalls: [...retry('Open status incident').toolCalls!, ...retry('Read Linear bugs').toolCalls!], stopReason: 'tool_use' as const };
    const { events, calls } = await chat('it should retry 3 times', [both, call('ask_user', { question: 'Which step?', choices: CHOICES }), { text: 'UNUSED' }]);
    expect(events.some((e) => e.type === 'ask')).toBe(true);
    expect(events.some((e) => e.type === 'proposal')).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('a settings change on a step this reply just added is not sent back', async () => {
    const add = call('propose_changes', { summary: 'Add a call', ops: [{ op: 'addNode', type: 'core.httpRequest', name: 'Fetch bugs', after: 'Read Linear bugs', parameters: { url: 'http://127.0.0.1:3412/bugs' } }] });
    const settings = call('propose_changes', { summary: 'Retry 3 times', ops: [{ op: 'setNodeSettings', node: 'Fetch bugs', settings: { retryOnFail: true, maxTries: 3 } }] });
    const { events, calls } = await chat('add a call to http://127.0.0.1:3412/bugs that retries 3 times', [add, settings, { text: 'Done.' }]);
    expect(events.filter((e) => e.type === 'proposal')).toHaveLength(2);
    expect(calls).toHaveLength(3);
  });

  it('a Slack message with a channel nobody gave is sent back once to ask', async () => {
    const slack = call('propose_changes', { summary: 'Post to Slack', ops: [{ op: 'addNode', type: 'core.httpRequest', name: 'Post update', after: 'Read Linear bugs', parameters: { channel: '#general', url: 'http://127.0.0.1:3412/status' } }] });
    const { events, calls } = await chat('post the result to slack', [slack, call('ask_user', { question: 'Which channel?', choices: ['#ops', '#dev'] }), { text: 'UNUSED' }]);
    expect(events.some((e) => e.type === 'proposal')).toBe(false);
    expect(events.some((e) => e.type === 'ask')).toBe(true);
    expect((calls[1].messages.at(-1) as { results: Array<{ content: string }> }).results[0].content).toContain('nobody gave');
  });

  it('a URL host nobody gave is not sent back: the card shows with the URL listed as cleared', async () => {
    const weather = call('propose_changes', { summary: 'Get the weather', ops: [{ op: 'addNode', type: 'core.httpRequest', name: 'Get weather', after: 'Read Linear bugs', parameters: { url: 'https://api.weather-example.com/paris' } }] });
    const { events, calls } = await chat('add a step that gets the weather for Paris', [weather, { text: 'Done.' }]);
    expect(events.filter((e) => e.type === 'proposal')).toHaveLength(1);
    expect(events.some((e) => e.type === 'ask')).toBe(false);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(events.filter((e) => e.type === 'proposal'))).toContain('nobody gave');
  });

  it('a test session is never sent back', async () => {
    const { events } = await chat('Fix “Open status incident”: it failed with 401.', [retry('Open status incident'), { text: 'Done.' }], { session: 'fix', selectedNodeId: 'b' });
    expect(events.filter((e) => e.type === 'proposal')).toHaveLength(1);
  });
});

describe('the editor', () => {
  const fresh = (): AssistantTurn => ({ id: 'r1', role: 'assistant', parts: [], steps: [], text: '', thinking: [] });

  it('applyStreamEvent adds an ask part', () => {
    const turn = applyStreamEvent(fresh(), { type: 'ask', question: 'Which step?', choices: CHOICES, step: 1 });
    expect(turn.parts).toEqual([{ kind: 'ask', ask: { question: 'Which step?', choices: CHOICES } }]);
  });

  it('AskRow shows the question, the chips and the hint; once answered the hint is gone', () => {
    const html = renderToStaticMarkup(createElement(AskRow, { itemId: 'r1', ask: { question: 'Which step?', choices: CHOICES } }));
    expect(html).toContain('Which step?');
    expect(html).toContain('Open status incident');
    expect(html).toContain('Read Linear bugs');
    expect(html).toContain('or type your own answer');
    const answered = renderToStaticMarkup(createElement(AskRow, { itemId: 'r1', ask: { question: 'Which step?', choices: CHOICES, answered: 'Read Linear bugs' } }));
    expect(answered).not.toContain('or type your own answer');
    expect(answered).toContain('aria-pressed="true"');
  });

  it('picking a chip marks it and sends the choice as a typed message (no session, not auto)', async () => {
    const send = vi.fn(async () => {});
    useAssistant.setState({ pending: false, send, items: [{ id: 'r1', role: 'assistant', parts: [{ kind: 'ask', ask: { question: 'Which step?', choices: CHOICES } }] }] });
    await useAssistant.getState().answerAsk('r1', 'Read Linear bugs');
    expect(send).toHaveBeenCalledWith('Read Linear bugs', {});
    const part = (useAssistant.getState().items[0] as AssistantTurn).parts[0];
    expect(part).toMatchObject({ kind: 'ask', ask: { answered: 'Read Linear bugs' } });
  });

  it('a chip that names a step on the canvas sends that step as the scope (SB07 × SB11)', async () => {
    const send = vi.fn(async () => {});
    const before = useEditor.getState().nodes;
    useEditor.setState({ nodes: [{ id: 'n7', data: { wf: { id: 'n7', name: 'Open status incident' } } }] as never });
    try {
      useAssistant.setState({ pending: false, send, items: [{ id: 'r1', role: 'assistant', parts: [{ kind: 'ask', ask: { question: 'Which step?', choices: CHOICES } }] }] });
      await useAssistant.getState().answerAsk('r1', 'Open status incident');
      expect(send).toHaveBeenCalledWith('Open status incident', { scope: { kind: 'only', nodes: ['n7'] } });
    } finally {
      useEditor.setState({ nodes: before });
    }
  });
});

describe('the request across a question (SB09 × SB11)', () => {
  const asked = (question: string, choices: string[]) => ({ role: 'assistant' as const, content: `${question}\n${askedLine(choices)}` });
  it('is the latest message alone when the reply before it did not ask', () => {
    expect(requestAcrossAsk([{ role: 'user', content: 'run it on Mondays at 9' }])).toBe('run it on Mondays at 9');
    expect(requestAcrossAsk([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'Which one?' }, { role: 'user', content: 'Morning' }])).toBe('Morning');
    expect(requestAcrossAsk([])).toBe('');
  });
  it('joins the request and the answer, through several questions in a row', () => {
    const one = [{ role: 'user' as const, content: 'run it on Mondays at 9' }, asked('Which schedule?', ['Morning', 'Weekdays at 8']), { role: 'user' as const, content: 'Morning' }];
    expect(requestAcrossAsk(one)).toBe('run it on Mondays at 9\nMorning');
    expect(requestAcrossAsk([{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'Done.' }, ...one, asked('Which time zone?', ['UTC', 'Local']), { role: 'user', content: 'UTC' }])).toBe('run it on Mondays at 9\nMorning\nUTC');
  });
});
