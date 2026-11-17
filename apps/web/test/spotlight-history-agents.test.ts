/**
 * AG11: Spotlight's history keeps the agents it designed (docs/assistant.md "Conversation history"): the card is stored with
 * its row, a later state (created, smoke test, publish) as a marker, and both come back after a reload. A card that cannot be
 * created again comes back stale; a created card whose agent is gone says so; the route takes the part and bounds it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { smokeLine, publishLine, type AgentCard } from '@/lib/shared/agent-card';
import { conversationItemInputSchema, MAX_ITEM_BYTES, type ConversationItem } from '@/lib/shared/conversations';
import type { AgentProgress, AssistantTurn, ChatItem } from '@/components/editor/assistant';
import { checkCards, deletedCards, DELETED_AGENT_NOTE, emptyStored, planKeeping, recordPlan, replyInput, restore, STALE_CARD_NOTE } from '@/components/editor/spotlight-history';
import { AgentCardView } from '@/components/editor/spotlight/agent-card';
import { enableTestAuth } from '@/lib/server/auth/test-bypass';

const previousDir = process.env.LANDFLOW_DATA_DIR;
process.env.LANDFLOW_DATA_DIR = mkdtempSync(join(tmpdir(), 'landflow-ag11-'));
const list = await import('@/app/api/conversations/route');
const items = await import('@/app/api/conversations/[id]/items/route');
afterAll(() => {
  enableTestAuth();
  process.env.LANDFLOW_DATA_DIR = previousDir;
});

const card = (extra: Partial<AgentCard> = {}): AgentCard => ({
  name: 'Alert triager',
  description: 'Reads an alert and says how urgent it is.',
  model: 'anthropic/claude-sonnet-4-5',
  tools: [{ name: 'classify_alert', writes: false, requireApproval: false }, { name: 'send_email', type: 'messaging.email', operation: 'send', writes: true, requireApproval: true }],
  practices: true,
  guardrails: ['Masks secrets in messages'],
  cases: [{ input: 'Disk 97% full on db-3', expected: 'P1' }],
  needs: [],
  missing: [],
  config: { name: 'Alert triager', tools: [] },
  state: 'designed',
  starter: true,
  workflowId: 'wf_a',
  ...extra,
});

const reply = (id: string, c: AgentCard): AssistantTurn => ({
  id,
  role: 'assistant',
  parts: [{ kind: 'text', text: 'Designed “Alert triager”. Review it, then create it.' }, { kind: 'agentCard', card: c }],
  steps: [],
  text: 'Designed “Alert triager”. Review it, then create it.',
  thinking: [],
});
const ask: ChatItem = { id: 'u1', role: 'user', text: 'Create an agent that triages alerts' };
const row = (extra: Partial<AgentProgress> = {}): AgentProgress => ({ nodeId: 'n_agent', name: 'Alert triager', state: 'draft', agentId: 'agt_1', after: 'a1', ...extra });
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe('storing a designed card', () => {
  it('keeps the card as a part the item schema takes', () => {
    const input = replyInput(reply('a1', card()))!;
    expect(input.parts.map((p) => p.type)).toEqual(['text', 'agentCard']);
    expect(input.parts[1]).toMatchObject({ type: 'agentCard', id: 'a1', card: { name: 'Alert triager', state: 'designed', config: { name: 'Alert triager' } } });
    expect(conversationItemInputSchema.safeParse(input).success).toBe(true);
  });

  it('stores a card with a config too big for its item without the config, and the item fits', () => {
    const big = card({ config: { instructions: 'x'.repeat(40 * 1024) } });
    const input = replyInput(reply('a1', big))!;
    expect(size(input)).toBeLessThanOrEqual(MAX_ITEM_BYTES);
    expect(input.parts.find((p) => p.type === 'agentCard')).toMatchObject({ card: { name: 'Alert triager' } });
    expect(JSON.stringify(input)).not.toContain('xxxxxxxx');
    expect(conversationItemInputSchema.safeParse(input).success).toBe(true);
  });

  it('trims a card that is still too big without its config, so the batch is never refused', () => {
    const cases = Array.from({ length: 30 }, (_, i) => ({ input: `${i}`.padEnd(2000, 'a'), expected: 'b'.repeat(2000) }));
    const input = replyInput(reply('a1', card({ cases, needs: Array.from({ length: 30 }, () => 'n'.repeat(1000)), description: 'd'.repeat(2000) })))!;
    expect(size(input)).toBeLessThanOrEqual(MAX_ITEM_BYTES);
    expect(conversationItemInputSchema.safeParse(input).success).toBe(true);
  });

  it('stores a row whose smoke test is still running as untested, so Test stays', () => {
    const input = replyInput(reply('a1', card({ state: 'created', agentId: 'agt_1' })), [row({ state: 'testing', smoke: { state: 'testing' } })])!;
    expect(input.parts.find((p) => p.type === 'agentCard')).toMatchObject({ row: { state: 'untested' } });
  });

  it('waits for the card before it stores the reply that says Spotlight is designing', () => {
    const designing: AssistantTurn = { id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: 'Designing “Alert triager”…' }], steps: [], text: '', thinking: [] };
    const stored = emptyStored();
    const first = planKeeping([ask, designing], stored, { keeping: true, live: false });
    expect(first.inputs.map((i) => i.role)).toEqual(['user']);
    recordPlan(stored, first);
    const second = planKeeping([ask, reply('a1', card())], stored, { keeping: true, live: false });
    expect(second.inputs.map((i) => i.role)).toEqual(['assistant']);
  });
});

describe('planning a card’s later states', () => {
  const stored = emptyStored();
  const designed = [ask, reply('a1', card())];
  recordPlan(stored, planKeeping(designed, stored, { keeping: true, live: false }));

  const created = card({ state: 'created', agentId: 'agt_1', smoke: { state: 'passed', reply: 'P1' }, publish: { state: 'held', score: 3, reason: 'Scored 3 of 5' } });
  const after = [ask, reply('a1', created)];
  const agents = [row({ state: 'tested', smoke: { state: 'passed', reply: 'P1' }, publish: { state: 'held', score: 3, reason: 'Scored 3 of 5' } })];

  it('stores nothing when nothing changed', () => {
    expect(planKeeping(designed, stored, { keeping: true, live: false }).inputs).toEqual([]);
  });

  it('stores one marker item holding only that card’s part once it is created, tested and held', () => {
    const plan = planKeeping(after, stored, { keeping: true, live: false, agents });
    expect(plan.inputs).toHaveLength(1);
    expect(plan.inputs[0].parts).toHaveLength(1);
    expect(plan.inputs[0].parts[0]).toMatchObject({ type: 'agentCard', id: 'a1', card: { state: 'created', agentId: 'agt_1', smoke: { state: 'passed' }, publish: { state: 'held' } }, row: { nodeId: 'n_agent', state: 'tested' } });
    expect(conversationItemInputSchema.safeParse(plan.inputs[0]).success).toBe(true);
  });

  it('does not store the same state twice, and does not store a state still moving', () => {
    const again = emptyStored();
    recordPlan(again, planKeeping(designed, again, { keeping: true, live: false }));
    const plan = planKeeping(after, again, { keeping: true, live: false, agents });
    recordPlan(again, plan);
    expect(planKeeping(after, again, { keeping: true, live: false, agents }).inputs).toEqual([]);
    // Still creating is the designed state as far as the store goes: nothing new to say.
    const moving = emptyStored();
    recordPlan(moving, planKeeping(designed, moving, { keeping: true, live: false }));
    expect(planKeeping([ask, reply('a1', card({ state: 'creating' }))], moving, { keeping: true, live: false }).inputs).toEqual([]);
  });
});

describe('reading a card back', () => {
  const kept = (cardPart: unknown, ...rest: unknown[]): ConversationItem[] =>
    [
      { seq: 1, role: 'user', parts: [{ type: 'text', text: 'Create an agent that triages alerts' }], at: '2026-11-17T08:00:00.000Z' },
      { seq: 2, role: 'assistant', parts: [{ type: 'text', text: 'Designed “Alert triager”.' }, cardPart], at: '2026-11-17T08:00:01.000Z' },
      ...rest,
    ] as ConversationItem[];
  const designedPart = () => ({ type: 'agentCard', id: 'a1', card: { name: 'Alert triager', description: 'd', tools: [], practices: false, guardrails: [], cases: [], needs: [], missing: [], state: 'designed', workflowId: 'wf_a', config: { name: 'Alert triager' } } });
  const marker = {
    seq: 3,
    role: 'assistant',
    parts: [
      {
        type: 'agentCard',
        id: 'a1',
        card: { name: 'Alert triager', description: 'd', tools: [], practices: false, guardrails: [], cases: [], needs: [], missing: [], state: 'created', agentId: 'agt_1', workflowId: 'wf_a', smoke: { state: 'passed', reply: 'P1' }, publish: { state: 'held', score: 3, reason: 'Scored 3 of 5' } },
        row: { nodeId: 'n_agent', state: 'tested', smoke: { state: 'passed', reply: 'P1' }, publish: { state: 'held', score: 3, reason: 'Scored 3 of 5' }, agentId: 'agt_1' },
      },
    ],
    at: '2026-11-17T08:05:00.000Z',
  };

  it('brings the card back created with its smoke test and publish, and one row that says what it said before', () => {
    const back = restore(kept(designedPart(), marker as never));
    expect(back.items).toHaveLength(2);
    const part = (back.items[1] as AssistantTurn).parts.find((p) => p.kind === 'agentCard');
    expect(part).toMatchObject({ card: { state: 'created', agentId: 'agt_1', smoke: { state: 'passed' }, publish: { state: 'held' } } });
    expect(back.agents).toHaveLength(1);
    expect(back.agents[0]).toMatchObject({ nodeId: 'n_agent', state: 'tested', agentId: 'agt_1', after: 'k2' });
    expect(smokeLine(back.agents[0].smoke)).toBe('tested, 1 of 1 passed');
    expect(publishLine(back.agents[0].publish!)).toMatch(/3/);
    // What was stored is what a live card would say now: nothing is stored again.
    const turns = back.items as AssistantTurn[];
    expect(planKeeping(back.items, back.stored, { keeping: true, live: false, agents: back.agents }).inputs).toEqual([]);
    expect(turns[1].id).toBe('k2');
  });

  it('stores a later state of a restored card under the id it was first stored under', () => {
    const back = restore(kept(designedPart()));
    const created = back.items.map((i) => (i.role === 'assistant' ? { ...i, parts: i.parts.map((p) => (p.kind === 'agentCard' ? { ...p, card: { ...p.card, state: 'created' as const, agentId: 'agt_9' } } : p)) } : i));
    const plan = planKeeping(created, back.stored, { keeping: true, live: false });
    expect(plan.inputs[0].parts[0]).toMatchObject({ type: 'agentCard', id: 'a1', card: { state: 'created' } });
  });

  it('brings a card with no config back stale: no Create', () => {
    const noConfig = designedPart();
    delete (noConfig.card as { config?: unknown }).config;
    const back = restore(kept(noConfig));
    const html = renderToStaticMarkup(createElement(AgentCardView, { itemId: 'k2', card: ((back.items[1] as AssistantTurn).parts.find((p) => p.kind === 'agentCard') as { card: AgentCard }).card }));
    expect(html).toContain(STALE_CARD_NOTE);
    expect(html).not.toContain('Create agent');
    expect(html).not.toContain('Try again');
  });

  it('keeps Create for a waiting card in the workflow it was designed in, and makes it stale in another', () => {
    const back = restore(kept(designedPart()));
    const render = (items: ChatItem[]) => renderToStaticMarkup(createElement(AgentCardView, { itemId: 'k2', card: ((items[1] as AssistantTurn).parts.find((p) => p.kind === 'agentCard') as { card: AgentCard }).card }));
    expect(render(checkCards(back.items, 'wf_a'))).toContain('Create agent');
    expect(render(checkCards(back.items, 'wf_b'))).toContain(STALE_CARD_NOTE);
    expect(render(checkCards(back.items, 'wf_b'))).not.toContain('Create agent');
  });

  it('says a created card’s agent was deleted when it answers 404, and asks each agent once', async () => {
    const back = restore(kept(designedPart(), marker as never));
    const asked: string[] = [];
    const gone = await deletedCards(back.items, async (id) => {
      asked.push(id);
      return true;
    });
    expect(gone).toEqual([['k2', 'agt_1']]);
    expect(asked).toEqual(['agt_1']);
    const part = (back.items[1] as AssistantTurn).parts.find((p) => p.kind === 'agentCard') as { card: AgentCard };
    const html = renderToStaticMarkup(createElement(AgentCardView, { itemId: 'k2', card: { ...part.card, error: DELETED_AGENT_NOTE } }));
    expect(html).toContain(DELETED_AGENT_NOTE);
    expect(html).not.toContain('Open');
    const live = renderToStaticMarkup(createElement(AgentCardView, { itemId: 'k2', card: part.card }));
    expect(live).toContain('Open');
    expect(await deletedCards(back.items, async () => { throw new Error('offline'); })).toEqual([]);
  });
});

describe('the route', () => {
  const req = (path: string, body: unknown) => new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const make = async () => (await (await list.POST(req('/api/conversations', { surface: 'spotlight', subjectType: 'workflow', subjectId: 'wf_a' }))).json()).conversation.id as string;
  const part = (description: string) => ({ type: 'agentCard', id: 'a1', card: { name: 'Alert triager', description, tools: [], practices: false, guardrails: [], cases: [], needs: [], missing: [], state: 'designed' } });

  it('takes an agentCard part (200, as the route answers) and refuses one with a 40 KB description (400)', async () => {
    const id = await make();
    const post = (p: unknown) => items.POST(req(`/api/conversations/${id}/items`, { items: [{ role: 'assistant', parts: [p] }] }), { params: Promise.resolve({ id }) });
    expect((await post(part('Reads an alert.'))).status).toBe(200);
    expect((await post(part('x'.repeat(40 * 1024)))).status).toBe(400);
  });
});
