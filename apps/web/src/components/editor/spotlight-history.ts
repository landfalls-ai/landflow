/**
 * Spotlight's kept conversation (docs/assistant.md#conversation-history), the pure parts: which turns of the chat are
 * stored and as what, how a stored conversation comes back under "Earlier", and which of its proposals no longer fit the
 * workflow. Nothing here touches the store or the network, so the tests run it without a DOM.
 *
 * What is stored per turn: the user's words and the tags they chose; the assistant's steps (names, status, time), its words
 * and its proposals with their state, a failure and what the reply cost. Never the tags' resolved text or a tool result.
 */
import type { ReplyInfo } from '../ui/chat';
import { applyOps, type AssistantOp, type DescriptorLookup } from '@/lib/shared/assistant-ops';
import { MAX_ITEM_BYTES, type ConversationItem, type ConversationItemInput, type ConversationPart } from '@/lib/shared/conversations';
import type { ActivityKind, ActivityStep } from '@/lib/shared/activity';
import { isMentionType } from '@/lib/shared/mentions';
import type { Workflow } from '@/lib/shared/types';
import type { AgentCard, AgentSmoke, AgentPublish } from '@/lib/shared/agent-card'; // AG11:
import type { AgentProgress, AssistantTurn, ChatItem, Proposal } from './assistant';

/** The state a stored proposal has: Spotlight's `undone` is stored as `dismissed` (it is not applied any more). */
export type KeptState = 'pending' | 'applied' | 'dismissed' | 'stale';

export const keptState = (state: Proposal['state']): KeptState => (state === 'applied' ? 'applied' : state === 'dismissed' || state === 'undone' ? 'dismissed' : state === 'stale' ? 'stale' : 'pending');

/** What has been stored of this chat so far: the turns (by id) and each proposal's last stored state. */
export interface Stored {
  turns: Set<string>;
  proposals: Map<string, KeptState>;
  /** AG11: each agent card by the chat item that holds it: the id it is stored under and what was stored of it (`cardSignature`). */
  cards: Map<string, { id: string; sig: string }>;
}

export const emptyStored = (): Stored => ({ turns: new Set(), proposals: new Map(), cards: new Map() });

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * Whether a new turn is stored: not a test-and-fix session's own notes, not a turn brought back from the store, and not a
 * note the chat added to the person's side (`auto` on a user turn). An assistant reply that autonomous mode applied
 * (`auto`) is stored, with its proposal as applied.
 */
const keepable = (item: ChatItem) => !item.testId && !item.earlier && !(item.role === 'user' && item.auto);

/** The user's turn: their words, and the tags they chose (names only, to show them again). */
export function userInput(item: Extract<ChatItem, { role: 'user' }>): ConversationItemInput {
  const parts: ConversationPart[] = [{ type: 'text', text: item.text.slice(0, 20_000) }];
  if (item.mentions?.length) parts.push({ type: 'mentions', refs: item.mentions.slice(0, 8).map((m) => ({ type: m.type, id: m.id, ...(m.workflowId && { workflowId: m.workflowId }), name: m.name.slice(0, 200) })) });
  return { role: 'user', parts };
}

/** An item is at most 32 KB: leave out what is least needed (the steps, then the proposals' ops, then the words) until it fits. */
function fit(input: ConversationItemInput): ConversationItemInput {
  if (bytes(input) <= MAX_ITEM_BYTES) return input;
  // AG11: an agent card's config goes first (the card then comes back without Create).
  const bare = { ...input, parts: input.parts.map((p) => (p.type === 'agentCard' && p.card.config ? { ...p, card: withoutConfig(p.card) } : p)) };
  if (bytes(bare) <= MAX_ITEM_BYTES) return bare;
  input = bare;
  let parts = input.parts.filter((p) => p.type !== 'steps');
  let next = { ...input, parts };
  if (bytes(next) <= MAX_ITEM_BYTES) return next;
  // A proposal without its ops cannot be applied again: it is stored as stale.
  parts = parts.map((p) => (p.type === 'proposal' ? { ...p, ops: [], state: 'stale' as const } : p));
  next = { ...input, parts };
  if (bytes(next) <= MAX_ITEM_BYTES) return next;
  next = { ...input, parts: parts.map((p) => (p.type === 'text' ? { ...p, text: p.text.slice(0, 8_000) } : p)) };
  if (bytes(next) <= MAX_ITEM_BYTES) return next;
  // AG11: a card still too big: its cases, needs and description are cut, so a card with real content fits (a pathological one, 60 tools with long strings, can still make the server refuse the batch).
  return { ...next, parts: next.parts.map((p) => (p.type === 'agentCard' ? { ...p, card: { ...p.card, description: p.card.description.slice(0, 500), cases: p.card.cases.slice(0, 3).map((c) => ({ ...c, input: c.input.slice(0, 300), ...(c.expected && { expected: c.expected.slice(0, 300) }) })), needs: p.card.needs.slice(0, 5).map((n) => n.slice(0, 200)), changes: p.card.changes?.slice(0, 5).map((c) => c.slice(0, 200)) } } : p)) };
}

