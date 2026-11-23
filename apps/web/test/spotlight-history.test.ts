/**
 * Spotlight's kept conversation (docs/assistant.md#conversation-history), the pure parts: turns become stored parts (never
 * the tags' resolved text or a tool result), a stored conversation comes back under "Earlier" in order, a proposal that no
 * longer fits the workflow is marked, a later state of a proposal is a marker, and with keeping off nothing is stored.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { Workflow } from '@landflow/engine';
import type { AssistantOp, DescriptorLookup } from '@/lib/shared/assistant-ops';
import type { ConversationItem } from '@/lib/shared/conversations';
import type { AssistantTurn, ChatItem } from '@/components/editor/assistant';
import { dividerBefore, emptyStored, keptState, markStale, planKeeping, recordPlan, replyInput, restore, shouldResume, stillFits, userInput, withEarlier } from '@/components/editor/spotlight-history';
import { builtReply } from '@/components/editor/building';
import { ProposalCard } from '@/components/editor/spotlight/proposal';

const lookup: DescriptorLookup = () => ({ displayName: 'Code', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] }) as never;

const workflow = (names: string[] = ['Start', 'Code']): Workflow => ({
  id: 'wf_hist',
  name: 'History',
  nodes: names.map((name, i) => ({ id: `n${i}`, name, type: 'core.code', typeVersion: 1, position: [i * 280, 0] as [number, number], parameters: {} })),
  connections: [],
});

const rename: AssistantOp = { op: 'renameNode', node: 'Code', name: 'Format' };

const user = (id: string, text: string, extra: Partial<Extract<ChatItem, { role: 'user' }>> = {}): ChatItem => ({ id, role: 'user', text, ...extra });
const reply = (id: string, extra: Partial<AssistantTurn> = {}): AssistantTurn => ({
  id,
  role: 'assistant',
  parts: [{ kind: 'text', text: 'Renamed it.' }, { kind: 'proposal', proposal: { id: 'pr_1', summary: 'Rename Code', ops: [rename], dropped: [], warnings: [] } }],
  steps: [{ id: 'model1', label: 'Reading your request', kind: 'model', status: 'ok', durationMs: 900 }, { id: 'tool1', label: 'Read @Invoice sync', kind: 'read', status: 'ok', detail: 'RESOLVED DIGEST OF THE WORKFLOW' }],
  text: 'Renamed it.',
  thinking: ['secret chain of thought'],
  meta: { model: 'test/model', durationMs: 1500, steps: 2, inputTokens: 10, outputTokens: 5 },
  ...extra,
});

describe('turns as stored parts', () => {
  it('stores the user text and the tags, by name', () => {
    const item = userInput(user('u1', 'What is @Invoice sync?', { mentions: [{ type: 'workflow', id: 'wf_1', name: 'Invoice sync' }] }) as Extract<ChatItem, { role: 'user' }>);
    expect(item).toEqual({ role: 'user', parts: [{ type: 'text', text: 'What is @Invoice sync?' }, { type: 'mentions', refs: [{ type: 'workflow', id: 'wf_1', name: 'Invoice sync' }] }] });
  });

  it('stores the reply’s steps, words and proposal, and never a resolved block, a thought or a step’s detail', () => {
    const item = replyInput(reply('a1'))!;
    expect(item.parts.map((p) => p.type)).toEqual(['text', 'steps', 'proposal']);
    expect(item.parts[2]).toMatchObject({ type: 'proposal', id: 'pr_1', state: 'pending', ops: [rename] });
    const json = JSON.stringify(item);
    expect(json).not.toContain('RESOLVED DIGEST');
    expect(json).not.toContain('secret chain of thought');
    expect(json).not.toContain('tagged-resources');
    expect(item.meta).toMatchObject({ model: 'test/model', durationMs: 1500, steps: 2 });
  });

  it('keeps an item under 32 KB by leaving out the steps, then the proposal’s ops', () => {
    const big = reply('a2', { text: 'x'.repeat(100), parts: [{ kind: 'proposal', proposal: { id: 'pr_big', summary: 's', ops: Array.from({ length: 500 }, (_, i) => ({ op: 'renameNode', node: `Node ${i}`, name: 'y'.repeat(100) }) as AssistantOp), dropped: [], warnings: [] } }] });
    const item = replyInput(big)!;
    expect(new TextEncoder().encode(JSON.stringify(item)).length).toBeLessThanOrEqual(32 * 1024);
    expect(item.parts.find((p) => p.type === 'proposal')).toMatchObject({ state: 'stale', ops: [] });
  });

  it('keeps nothing of a reply that said nothing', () => {
    expect(replyInput(reply('a3', { text: '', parts: [], steps: [], meta: undefined, thinking: [] }))).toBeUndefined();
  });

  it('maps undone to dismissed', () => {
    expect([undefined, 'applied', 'dismissed', 'undone', 'stale'].map((s) => keptState(s as never))).toEqual(['pending', 'applied', 'dismissed', 'dismissed', 'stale']);
  });
});

describe('planning what to store', () => {
  it('stores a user turn at once and the reply once it has finished, then a proposal’s later state as a marker', () => {
    const stored = emptyStored();
    const streaming = [user('u1', 'Rename Code'), reply('a1')];
    const first = planKeeping(streaming, stored, { keeping: true, live: true });
    expect(first.inputs.map((i) => i.role)).toEqual(['user']);
    recordPlan(stored, first);
    const second = planKeeping(streaming, stored, { keeping: true, live: false });
    expect(second.inputs.map((i) => i.role)).toEqual(['assistant']);
    recordPlan(stored, second);
    expect(planKeeping(streaming, stored, { keeping: true, live: false }).inputs).toEqual([]);
    // Apply: the card's state changes after the reply was stored.
    const applied = [streaming[0], reply('a1', { parts: [{ kind: 'text', text: 'Renamed it.' }, { kind: 'proposal', proposal: { id: 'pr_1', summary: 'Rename Code', ops: [rename], dropped: [], warnings: [], state: 'applied' } }] })];
    const marker = planKeeping(applied, stored, { keeping: true, live: false });
    expect(marker.inputs).toEqual([{ role: 'assistant', parts: [{ type: 'proposal', id: 'pr_1', summary: 'Rename Code', ops: [], state: 'applied' }] }]);
    recordPlan(stored, marker);
    expect(planKeeping(applied, stored, { keeping: true, live: false }).inputs).toEqual([]);
  });

  it('leaves out a test session’s own turns and earlier ones', () => {
    const items = [user('u1', 'Test run 2 failed', { auto: true }), user('u2', 'x', { testId: 't1' }), reply('a1', { testId: 't1' }), user('u3', 'old', { earlier: true })];
    expect(planKeeping(items, emptyStored(), { keeping: true, live: false }).inputs).toEqual([]);
  });

  const withState = (id: string, state: 'applied' | 'dismissed' | undefined, extra: Partial<AssistantTurn> = {}): AssistantTurn =>
    reply(id, { parts: [{ kind: 'text', text: 'Renamed it.' }, { kind: 'proposal', proposal: { id: 'pr_1', summary: 'Rename Code', ops: [rename], dropped: [], warnings: [], ...(state && { state }) } }], ...extra });

  it('stores a marker when an earlier turn’s proposal is applied or dismissed', () => {
    const kept: ConversationItem[] = [
      { seq: 1, role: 'user', parts: [{ type: 'text', text: 'Rename Code' }], at: '2026-11-14T08:00:00.000Z' },
      { seq: 2, role: 'assistant', parts: [{ type: 'proposal', id: 'pr_1', summary: 'Rename Code', ops: [rename], state: 'pending' }], at: '2026-11-14T08:00:00.000Z' },
    ];
    const back = restore(kept);
    for (const state of ['applied', 'dismissed'] as const) {
      const turns = back.items.map((i) => (i.role === 'assistant' ? { ...i, parts: i.parts.map((p) => (p.kind === 'proposal' ? { ...p, proposal: { ...p.proposal, state } } : p)) } : i));
      const plan = planKeeping(turns, back.stored, { keeping: true, live: false });
      expect(plan.inputs).toEqual([{ role: 'assistant', parts: [{ type: 'proposal', id: 'pr_1', summary: 'Rename Code', ops: [], state }] }]);
    }
  });

  it('never stores a stale verdict, and still stores a later applied or dismissed', () => {
    const kept: ConversationItem[] = [
      { seq: 1, role: 'user', parts: [{ type: 'text', text: 'Rename Code' }], at: '2026-11-14T08:00:00.000Z' },
      { seq: 2, role: 'assistant', parts: [{ type: 'proposal', id: 'pr_1', summary: 'Rename Code', ops: [rename], state: 'pending' }], at: '2026-11-14T08:00:00.000Z' },
    ];
    const back = restore(kept);
    const marked = markStale(back.items, workflow(['Start', 'Formatter']), lookup);
    expect((marked[1] as AssistantTurn).parts.find((p) => p.kind === 'proposal')).toMatchObject({ proposal: { state: 'stale' } });
    expect(planKeeping(marked, back.stored, { keeping: true, live: false }).inputs).toEqual([]);
    for (const state of ['applied', 'dismissed'] as const) {
      const turns = back.items.map((i) => (i.role === 'assistant' ? { ...i, parts: i.parts.map((p) => (p.kind === 'proposal' ? { ...p, proposal: { ...p.proposal, state } } : p)) } : i));
      expect(planKeeping(turns, back.stored, { keeping: true, live: false }).inputs).toHaveLength(1);
    }
  });

  it('stores a marker when a stored reply becomes auto and applied', () => {
    const stored = emptyStored();
    const first = [user('u1', 'Rename Code'), withState('a1', undefined)];
    recordPlan(stored, planKeeping(first, stored, { keeping: true, live: false }));
    const plan = planKeeping([first[0], withState('a1', 'applied', { auto: true })], stored, { keeping: true, live: false });
    expect(plan.inputs).toEqual([{ role: 'assistant', parts: [{ type: 'proposal', id: 'pr_1', summary: 'Rename Code', ops: [], state: 'applied' }] }]);
  });

  it('stores an auto reply that was not stored yet, with its proposal applied', () => {
    const plan = planKeeping([user('u1', 'Rename Code'), withState('a1', 'applied', { auto: true })], emptyStored(), { keeping: true, live: false });
    expect(plan.inputs.map((i) => i.role)).toEqual(['user', 'assistant']);
    expect(plan.inputs[1].parts.find((p) => p.type === 'proposal')).toMatchObject({ state: 'applied', ops: [rename] });
  });

  it('plans nothing again over the same turns with the kept record (a remounted panel)', () => {
    const stored = emptyStored();
    const items = [user('u1', 'hello'), reply('a1')];
    recordPlan(stored, planKeeping(items, stored, { keeping: true, live: false }));
    expect(planKeeping(items, stored, { keeping: true, live: false })).toEqual({ inputs: [], turns: [], proposals: [], cards: [] });
  });

  it('stores nothing, and shows no divider, when the person keeps nothing', () => {
    const items = [user('u1', 'hello'), reply('a1')];
    expect(planKeeping(items, emptyStored(), { keeping: false, live: false })).toEqual({ inputs: [], turns: [], proposals: [], cards: [] });
    expect(shouldResume(false, [])).toBe(false);
    expect(items.some((_, i) => dividerBefore(items, i))).toBe(false);
  });
});

describe('which reply is being built', () => {
  it('is the last live reply, never an earlier or a test session’s', () => {
    expect(builtReply([user('u1', 'x'), reply('a1')])?.id).toBe('a1');
    expect(builtReply([user('u1', 'x', { earlier: true }), reply('k2', { earlier: true })])).toBeUndefined();
    expect(builtReply([reply('a1', { testId: 't1' })])).toBeUndefined();
  });
});

describe('resuming', () => {
  const kept = (seq: number, role: 'user' | 'assistant', parts: ConversationItem['parts'], meta?: ConversationItem['meta']): ConversationItem => ({ seq, role, parts, ...(meta && { meta }), at: '2026-11-14T08:00:00.000Z' });
  const items: ConversationItem[] = [
    kept(1, 'user', [{ type: 'text', text: 'Rename Code' }, { type: 'mentions', refs: [{ type: 'node', id: 'n1', workflowId: 'wf_hist', name: 'Code' }] }]),
    kept(2, 'assistant', [{ type: 'text', text: 'Renamed it.' }, { type: 'steps', steps: [{ id: 's1', label: 'Read @Code', kind: 'read', status: 'ok' }] }, { type: 'proposal', id: 'pr_1', summary: 'Rename Code', ops: [rename], state: 'pending' }], { model: 'test/model', durationMs: 900, steps: 2 }),
    kept(3, 'user', [{ type: 'text', text: 'And add a trigger' }]),
    kept(4, 'assistant', [{ type: 'proposal', id: 'pr_1', summary: 'Rename Code', ops: [], state: 'applied' }]),
  ];

  it('brings the turns back in order, all earlier, folding a marker into the proposal it names', () => {
    const { items: turns } = restore(items);
    expect(turns.map((t) => `${t.role}:${t.id}`)).toEqual(['user:k1', 'assistant:k2', 'user:k3']);
    expect(turns.every((t) => t.earlier)).toBe(true);
    expect(turns[0]).toMatchObject({ mentions: [{ type: 'node', id: 'n1', workflowId: 'wf_hist', name: 'Code' }] });
    const proposal = (turns[1] as AssistantTurn).parts.find((p) => p.kind === 'proposal');
    expect(proposal).toMatchObject({ proposal: { id: 'pr_1', state: 'applied', ops: [rename] } });
    expect(turns[1]).toMatchObject({ text: 'Renamed it.', done: { model: 'test/model' }, steps: [{ label: 'Read @Code', kind: 'read' }] });
  });

  it('puts the earlier turns first with one divider, and what is said now below', () => {
    const { items: turns } = restore(items);
    const now = [user('u9', 'one more thing')];
    const all = withEarlier(turns, now);
    expect(all.map((t) => t.id)).toEqual(['k1', 'k2', 'k3', 'u9']);
    expect(all.map((_, i) => dividerBefore(all, i))).toEqual([true, false, false, false]);
    // Resuming again does not stack the earlier turns.
    expect(withEarlier(turns, all).map((t) => t.id)).toEqual(['k1', 'k2', 'k3', 'u9']);
    expect(shouldResume(true, [])).toBe(true);
    expect(shouldResume(true, now)).toBe(false);
  });

  it('records what is stored, so resumed turns are not stored again', () => {
    const { items: turns, stored } = restore(items);
    expect(planKeeping(turns, stored, { keeping: true, live: false }).inputs).toEqual([]);
  });
});

describe('a proposal that no longer fits', () => {
  const pendingReply = (): ChatItem => reply('k2', { earlier: true });

  it('still fits the workflow it was made for', () => {
    expect(stillFits(workflow(), [rename], lookup).fits).toBe(true);
    const [kept] = markStale([pendingReply()], workflow(), lookup);
    expect((kept as AssistantTurn).parts.find((p) => p.kind === 'proposal')).not.toHaveProperty('proposal.state');
  });

  it('is stale after a node it touches was renamed', () => {
    const changed = workflow(['Start', 'Formatter']);
    expect(stillFits(changed, [rename], lookup).fits).toBe(false);
    const [marked] = markStale([pendingReply()], changed, lookup);
    expect((marked as AssistantTurn).parts.find((p) => p.kind === 'proposal')).toMatchObject({ proposal: { state: 'stale' } });
  });

  it('is stale when the change is already there, and leaves applied and current turns alone', () => {
    expect(stillFits(workflow(['Start', 'Format']), [rename], lookup).fits).toBe(false);
    const applied = reply('k4', { earlier: true, parts: [{ kind: 'proposal', proposal: { id: 'p', summary: 's', ops: [rename], dropped: [], warnings: [], state: 'applied' } }] });
    const fresh = reply('a9');
    const out = markStale([applied, fresh], workflow(['Start', 'Formatter']), lookup);
    expect(out[0]).toBe(applied);
    expect(out[1]).toBe(fresh);
  });

  it('shows no Apply on a stale card', () => {
    const proposal = { id: 'pr_1', summary: 'Rename Code', ops: [rename], dropped: [], warnings: [], state: 'stale' as const };
    const html = renderToStaticMarkup(createElement(ProposalCard, { itemId: 'k2', proposal }));
    expect(html).toContain('This no longer fits the workflow');
    expect(html).not.toContain('Apply');
  });
});
