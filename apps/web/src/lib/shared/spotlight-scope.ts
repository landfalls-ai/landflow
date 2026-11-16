/**
 * The scope of a change: which existing steps a typed request may change (wave sb2, finding 2.4: "only this node" was
 * sent but never checked). A request about one step carries one: the selected step, the steps tagged with @, the steps
 * named with "only", or the step a new one goes after or before. Spotlight's chat sends a change outside it back once,
 * then leaves it out and lists it; the composer shows the scope as a chip ("Only “Open status incident”") the person
 * can lift.
 *
 * Contract file: backbone/contracts/sb2/spotlight-scope.ts, copied byte for byte to
 * apps/web/src/lib/shared/spotlight-scope.ts by SB07 (owner), SB10 and SB11 (backbone/contracts/sb2/scope.md says who
 * calls what). Change it in the contracts folder first. Pure: no imports, no zod, no I/O; the browser loads it (the
 * composer's chip) and the server (lib/server/assistant/chat.ts) reads the same rules.
 */

/**
 * - `selected`: the step selected in the editor, when the message names no other step and adds none;
 * - `tagged`: the canvas steps tagged with @ in the message;
 * - `only`: the steps the message names with "only" or "just" (or the selected one: "only that one node", "nothing else");
 * - `insert`: a request to add a step after or before one named step: new steps go there, existing ones stay as they are.
 */
export type ScopeKind = 'selected' | 'tagged' | 'only' | 'insert';

export interface SpotlightScope {
  kind: ScopeKind;
  /** Node ids of the existing steps the change may edit; for `insert`, the one step the new ones go after or before. */
  nodes: string[];
  /** `insert`: which side of `nodes[0]` the new steps go on. */
  side?: 'after' | 'before';
}

export interface ScopeNode {
  id: string;
  name: string;
}

export interface ScopeConnection {
  source: string;
  target: string;
  type?: string;
}

/** What `scopeOf` reads. */
export interface ScopeRequest {
  /** What the editor sent: a scope; `null` when the person lifted the chip; absent when it sent none (API callers). */
  sent?: SpotlightScope | null;
  /** The latest message the person typed. */
  message: string;
  nodes: readonly ScopeNode[];
  /** The selected (or open) step, unless the person took it out of the context. */
  selectedId?: string;
  /** Steps of this canvas the person tagged with @, by id. */
  taggedIds?: readonly string[];
}