/** The assistant's turn as a stored item, or nothing when it has nothing to keep (a reply stopped before it said anything). */
export function replyInput(item: AssistantTurn, agents: readonly AgentProgress[] = []): ConversationItemInput | undefined {
  const parts: ConversationPart[] = [];
  const text = (item.text ?? item.parts.flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join('\n\n')).trim();
  if (text) parts.push({ type: 'text', text });
  if (item.steps?.length) parts.push({ type: 'steps', steps: item.steps.slice(0, 200).map((s) => ({ id: s.id.slice(0, 200), label: s.label.slice(0, 500), kind: s.kind, status: s.status, ...(s.durationMs !== undefined && { durationMs: s.durationMs }) })) });
  for (const part of item.parts) {
    if (part.kind !== 'proposal') continue;
    parts.push({ type: 'proposal', id: part.proposal.id, summary: part.proposal.summary.slice(0, 2_000), ops: part.proposal.ops.slice(0, 500), state: keptState(part.proposal.state) });
  }
  // AG11: the agent card Spotlight designed, with the row of its step.
  const cardItem = item.parts.find((p) => p.kind === 'agentCard');
  if (cardItem?.kind === 'agentCard') parts.push(cardPart(item.id, cardItem.card, rowFor(cardItem.card, agents)));
  if (item.error) parts.push({ type: 'error', message: item.error.slice(0, 4_000) });
  if (!parts.length) return undefined;
  const m = item.meta;
  return fit({
    role: 'assistant',
    parts,
    ...(m && { meta: { ...(m.model && { model: m.model }), ...(m.durationMs !== undefined && { durationMs: m.durationMs }), ...(m.steps !== undefined && { steps: m.steps }), ...(m.inputTokens !== undefined && { inputTokens: m.inputTokens }), ...(m.outputTokens !== undefined && { outputTokens: m.outputTokens }), ...(m.costUsd !== undefined && { costUsd: m.costUsd }), ...(m.local && { local: true }) } }),
  });
}

// ---- agent cards (AG11) ---------------------------------------------------------------------------------------------

type CardPart = Extract<ConversationPart, { type: 'agentCard' }>;
type StoredCard = CardPart['card'];
type StoredRow = NonNullable<CardPart['row']>;

/** What a card says when it comes back without what Create needs, or for another workflow. */
export const STALE_CARD_NOTE = 'Ask again to design it';
/** What a created card says when its agent is gone. */
export const DELETED_AGENT_NOTE = 'This agent was deleted';

/** A card that comes back with no Create: no configuration to send (too big for an item, or another workflow's). */
export const isStaleCard = (card: AgentCard): boolean => card.state === 'failed' && !Object.keys(card.config).length;

const withoutConfig = (card: StoredCard): StoredCard => {
  const { config: _config, ...rest } = card;
  return rest;
};

/** The row of a created card's Run an Agent step, if it has one (a design row, `card:<id>`, is not a step's). */
function rowFor(card: AgentCard, agents: readonly AgentProgress[]): AgentProgress | undefined {
  return card.agentId ? agents.find((a) => a.agentId === card.agentId && !a.nodeId.startsWith('card:')) : undefined;
}

