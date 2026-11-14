/**
 * Spotlight's states as pure functions (components/editor/spotlight/states.ts): the buttons of an error, the starters of
 * an empty panel, the folded bar with a waiting change, the first-visit fold, the one-time explainer, and Apply and Undo
 * as a sequence.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EXPLAINER_KEY, MOTION_START, defaultCollapsed, errorActions, explainerDue, foldedBar, motionStep, starters } from '../src/components/editor/spotlight/states';
import { applyStreamEvent, type AssistantTurn } from '../src/components/editor/assistant';
import { ChatEmpty } from '../src/components/ui/chat';

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

describe('starters and the empty panel', () => {
  it('an empty canvas gets examples of flows to build', () => {
    const list = starters({ nodes: 0 });
    expect(list).toHaveLength(3);
    for (const s of list) expect(s).toMatch(/^Build a flow that/);
  });
  it('a canvas with nodes gets things to do with it', () => {
    expect(starters({ nodes: 4 })).toEqual(['Explain this flow', 'Add error handling', 'Test it']);
  });
  it('renders one line and three chips', () => {
    const html = renderToStaticMarkup(createElement(ChatEmpty, { title: 'Describe a flow, or ask about this one', starters: starters({ nodes: 2 }), onStarter: () => undefined }));
    expect(html).toContain('Describe a flow, or ask about this one');
    expect((html.match(/<button/g) ?? []).length).toBe(3);
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
  it('folds the card while the ghosts fade, then settles', () => {
    let m = MOTION_START;
    expect(m).toEqual({ card: 'open', ghosts: 'ghost' });
    m = motionStep(m, 'apply');
    expect(m).toEqual({ card: 'collapsing', ghosts: 'fading' });
    m = motionStep(m, 'settled');
    expect(m).toEqual({ card: 'row', ghosts: 'real' });
  });
  it('plays backwards on Undo', () => {
    let m = motionStep(motionStep(MOTION_START, 'apply'), 'settled');
    m = motionStep(m, 'undo');
    expect(m).toEqual({ card: 'expanding', ghosts: 'returning' });
    m = motionStep(m, 'settled');
    expect(m).toEqual(MOTION_START);
  });
  it('ignores events that do not fit', () => {
    expect(motionStep(MOTION_START, 'undo')).toEqual(MOTION_START);
    expect(motionStep(MOTION_START, 'settled')).toEqual(MOTION_START);
    const mid = motionStep(MOTION_START, 'apply');
    expect(motionStep(mid, 'apply')).toEqual(mid);
  });
});
