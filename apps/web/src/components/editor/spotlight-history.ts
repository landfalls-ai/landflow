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
import type { AssistantTurn, ChatItem, Proposal } from './assistant';

/** The state a stored proposal has: Spotlight's `undone` is stored as `dismissed` (it is not applied any more). */
export type KeptState = 'pending' | 'applied' | 'dismissed' | 'stale';

export const keptState = (state: Proposal['state']): KeptState => (state === 'applied' ? 'applied' : state === 'dismissed' || state === 'undone' ? 'dismissed' : state === 'stale' ? 'stale' : 'pending');

/** What has been stored of this chat so far: the turns (by id) and each proposal's last stored state. */
export interface Stored {
  turns: Set<string>;
  proposals: Map<string, KeptState>;
}

export const emptyStored = (): Stored => ({ turns: new Set(), proposals: new Map() });

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** A turn is kept only when it came from the person and the chat: not a test-and-fix session's own notes. */
const keepable = (item: ChatItem) => !item.auto && !item.testId && !item.earlier;

/** The user's turn: their words, and the tags they chose (names only, to show them again). */
export function userInput(item: Extract<ChatItem, { role: 'user' }>): ConversationItemInput {
  const parts: ConversationPart[] = [{ type: 'text', text: item.text.slice(0, 20_000) }];
  if (item.mentions?.length) parts.push({ type: 'mentions', refs: item.mentions.slice(0, 8).map((m) => ({ type: m.type, id: m.id, ...(m.workflowId && { workflowId: m.workflowId }), name: m.name.slice(0, 200) })) });
  return { role: 'user', parts };
}

/** An item is at most 32 KB: leave out what is least needed (the steps, then the proposals' ops, then the words) until it fits. */
function fit(input: ConversationItemInput): ConversationItemInput {
  if (bytes(input) <= MAX_ITEM_BYTES) return input;
  let parts = input.parts.filter((p) => p.type !== 'steps');
  let next = { ...input, parts };
  if (bytes(next) <= MAX_ITEM_BYTES) return next;
  // A proposal without its ops cannot be applied again: it is stored as stale.
  parts = parts.map((p) => (p.type === 'proposal' ? { ...p, ops: [], state: 'stale' as const } : p));
  next = { ...input, parts };
  if (bytes(next) <= MAX_ITEM_BYTES) return next;
  return { ...input, parts: parts.map((p) => (p.type === 'text' ? { ...p, text: p.text.slice(0, 8_000) } : p)) };
}

/** The assistant's turn as a stored item, or nothing when it has nothing to keep (a reply stopped before it said anything). */
export function replyInput(item: AssistantTurn): ConversationItemInput | undefined {
  const parts: ConversationPart[] = [];
  const text = (item.text ?? item.parts.flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join('\n\n')).trim();
  if (text) parts.push({ type: 'text', text });
  if (item.steps?.length) parts.push({ type: 'steps', steps: item.steps.slice(0, 200).map((s) => ({ id: s.id.slice(0, 200), label: s.label.slice(0, 500), kind: s.kind, status: s.status, ...(s.durationMs !== undefined && { durationMs: s.durationMs }) })) });
  for (const part of item.parts) {
    if (part.kind !== 'proposal') continue;
    parts.push({ type: 'proposal', id: part.proposal.id, summary: part.proposal.summary.slice(0, 2_000), ops: part.proposal.ops.slice(0, 500), state: keptState(part.proposal.state) });
  }
  if (item.error) parts.push({ type: 'error', message: item.error.slice(0, 4_000) });
  if (!parts.length) return undefined;
  const m = item.meta;
  return fit({
    role: 'assistant',
    parts,
    ...(m && { meta: { ...(m.model && { model: m.model }), ...(m.durationMs !== undefined && { durationMs: m.durationMs }), ...(m.steps !== undefined && { steps: m.steps }), ...(m.inputTokens !== undefined && { inputTokens: m.inputTokens }), ...(m.outputTokens !== undefined && { outputTokens: m.outputTokens }), ...(m.costUsd !== undefined && { costUsd: m.costUsd }), ...(m.local && { local: true }) } }),
  });
}

/** A later state of a stored proposal, as an item: reading the conversation back lets it replace the state it names. */
export const markerInput = (proposal: Proposal, state: KeptState): ConversationItemInput => ({ role: 'assistant', parts: [{ type: 'proposal', id: proposal.id, summary: proposal.summary.slice(0, 2_000), ops: [], state }] });

export interface KeepPlan {
  inputs: ConversationItemInput[];
  /** What the plan stores, to record once it is sent. */
  turns: string[];
  proposals: Array<[string, KeptState]>;
}

/**
 * What of the chat is to be stored now. A user turn goes at once; the assistant's once its reply has finished (`live`: the
 * last turn is still streaming); a proposal's later state goes as a marker. With `keeping` off, nothing.
 */
export function planKeeping(items: readonly ChatItem[], stored: Stored, options: { keeping: boolean; live: boolean }): KeepPlan {
  const plan: KeepPlan = { inputs: [], turns: [], proposals: [] };
  if (!options.keeping) return plan;
  const lastId = items.at(-1)?.id;
  for (const item of items) {
    if (!keepable(item)) continue;
    if (item.role === 'user') {
      if (stored.turns.has(item.id)) continue;
      plan.inputs.push(userInput(item));
      plan.turns.push(item.id);
      continue;
    }
    if (!stored.turns.has(item.id)) {
      if (options.live && item.id === lastId) break;
      const input = replyInput(item);
      // Nothing to keep: still counted, so a stopped, empty reply is not looked at again.
      plan.turns.push(item.id);
      if (!input) continue;
      plan.inputs.push(input);
      for (const part of item.parts) if (part.kind === 'proposal') plan.proposals.push([part.proposal.id, keptState(part.proposal.state)]);
      continue;
    }
    for (const part of item.parts) {
      if (part.kind !== 'proposal') continue;
      const now = keptState(part.proposal.state);
      const before = plan.proposals.findLast(([id]) => id === part.proposal.id)?.[1] ?? stored.proposals.get(part.proposal.id);
      if (before === undefined || before === now) continue;
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
}

// ---- reading a conversation back ------------------------------------------------------------------------------------

/**
 * The stored conversation as chat turns, all under "Earlier" (ids `k<seq>`). A marker item (only proposal parts, naming a
 * proposal an earlier item holds) is not a turn: its state replaces the one it names.
 */
export function restore(items: readonly ConversationItem[]): { items: ChatItem[]; stored: Stored } {
  const stored = emptyStored();
  const turns: ChatItem[] = [];
  const holders = new Map<string, Proposal>();
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
    const isMarker = proposals.length > 0 && proposals.length === item.parts.length && proposals.every((p) => holders.has(p.id));
    if (isMarker) {
      for (const p of proposals) {
        const held = holders.get(p.id)!;
        held.state = fromKept(p.state);
        stored.proposals.set(p.id, p.state);
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
  return { items: turns, stored };
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