// A state still moving is stored as the one before it: the next marker says where it ended.
const settledSmoke = (smoke: AgentSmoke | undefined) => (smoke && smoke.state !== 'testing' ? { state: smoke.state, ...(smoke.reply && { reply: smoke.reply.slice(0, 300) }), ...(smoke.reason && { reason: smoke.reason.slice(0, 1000) }), ...(smoke.ms !== undefined && { ms: smoke.ms }), ...(smoke.tools?.length && { tools: smoke.tools.slice(0, 30).map((t) => ({ name: t.name.slice(0, 200), status: t.status, ...(t.note && { note: t.note.slice(0, 500) }) })) }) } : undefined);
const settledPublish = (publish: AgentPublish | undefined) => (publish && publish.state !== 'publishing' ? { state: publish.state, ...(publish.cases !== undefined && { cases: publish.cases }), ...(publish.score !== undefined && { score: publish.score }), ...(publish.reason && { reason: publish.reason.slice(0, 1000) }) } : undefined);

function storedCard(card: AgentCard, withConfig: boolean): StoredCard {
  const smoke = settledSmoke(card.smoke);
  const publish = settledPublish(card.publish);
  const created = card.state === 'created';
  return {
    name: card.name.slice(0, 200),
    description: card.description.slice(0, 2000),
    ...(card.model && { model: card.model.slice(0, 200) }),
    tools: card.tools.slice(0, 60).map((t) => ({ name: t.name.slice(0, 200), ...(t.type && { type: t.type.slice(0, 200) }), ...(t.operation && { operation: t.operation.slice(0, 200) }), writes: t.writes, requireApproval: t.requireApproval })),
    ...(card.knowledge && { knowledge: card.knowledge.slice(0, 300) }),
    practices: card.practices,
    guardrails: card.guardrails.slice(0, 30).map((g) => g.slice(0, 500)),
    cases: card.cases.slice(0, 30).map((c) => ({ input: c.input.slice(0, 2000), ...(c.expected && { expected: c.expected.slice(0, 2000) }) })),
    needs: card.needs.slice(0, 30).map((n) => n.slice(0, 1000)),
    missing: card.missing.slice(0, 30).map((m) => m.slice(0, 500)),
    ...(card.notAdded?.length && { notAdded: card.notAdded.slice(0, 30).map((n) => ({ name: n.name.slice(0, 200), reason: n.reason.slice(0, 500) })) }),
    ...(card.changes && { changes: card.changes.slice(0, 50).map((c) => c.slice(0, 500)) }),
    ...(card.models?.length && !created && { models: card.models.slice(0, 30).map((m) => m.slice(0, 200)) }),
    state: card.state === 'creating' ? 'designed' : card.state,
    ...(card.agentId && { agentId: card.agentId.slice(0, 200) }),
    ...(card.workflowId && { workflowId: card.workflowId.slice(0, 200) }),
    // A created card's note (a deleted agent) is read again on each visit, never stored.
    ...(card.error && !created && { error: card.error.slice(0, 2000) }),
    ...(smoke && { smoke }),
    ...(publish && { publish }),
    ...(card.starter && { starter: true }),
    ...(card.ask && { ask: card.ask.slice(0, 4000) }),
    ...(card.base && { base: { agentId: card.base.agentId.slice(0, 200), name: card.base.name.slice(0, 200) } }),
    // Create sends the config: only a card still waiting needs it, and a card that cannot be created again has no use for it.
    ...(withConfig && !created && Object.keys(card.config).length && !isStaleCard(card) && { config: card.config }),
  };
}

function storedRow(row: AgentProgress | undefined): StoredRow | undefined {
  if (!row) return undefined;
  const smoke = settledSmoke(row.smoke);
  const publish = settledPublish(row.publish);
  const state = row.state === 'designing' ? 'draft' : row.state === 'testing' ? 'untested' : row.state === 'publishing' ? (smoke?.state === 'passed' ? 'tested' : 'draft') : row.state;
  return { nodeId: row.nodeId.slice(0, 200), state, ...(smoke && { smoke }), ...(publish && { publish }), ...(row.summary && { summary: row.summary.slice(0, 1000) }), ...(row.agentId && { agentId: row.agentId.slice(0, 200) }) };
}