/** The fields of an edit operation this file reads (an `AssistantOp` fits it). */
export interface ScopeOp {
  op: string;
  ref?: string;
  name?: string;
  node?: string;
  from?: string;
  to?: string;
  after?: string;
  before?: string;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Words that ask for a new step ("add a retry step", "insert a Set", "put an agent after …"). */
const ADDS = /\b(?:add|adds|adding|insert|put|create|append|attach|another|new (?:step|node|agent))\b/i;

/** "only that one node", "just this step", "nothing else": the selected step and nothing more. */
const ONLY_SELECTED = /\b(?:only|just) (?:(?:that|this|the selected|the) )?(?:one )?(?:node|step)\b|\bonly (?:it|that one|this one)\b|\bnothing else\b/i;

/** Whether the message asks for a new step. */
export function asksToAdd(message: string): boolean {
  return ADDS.test(message);
}

/**
 * The steps a message names, by whole name (case-insensitive; quoted or not), longest first, each once. Names shorter
 * than three characters are never matched ("If" is in too many sentences); a name inside a longer named one counts once.
 */
export function namedNodes(message: string, nodes: readonly ScopeNode[]): ScopeNode[] {
  const spans: Array<{ node: ScopeNode; start: number; end: number }> = [];
  for (const node of [...nodes].sort((a, b) => b.name.length - a.name.length)) {
    if (node.name.trim().length < 3) continue;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escape(node.name.trim())}(?![\\p{L}\\p{N}])`, 'giu');
    for (const match of message.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (spans.some((s) => start >= s.start && end <= s.end)) continue;
      spans.push({ node, start, end });
    }
  }
  const seen = new Set<string>();
  return spans.sort((a, b) => a.start - b.start).flatMap((s) => (seen.has(s.node.id) ? [] : (seen.add(s.node.id), [s.node])));
}

/** "after “Sample question”", "before Post to Slack": the one step a new one goes beside, when the message adds one. */
function insertionPoint(message: string, nodes: readonly ScopeNode[]): { node: ScopeNode; side: 'after' | 'before' } | undefined {
  if (!asksToAdd(message)) return undefined;
  const found: Array<{ node: ScopeNode; side: 'after' | 'before' }> = [];
  for (const node of namedNodes(message, nodes)) {
    const pattern = new RegExp(`\\b(after|before|in front of)\\s+(?:the\\s+)?(?:step\\s+|node\\s+)?["“'‘]?${escape(node.name.trim())}(?![\\p{L}\\p{N}])`, 'iu');
    const match = pattern.exec(message);
    if (match) found.push({ node, side: match[1].toLowerCase() === 'after' ? 'after' : 'before' });
  }
  return found.length === 1 ? found[0] : undefined;
}

/**
 * The scope of a typed request, or `undefined` (none: the change may touch any step, as before wave sb2). In order:
 * the person lifted the chip (`sent: null`) → none; the editor sent one → that one, with the ids that still exist;
 * "only"/"just" with named steps → `only` those; "only that one node" / "nothing else" with a selection → `only` it;
 * steps tagged with @ → `tagged` those; a new step after or before one named step → `insert`; a selection, when the
 * message names no other step and adds none → `selected`. A test-and-fix session's `fix` and `review` requests have no
 * scope (the session's own `wastedFix` rule applies there): callers pass only typed messages (`auto` is typed).
 */
export function scopeOf(request: ScopeRequest): SpotlightScope | undefined {
  const { sent, message, nodes } = request;
  if (sent === null) return undefined;
  const exists = (id: string) => nodes.some((n) => n.id === id);
  if (sent) {
    const kept = sent.nodes.filter(exists);
    return kept.length ? { kind: sent.kind, nodes: kept, ...(sent.kind === 'insert' && { side: sent.side ?? 'after' }) } : undefined;
  }
  const named = namedNodes(message, nodes);
  const selected = request.selectedId && exists(request.selectedId) ? request.selectedId : undefined;
  if (/\b(?:only|just)\b/i.test(message) && named.length && !asksToAdd(message)) return { kind: 'only', nodes: named.map((n) => n.id) };
  if (selected && ONLY_SELECTED.test(message)) return { kind: 'only', nodes: [selected] };
  const tagged = (request.taggedIds ?? []).filter(exists);
  if (tagged.length) return { kind: 'tagged', nodes: [...new Set(tagged)] };
  const point = insertionPoint(message, nodes);
  if (point) return { kind: 'insert', nodes: [point.node.id], side: point.side };
  if (selected && !asksToAdd(message) && named.every((n) => n.id === selected)) return { kind: 'selected', nodes: [selected] };
  return undefined;
}

/** The chip's words: "Only “Open status incident”", "Only “A” and “B”", "New step after “Sample question”". */
export function scopeLabel(scope: SpotlightScope, nodes: readonly ScopeNode[]): string {
  const names = scope.nodes.map((id) => `“${nodes.find((n) => n.id === id)?.name ?? id}”`);
  if (scope.kind === 'insert') return `New step ${scope.side ?? 'after'} ${names[0]}`;
  const list = names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `Only ${list}`;
}

/**
 * The ops of a proposal that reach outside `scope`, by index, each with one line saying so. Refs are names, ids or the
 * `ref` of a step these ops add. Inside:
 * - an edit of an existing step (`setParameters`, `setNodeSettings`, `renameNode`, `removeNode`, `turnIntoTeam`) when
 *   the step is in `scope.nodes` (never for `insert`: there the existing steps stay as they are);
 * - an `addNode` (a new agent too) placed after or before a scope step or a step these ops add: for `insert`, only on
 *   its `side` of the anchor; for the other kinds, only when the message asks for a new step;
 * - a `connect` or `disconnect` whose two ends are scope steps, steps these ops add, or (for `insert`) the anchor's own
 *   neighbours on its `side` (the step it fed, or the step that fed it, is rewired to the new one);
 * - `setWorkflowSettings` and anything else: outside.
 */
export function outsideScope(
  ops: readonly ScopeOp[],
  scope: SpotlightScope,
  workflow: { nodes: readonly ScopeNode[]; connections: readonly ScopeConnection[] },
  message: string,
): Array<{ index: number; reason: string }> {
  const idOf = (ref: string | undefined) => (ref === undefined ? undefined : (workflow.nodes.find((n) => n.name === ref || n.id === ref) ?? workflow.nodes.find((n) => n.name.toLowerCase() === ref.toLowerCase()))?.id);
  const nameOf = (id: string) => workflow.nodes.find((n) => n.id === id)?.name ?? id;
  const added = new Set(ops.flatMap((op) => (op.op === 'addNode' ? [op.ref, op.name].filter((r): r is string => Boolean(r)) : [])));
  const isAdded = (ref: string | undefined) => ref !== undefined && added.has(ref) && !idOf(ref);
  const inScope = new Set(scope.nodes);
  const anchor = scope.kind === 'insert' ? scope.nodes[0] : undefined;
  const side = scope.side ?? 'after';
  const main = workflow.connections.filter((c) => (c.type ?? 'main') === 'main');
  // For `insert`: the steps beside the anchor on its side may be rewired to the new step.
  const neighbours = new Set(anchor ? (side === 'after' ? main.filter((c) => c.source === anchor).map((c) => c.target) : main.filter((c) => c.target === anchor).map((c) => c.source)) : []);
  const scopeNames = scope.nodes.map((id) => `“${nameOf(id)}”`).join(', ');
  const where = anchor ? `the new step goes ${side} “${nameOf(anchor)}”` : `the request is about ${scopeNames}`;
  const mayAdd = anchor !== undefined || asksToAdd(message);
  const endOk = (ref: string | undefined) => isAdded(ref) || (() => {
    const id = idOf(ref);
    return id !== undefined && (anchor ? id === anchor || neighbours.has(id) : inScope.has(id));
  })();
  const out: Array<{ index: number; reason: string }> = [];
  ops.forEach((op, index) => {
    const say = (what: string) => out.push({ index, reason: `${what}: outside what was asked (${where})` });
    switch (op.op) {
      case 'setParameters':
      case 'setNodeSettings':
      case 'renameNode':
      case 'removeNode':
      case 'turnIntoTeam': {
        const id = idOf(op.node);
        if (anchor !== undefined || !id || !inScope.has(id)) say(`${op.op} on “${id ? nameOf(id) : (op.node ?? '?')}”`);
        return;
      }
      case 'addNode': {
        const at = op.after !== undefined ? { ref: op.after, side: 'after' as const } : op.before !== undefined ? { ref: op.before, side: 'before' as const } : undefined;
        const label = `adding “${op.name ?? op.ref ?? 'a step'}”`;
        if (!mayAdd || !at) return say(label);
        if (isAdded(at.ref)) return;
        const id = idOf(at.ref);
        if (anchor !== undefined ? id !== anchor || at.side !== side : !id || !inScope.has(id)) say(label);
        return;
      }
      case 'connect':
      case 'disconnect':
        if (!endOk(op.from) || !endOk(op.to)) say(`${op.op === 'connect' ? 'connecting' : 'disconnecting'} “${op.from ?? '?'}” → “${op.to ?? '?'}”`);
        return;
      default:
        say(op.op);
    }
  });
  return out;
}
