/**
 * Spotlight's states as pure functions (components/editor/spotlight/states.ts): the buttons of an error, the folded bar with a waiting change, the first-visit fold, the one-time explainer, and Apply and Undo.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { EXPLAINER_KEY, OPEN_CAPS_HREF, cardFolded, defaultCollapsed, errorActions, explainerDue, foldedBar, ghostFade, isNewestUndo, undoGroup } from '../src/components/editor/spotlight/states';
import { applyStreamEvent, carriedFrom, useAssistant, type AssistantTurn, type ChatItem } from '../src/components/editor/assistant';
import { ChatEmpty } from '../src/components/ui/chat';
import { SETTINGS_GROUPS } from '../src/components/settings/settings-groups';

const streamed = vi.hoisted(() => ({ body: undefined as Record<string, unknown> | undefined }));
vi.mock('@/lib/client/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/client/api')>()),
  streamEvents: async (_url: string, body: Record<string, unknown>, onEvent: (name: string, data: unknown) => void) => {
    streamed.body = body;
    onEvent('done', { type: 'done', model: 'm', durationMs: 1, steps: 1 });
  },
}));

const ids = (list: Array<{ id: string }>) => list.map((a) => a.id);

describe('errorActions', () => {
  const admin = { admin: true, canRetry: true };
  it('a model error after steps continues from the failing step, and can try again', () => {
    const list = errorActions({ message: 'boom', kind: 'model', step: 3, checkpoint: 'abc' }, admin);
    expect(ids(list)).toEqual(['continue', 'retry']);
    expect(list[0].label).toBe('Continue from step 3');
  });
  it('Continue needs a checkpoint and a step after the first', () => {
    expect(ids(errorActions({ message: 'boom', kind: 'model', step: 3 }, admin))).toEqual(['retry']);
    expect(ids(errorActions({ message: 'boom', kind: 'model', step: 1, checkpoint: 'abc' }, admin))).toEqual(['retry']);
    expect(ids(errorActions({ message: 'boom', kind: 'model', step: 3, checkpoint: 'abc' }, { admin: true, canRetry: false }))).toEqual([]);
  });
  it('a cap offers Open AI caps to admins only', () => {
    expect(ids(errorActions({ message: 'cap', kind: 'cap' }, admin))).toEqual(['open-caps']);
    expect(ids(errorActions({ message: 'cap', kind: 'cap' }, { admin: false, canRetry: true }))).toEqual([]);
  });
  it('Open AI caps lands on the AI caps section of Settings', () => {
    expect(OPEN_CAPS_HREF).toBe('/settings#ai-caps');
    const section = OPEN_CAPS_HREF.slice('/settings#'.length);
    expect(SETTINGS_GROUPS.flatMap((g) => g.sections)).toContain(section);
  });
  it('a failed node opens the node or asks Spotlight to fix it, prefilled', () => {
    const list = errorActions({ message: 'No credential', node: { id: 'n1', name: 'Post to Slack' } }, { admin: false, canRetry: false });
    expect(ids(list)).toEqual(['open-node', 'fix-node']);
    expect(list[1]).toMatchObject({ prefill: 'Fix Post to Slack: No credential' });
  });
  it('a stall tries again', () => {
    expect(ids(errorActions({ message: 'no progress', kind: 'stalled' }, admin))).toEqual(['retry']);
  });
  it('the stream keeps the kind and the step on the turn', () => {
    const turn: AssistantTurn = { id: 'r', role: 'assistant', parts: [], steps: [], text: '' };
    const failed = applyStreamEvent(turn, { type: 'error', message: 'x', kind: 'model', checkpoint: 'c1', step: 4 });
    expect(failed).toMatchObject({ errorKind: 'model', errorStep: 4, checkpoint: 'c1' });
  });
});

describe('the empty panel', () => {
  it('renders one line and no chips (the composer has the suggestions)', () => {
    const html = renderToStaticMarkup(createElement(ChatEmpty, { title: 'Describe a flow, or ask about this one' }));
    expect(html).toContain('Describe a flow, or ask about this one');
    expect((html.match(/<button/g) ?? []).length).toBe(0);
  });
});

describe('the folded bar', () => {
  it('shows the needs-you icon with Review and Apply when a change waits', () => {
    expect(foldedBar({ waiting: 1 })).toMatchObject({ needsYou: true, review: true, apply: true });
  });
  it('shows neither when nothing waits', () => {
    expect(foldedBar({ waiting: 0 })).toMatchObject({ needsYou: false, review: false, apply: false });
  });
});

describe('the first visit', () => {
  it('is folded on a desktop until the person chooses', () => {
    expect(defaultCollapsed(null)).toBe(true);
    expect(defaultCollapsed(undefined)).toBe(true);
    expect(defaultCollapsed('no')).toBe(false);
    expect(defaultCollapsed('yes')).toBe(true);
  });
  it('explains Asks first | Autonomous once', () => {
    const store = new Map<string, string>();
    const read = (k: string) => store.get(k) ?? null;
    expect(explainerDue(read)).toBe(true);
    store.set(EXPLAINER_KEY, 'yes');
    expect(explainerDue(read)).toBe(false);
  });
});

describe('Apply and Undo', () => {
  it('the ghosts fade out on Apply and come back on Undo, and do nothing otherwise', () => {
    expect(ghostFade('applied')).toBe('out');
    expect(ghostFade('undone')).toBe('back');
    expect(ghostFade('dismissed')).toBeUndefined();
    expect(ghostFade(undefined)).toBeUndefined();
  });
  it('the card folds into its row only while applied', () => {
    expect(cardFolded('applied')).toBe(true);
    expect(cardFolded('undone')).toBe(false);
    expect(cardFolded(undefined)).toBe(false);
  });
  it('proposals applied as one step share one undo, and only the newest step can be undone', () => {
    const one = () => undefined;
    const two = () => undefined;
    const undos = new Map<string, () => void>([['a', one], ['b', two], ['c', two]]);
    expect(undoGroup(undos, 'c')).toEqual(['b', 'c']);
    expect(undoGroup(undos, 'b')).toEqual(['b', 'c']);
    expect(undoGroup(undos, 'a')).toEqual(['a']);
    expect(undoGroup(undos, 'x')).toEqual([]);
    expect(isNewestUndo(undos, 'b')).toBe(true);
    expect(isNewestUndo(undos, 'c')).toBe(true);
    expect(isNewestUndo(undos, 'a')).toBe(false);
  });
});

describe('Continue from a failed reply', () => {
  const proposal = { id: 'p1', summary: 'Add Slack', ops: [], warnings: [], dropped: [] };
  const failed: ChatItem = {
    id: 'r1',
    role: 'assistant',
    parts: [{ kind: 'proposal', proposal }, { kind: 'text', text: 'draft' }, { kind: 'tool', tool: { name: 'x', label: 'X', ok: true } }],
    steps: [{ id: 'model1', label: 'Thinking', kind: 'model', status: 'failed' }],
    error: 'boom',
    checkpoint: 'c1',
  };
  it('keeps the proposals and tool calls, not the words', () => {
    expect(carriedFrom(failed).parts.map((p) => p.kind)).toEqual(['proposal', 'tool']);
    expect(carriedFrom(undefined).parts).toEqual([]);
  });
  it('keeps step ids unique when the resumed stream restarts at the failed step', () => {
    const carried = carriedFrom({ ...failed, steps: [{ id: 'model3', label: 'Thinking', kind: 'model', status: 'failed' }] });
    const turn = applyStreamEvent({ parts: carried.parts, steps: carried.steps } as AssistantTurn, { type: 'step.start', step: 3, label: 'Thinking' } as never, 1);
    const all = (turn.steps ?? []).map((s) => s.id);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(2);
  });
  it('the resumed reply still has the proposal, and does not send it back as pending', async () => {
    useAssistant.setState({ items: [], pending: false });
    await useAssistant.getState().send('add slack', { resume: { checkpoint: 'c1' }, carry: failed });
    const reply = useAssistant.getState().items.at(-1);
    expect(reply?.role === 'assistant' && reply.parts.some((p) => p.kind === 'proposal' && p.proposal.id === 'p1')).toBe(true);
    expect(reply?.role === 'assistant' && reply.error).toBeFalsy();
    expect(streamed.body?.pending).toBeUndefined();
    expect(streamed.body?.resume).toEqual({ checkpoint: 'c1' });
  });
});