/** An agent card as the part that is stored, with the row of its step when it has one. */
function cardPart(id: string, card: AgentCard, row: AgentProgress | undefined): CardPart {
  const kept = storedRow(row);
  return { type: 'agentCard', id: id.slice(0, 200), card: storedCard(card, true), ...(kept && { row: kept }) };
}

/** What is stored of a card, without its config: the same card is stored once. A stale card (read again on each visit) has no signature. */
export function cardSignature(card: AgentCard, row?: AgentProgress): string {
  return JSON.stringify([storedCard(card, false), storedRow(row)]);
}

/** A later state of a stored proposal, as an item: reading the conversation back lets it replace the state it names. */
export const markerInput = (proposal: Proposal, state: KeptState): ConversationItemInput => ({ role: 'assistant', parts: [{ type: 'proposal', id: proposal.id, summary: proposal.summary.slice(0, 2_000), ops: [], state }] });

export interface KeepPlan {
  inputs: ConversationItemInput[];
  /** What the plan stores, to record once it is sent. */
  turns: string[];
  proposals: Array<[string, KeptState]>;
  /** AG11: the cards it stores, by the chat item that holds each. */
  cards: Array<[string, { id: string; sig: string }]>;
}

/** AG11: a reply that only says Spotlight is designing or changing an agent: it is stored once the card (or the failure) is there. */
const designingNote = (item: AssistantTurn): boolean => !item.error && item.parts.every((p) => p.kind === 'text') && /^(?:Designing|Changing) “/.test(item.text ?? item.parts.flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join(''));

/**
 * What of the chat is to be stored now. A user turn goes at once; the assistant's once its reply has finished (`live`: the
 * last turn is still streaming); a proposal's later state goes as a marker. With `keeping` off, nothing.
 */
export function planKeeping(items: readonly ChatItem[], stored: Stored, options: { keeping: boolean; live: boolean; agents?: readonly AgentProgress[] /* AG11: the rows of the agents' steps */ }): KeepPlan {
  const plan: KeepPlan = { inputs: [], turns: [], proposals: [], cards: [] };
  const agents = options.agents ?? [];
  if (!options.keeping) return plan;
  const lastId = items.at(-1)?.id;
  for (const item of items) {
    if (item.role === 'user') {
      if (stored.turns.has(item.id) || !keepable(item)) continue;
      plan.inputs.push(userInput(item));
      plan.turns.push(item.id);
      continue;
    }
    if (!stored.turns.has(item.id)) {
      if (!keepable(item)) continue;
      if (options.live && item.id === lastId) break;
      if (designingNote(item)) continue; // AG11: not yet: the card is what is kept
      const input = replyInput(item, agents);
      // Nothing to keep: still counted, so a stopped, empty reply is not looked at again.
      plan.turns.push(item.id);
      if (!input) continue;
      plan.inputs.push(input);
      for (const part of item.parts) if (part.kind === 'proposal') plan.proposals.push([part.proposal.id, keptState(part.proposal.state)]);
      for (const part of item.parts) if (part.kind === 'agentCard') plan.cards.push([item.id, { id: item.id, sig: cardSignature(part.card, rowFor(part.card, agents)) }]);
      continue;
    }
    // AG11: a card's later state (created, its smoke test, its publish, Applied) goes as a marker holding only that card.
    const card = item.parts.find((p) => p.kind === 'agentCard');
    if (card?.kind === 'agentCard' && !isStaleCard(card.card) && !(card.card.state === 'created' && card.card.error)) {
      const row = rowFor(card.card, agents);
      const sig = cardSignature(card.card, row);
      const before = plan.cards.findLast(([id]) => id === item.id)?.[1] ?? stored.cards.get(item.id);
      if (before?.sig !== sig) {
        const id = before?.id ?? item.id;
        plan.inputs.push(fit({ role: 'assistant', parts: [cardPart(id, card.card, row)] }));
        plan.cards.push([item.id, { id, sig }]);
      }
    }
    for (const part of item.parts) {
      if (part.kind !== 'proposal') continue;
      const now = keptState(part.proposal.state);
      const before = plan.proposals.findLast(([id]) => id === part.proposal.id)?.[1] ?? stored.proposals.get(part.proposal.id);
      // A stale verdict is computed on each visit (`markStale`), never stored: the stored state stays as it was.
      if (before === undefined || before === now || now === 'stale') continue;
      plan.inputs.push(markerInput(part.proposal, now));
      plan.proposals.push([part.proposal.id, now]);
    }
  }
  return plan;
}

/** Record what a plan stored. */
export function recordPlan(stored: Stored, plan: KeepPlan): void {
  for (const id of plan.turns) stored.turns.add(id);
  for (const [id, state] of plan.proposals) stored.proposals.set(id, state);
  for (const [item, card] of plan.cards) stored.cards.set(item, card);
}

// ---- reading a conversation back ------------------------------------------------------------------------------------

/**
 * The stored conversation as chat turns, all under "Earlier" (ids `k<seq>`). A marker item (only proposal parts, naming a
 * proposal an earlier item holds) is not a turn: its state replaces the one it names.
 */
export function restore(items: readonly ConversationItem[]): { items: ChatItem[]; stored: Stored; agents: AgentProgress[] } {
  const stored = emptyStored();
  const turns: ChatItem[] = [];
  const holders = new Map<string, Proposal>();
  // AG11: each stored card by its stored id: the chat item and part that hold it, and the row of its step.
  const cards = new Map<string, { itemId: string; part: { kind: 'agentCard'; card: AgentCard }; row?: AgentProgress }>();
  const remember = (id: string, card: AgentCard, row: AgentProgress | undefined, itemId: string) => stored.cards.set(itemId, { id, sig: cardSignature(card, row) });
  for (const item of items) {
    const id = `k${item.seq}`;
    if (item.role === 'user') {
      const text = item.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n\n');
      const refs = item.parts.flatMap((p) => (p.type === 'mentions' ? p.refs : [])).flatMap((r) => (isMentionType(r.type) ? [{ type: r.type, id: r.id, ...(r.workflowId && { workflowId: r.workflowId }), name: r.name }] : []));
      turns.push({ id, role: 'user', text, earlier: true, ...(refs.length && { mentions: refs }) });
      stored.turns.add(id);
      continue;
    }
    const proposals = item.parts.flatMap((p) => (p.type === 'proposal' ? [p] : []));
    const cardParts = item.parts.flatMap((p) => (p.type === 'agentCard' ? [p] : []));
    const isMarker = proposals.length > 0 && proposals.length === item.parts.length && proposals.every((p) => holders.has(p.id));
    if (isMarker) {
      for (const p of proposals) {
        const held = holders.get(p.id)!;
        held.state = fromKept(p.state);
        stored.proposals.set(p.id, p.state);
      }
      continue;
    }
    // AG11: a card's later state: it replaces what the held card says (the config stays only when the marker has it).
    if (cardParts.length > 0 && cardParts.length === item.parts.length && cardParts.every((p) => cards.has(p.id))) {
      for (const p of cardParts) {
        const held = cards.get(p.id)!;
        held.part.card = cardFrom(p.card);
        const row = p.row ? rowFrom(p.row, held.part.card, held.itemId) : held.row;
        held.row = row;
        remember(p.id, held.part.card, row, held.itemId);
      }
      continue;
    }
    const text = item.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n\n');
    const steps = item.parts.flatMap((p) => (p.type === 'steps' ? p.steps : [])).map((s): ActivityStep => ({ id: s.id, label: s.label, kind: (s.kind as ActivityKind) || 'tool', status: s.status === 'failed' ? 'failed' : 'ok', ...(s.durationMs !== undefined && { durationMs: s.durationMs }) }));
    const failure = item.parts.find((p) => p.type === 'error');
    const parts: AssistantTurn['parts'] = [...(text ? [{ kind: 'text' as const, text }] : [])];
    for (const p of proposals) {
      const proposal: Proposal = { id: p.id, summary: p.summary, ops: p.ops as AssistantOp[], dropped: [], warnings: [], ...(fromKept(p.state) && { state: fromKept(p.state) }) };
      holders.set(p.id, proposal);
      stored.proposals.set(p.id, p.state);
      parts.push({ kind: 'proposal', proposal });
    }
    for (const p of cardParts.slice(0, 1)) {
      const part = { kind: 'agentCard' as const, card: cardFrom(p.card) };
      const row = p.row ? rowFrom(p.row, part.card, id) : undefined;
      cards.set(p.id, { itemId: id, part, ...(row && { row }) });
      remember(p.id, part.card, row, id);
      parts.push(part);
    }
    const m = item.meta;
    const meta: ReplyInfo | undefined = m && { model: m.model, durationMs: m.durationMs, steps: m.steps, inputTokens: m.inputTokens, outputTokens: m.outputTokens, costUsd: m.costUsd, ...(m.local && { local: true }) };
    turns.push({
      id,
      role: 'assistant',
      parts,
      steps,
      text,
      thinking: [],
      earlier: true,
      ...(failure?.type === 'error' && { error: failure.message }),
      ...(meta && { meta }),
      ...(m?.model && { done: { model: m.model, durationMs: m.durationMs ?? 0, steps: m.steps ?? 0 } }),
    });
    stored.turns.add(id);
  }
  return { items: turns, stored, agents: [...cards.values()].flatMap((c) => (c.row ? [c.row] : [])) };
}

/** AG11: a stored card as the chat's. One with no config (too big for its item, or never had it) is stale: no Create, "Ask again to design it". */
function cardFrom(c: StoredCard): AgentCard {
  const config = (c.config ?? {}) as Record<string, unknown>;
  const waiting = c.state === 'designed' || c.state === 'creating' || c.state === 'failed';
  const stale = waiting && !Object.keys(config).length;
  return {
    name: c.name,
    description: c.description,
    ...(c.model && { model: c.model }),
    tools: c.tools.map((t) => ({ name: t.name, ...(t.type && { type: t.type }), ...(t.operation && { operation: t.operation }), writes: t.writes, requireApproval: t.requireApproval })),
    ...(c.knowledge && { knowledge: c.knowledge }),
    practices: c.practices,
    guardrails: c.guardrails,
    cases: c.cases.map((x) => ({ input: x.input, ...(x.expected && { expected: x.expected }) })),
    needs: c.needs,
    missing: c.missing,
    config,
    state: stale ? 'failed' : c.state === 'creating' ? 'designed' : c.state,
    ...(c.agentId && { agentId: c.agentId }),
    ...(stale ? { error: STALE_CARD_NOTE } : c.error && { error: c.error }),
    ...(c.smoke && { smoke: c.smoke }),
    ...(c.publish && { publish: c.publish }),
    ...(c.starter && { starter: true }),
    ...(c.workflowId && { workflowId: c.workflowId }),
    ...(c.ask && { ask: c.ask }),
    ...(c.notAdded && { notAdded: c.notAdded }),
    ...(c.models && { models: c.models }),
    ...(c.base && { base: c.base }),
    ...(c.changes && { changes: c.changes }),
  };
}

/** AG11: the stored row of a card's step as the chat's row, after the item that holds the card. */
function rowFrom(r: StoredRow, card: AgentCard, after: string): AgentProgress {
  return { nodeId: r.nodeId ?? `card:${after}`, name: card.name, state: r.state, ...(r.smoke && { smoke: r.smoke }), ...(r.publish && { publish: r.publish }), ...(r.summary && { summary: r.summary }), ...(r.agentId && { agentId: r.agentId }), ...(r.state === 'tested' && { restored: true }), after };
}

/**
 * AG11: the restored cards checked against where they are shown: a card still waiting keeps Create only in the workflow it
 * was designed in (a change to an agent that exists is never offered again: it was made against the agent as it was); any
 * other becomes stale ("Ask again to design it").
 */
export function checkCards(items: readonly ChatItem[], workflowId: string): ChatItem[] {
  return items.map((item) => {
    if (item.role !== 'assistant' || !item.earlier || !item.parts.some((p) => p.kind === 'agentCard')) return item;
    let changed = false;
    const parts = item.parts.map((part) => {
      if (part.kind !== 'agentCard' || (part.card.state !== 'designed' && part.card.state !== 'failed') || isStaleCard(part.card)) return part;
      if (part.card.workflowId === workflowId && !part.card.base) return part;
      changed = true;
      return { ...part, card: { ...part.card, state: 'failed' as const, config: {}, error: STALE_CARD_NOTE } };
    });
    return changed ? { ...item, parts } : item;
  });
}

/** AG11: the created cards (newest first, at most `limit`) as [chat item id, agent id]: each agent is looked up once. */
export function createdCards(items: readonly ChatItem[], limit = 10): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const item of [...items].reverse()) {
    if (item.role !== 'assistant' || !item.earlier) continue;
    for (const part of item.parts) {
      const agentId = part.kind === 'agentCard' && part.card.state === 'created' ? (part.card.base?.agentId ?? part.card.agentId) : undefined;
      if (!agentId || (!seen.has(agentId) && seen.size >= limit)) continue;
      seen.add(agentId);
      out.push([item.id, agentId]);
    }
  }
  return out;
}

/** AG11: of the created cards, [chat item, agent] whose agent `gone` says no longer exists (a lookup that fails any other way keeps the card). Each agent is asked once. */
export async function deletedCards(items: readonly ChatItem[], gone: (agentId: string) => Promise<boolean>): Promise<Array<[string, string]>> {
  const asked = new Map<string, Promise<boolean>>();
  const found = await Promise.all(
    createdCards(items).map(async ([itemId, agentId]) => {
      if (!asked.has(agentId)) asked.set(agentId, gone(agentId).catch(() => false));
      return (await asked.get(agentId)) ? ([itemId, agentId] as [string, string]) : undefined;
    }),
  );
  return found.flatMap((f) => (f ? [f] : []));
}

/** A stored state as the chat's: a pending proposal has none (its card shows Apply). */
function fromKept(state: KeptState): Proposal['state'] {
  return state === 'applied' ? 'applied' : state === 'dismissed' ? 'dismissed' : state === 'stale' ? 'stale' : undefined;
}

/** The chat after a stored conversation is brought back: it goes first, under "Earlier", and what was said since stays below. */
export function withEarlier(restored: readonly ChatItem[], current: readonly ChatItem[]): ChatItem[] {
  return [...restored, ...current.filter((item) => !item.earlier)];
}

/** Whether the "Earlier" divider goes before the turn at `index`: the first of the earlier turns. */
export const dividerBefore = (items: readonly ChatItem[], index: number): boolean => Boolean(items[index]?.earlier) && !items[index - 1]?.earlier;

/** Whether to look for a conversation to resume: the person keeps them, and has not started this chat already. */
export const shouldResume = (keeping: boolean, items: readonly ChatItem[]): boolean => keeping && !items.some((i) => !i.earlier);

// ---- stale proposals ------------------------------------------------------------------------------------------------

const graph = (wf: Workflow) => JSON.stringify([wf.nodes, wf.connections]);

/** Whether `ops` still apply to `workflow` cleanly (the apply's own check, as a dry run): every op applies and something changes. */
export function stillFits(workflow: Workflow, ops: AssistantOp[], lookup: DescriptorLookup): { fits: boolean; workflow: Workflow } {
  if (!ops.length) return { fits: false, workflow };
  const result = applyOps(workflow, ops, lookup);
  const fits = result.applied.length > 0 && result.dropped.length === 0 && graph(result.workflow) !== graph(workflow);
  return { fits, workflow: fits ? result.workflow : workflow };
}

/**
 * The turns with each proposal still waiting (no state) checked against the current workflow: one that no longer applies
 * becomes `stale` (its card says so and has no Apply). Waiting proposals build on each other, so each is checked on the
 * workflow the earlier ones leave.
 */
export function markStale(items: readonly ChatItem[], workflow: Workflow, lookup: DescriptorLookup): ChatItem[] {
  let working = workflow;
  return items.map((item) => {
    if (item.role !== 'assistant' || !item.earlier) return item;
    let changed = false;
    const parts = item.parts.map((part) => {
      if (part.kind !== 'proposal' || part.proposal.state) return part;
      const check = stillFits(working, part.proposal.ops, lookup);
      if (check.fits) {
        working = check.workflow;
        return part;
      }
      changed = true;
      return { ...part, proposal: { ...part.proposal, state: 'stale' as const } };
    });
    return changed ? { ...item, parts } : item;
  });
}
