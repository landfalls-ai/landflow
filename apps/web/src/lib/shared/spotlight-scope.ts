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
const ADDS = /\b(?:add|adds|adding|insert|put|create|append|attach|another|then|next|send|email|notify|post (?:a|an|the|it|this|that|to)|filter|branch|loop|follow(?:ed)? with|use an? (?!different\b|other\b|new (?:url|value|header|key|token)\b)|new (?:step|node|agent))\b/i;

/** "only that one node", "just this step", "nothing else": the selected step and nothing more. */
const ONLY_SELECTED = /\b(?:only|just) (?:(?:that|this|the selected|the) )?(?:one )?(?:node|step)\b|\bonly (?:it|that one|this one)\b|\bnothing else\b/i;

/** Words of a fix or a failure: a message with them and no adding verb locates a step, it does not add one. */
const FIXING = /\b(?:fix(?:es|ed)?|fail(?:s|ed|ing|ure)?|errors?|broke|broken|breaks|wrong|[45]\d\d)\b/i;

/** "the step after Code", "what happens after", "right after": "after" locates a step, it does not say where a new one goes. */
const LOCATING = /\b(?:step|node|call|one|request)\s+(?:right\s+)?(?:after|before)\b|\bwhat\s+(?:comes|happens|runs|follows)\s+(?:right\s+)?(?:after|before)\b|\bright\s+(?:after|before)\b/i;

/** "the step after this", "what comes after Code": names ANOTHER step by its position, so the selection is only a landmark. */
const NAMES_NEIGHBOUR = /\b(?:the|a|an)\s+(?:step|node|call|one|request)\s+(?:right\s+)?(?:after|before)\b|\b(?:previous|prior|preceding|following|next|upstream|downstream)\s+(?:step|node|call|one|request)\b|\bwhat\s+(?:comes|happens|runs|follows)\s+(?:right\s+)?(?:after|before)\b/i;

/** Whether the message asks for a new step. Pass the canvas steps and a step named with a common verb ("Post to Slack") does not count. */
export function asksToAdd(message: string, nodes: readonly ScopeNode[] = []): boolean {
  let text = message;
  for (const node of [...nodes].sort((a, b) => b.name.length - a.name.length)) {
    if (node.name.trim().length < 3) continue;
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(node.name.trim())}(?![\\p{L}\\p{N}])`, 'giu'), ' ');
  }
  return ADDS.test(text);
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
function insertionPoint(message: string, nodes: readonly ScopeNode[], selectedId?: string): { node: ScopeNode; side: 'after' | 'before' } | undefined {
  // "after Code" / "after this" is where the next step goes even without an adding verb ("remove duplicate items after Code"),
  // unless it only locates a step ("the step after Code fails with 401, fix it", "it breaks right after this").
  if (!asksToAdd(message, nodes) && (FIXING.test(message) || LOCATING.test(message))) return undefined;
  const deictic = /\b(after|before)\s+(?:this|that|it)(?:\s+(?:step|node|one))?\b/i.exec(message);
  const selectedNode = selectedId ? nodes.find((n) => n.id === selectedId) : undefined;
  if (deictic && selectedNode && namedNodes(message, nodes).every((n) => n.id === selectedNode.id)) return { node: selectedNode, side: deictic[1].toLowerCase() === 'after' ? 'after' : 'before' };
  const found: Array<{ node: ScopeNode; side: 'after' | 'before' }> = [];
  for (const node of namedNodes(message, nodes)) {
    const pattern = new RegExp(`\\b(after|before|in front of)\\s+(?:the\\s+)?(?:step\\s+|node\\s+)?["“'‘]?${escape(node.name.trim())}(?![\\p{L}\\p{N}])`, 'iu');
    const match = pattern.exec(message);
    if (match) found.push({ node, side: match[1].toLowerCase() === 'after' ? 'after' : 'before' });
  }
  // A message that names another step too ("remove Check, then add a new Check after Code") is about more than the new step: no scope.
  return found.length === 1 && namedNodes(message, nodes).every((n) => n.id === found[0].node.id) ? found[0] : undefined;
}

/**
 * The scope of a typed request, or `undefined` (none: the change may touch any step, as before wave sb2). In order:
 * the person lifted the chip (`sent: null`) → none; the editor sent one → that one, with the ids that still exist;
 * "only"/"just" with named steps → `only` those; "only that one node" / "nothing else" with a selection → `only` it;
 * steps tagged with @ → `tagged` those; a new step after or before one named step (and no other step named) → `insert`; a selection, when the
 * message names no other step, adds none and does not name a neighbour by position ("the step after this fails") → `selected`. A test-and-fix session's `fix` and `review` requests have no
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
  if (/\b(?:only|just)\b/i.test(message) && named.length && !asksToAdd(message, nodes)) return { kind: 'only', nodes: named.map((n) => n.id) };
  if (selected && ONLY_SELECTED.test(message)) return { kind: 'only', nodes: [selected] };
  const tagged = (request.taggedIds ?? []).filter(exists);
  if (tagged.length) return { kind: 'tagged', nodes: [...new Set(tagged)] };
  const point = insertionPoint(message, nodes, selected);
  if (point) return { kind: 'insert', nodes: [point.node.id], side: point.side };
  if (selected && !asksToAdd(message, nodes) && !NAMES_NEIGHBOUR.test(message) && named.every((n) => n.id === selected)) return { kind: 'selected', nodes: [selected] };
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
 * - a `connect` or `disconnect` whose two ends are scope steps, steps these ops add, or the neighbours of the scope
 *   (for `insert`, the anchor's own on its `side`; for the other kinds, when the message adds a step): the step it fed,
 *   or the step that fed it, is rewired to the new one;
 * - `setWorkflowSettings` under `selected` (the scope the selection gives on its own, never asked for in words): a request
 *   about the whole workflow ("stop the workflow if it runs longer than 5 minutes") is made with a step selected or open;
 *   under `only`, `tagged` and `insert` it is outside;
 * - anything else: outside.
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
  // The same holds for a new step added beside a scope step under the other kinds: the neighbour it takes over is rewired.
  const neighbours = new Set(anchor ? (side === 'after' ? main.filter((c) => c.source === anchor).map((c) => c.target) : main.filter((c) => c.target === anchor).map((c) => c.source)) : asksToAdd(message, workflow.nodes) ? main.filter((c) => inScope.has(c.source) || inScope.has(c.target)).flatMap((c) => [c.source, c.target]) : []);
  const scopeNames = scope.nodes.map((id) => `“${nameOf(id)}”`).join(', ');
  const where = anchor ? `the new step goes ${side} “${nameOf(anchor)}”` : `the request is about ${scopeNames}`;
  const mayAdd = anchor !== undefined || asksToAdd(message, workflow.nodes);
  const endOk = (ref: string | undefined) => isAdded(ref) || (() => {
    const id = idOf(ref);
    return id !== undefined && (anchor ? id === anchor || neighbours.has(id) : inScope.has(id) || neighbours.has(id));
  })();
  const out: Array<{ index: number; reason: string }> = [];
  // A step added outside the scope is left out, so a rewire to it is too (else the second pass drops it as an unknown ref).
  const outsideAdded = new Set<string>();
  const isOutsideAdded = (ref: string | undefined) => ref !== undefined && outsideAdded.has(ref);
  // Connections last: they depend on which added steps stay.
  const ordered = ops.map((op, index) => ({ op, index })).sort((a, b) => Number(a.op.op === 'connect' || a.op.op === 'disconnect') - Number(b.op.op === 'connect' || b.op.op === 'disconnect') || a.index - b.index);
  ordered.forEach(({ op, index }) => {
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
        const left = () => {
          for (const r of [op.ref, op.name]) if (r) outsideAdded.add(r);
          say(label);
        };
        if (!mayAdd || !at) return left();
        if (isAdded(at.ref)) return isOutsideAdded(at.ref) ? left() : undefined;
        const id = idOf(at.ref);
        if (anchor !== undefined ? id !== anchor || at.side !== side : !id || !inScope.has(id)) left();
        return;
      }
      case 'connect':
      case 'disconnect':
        if (isOutsideAdded(op.from) || isOutsideAdded(op.to) || !endOk(op.from) || !endOk(op.to) || (!anchor && ![op.from, op.to].some((r) => isAdded(r) || inScope.has(idOf(r) ?? '')))) say(`${op.op === 'connect' ? 'connecting' : 'disconnecting'} “${op.from ?? '?'}” → “${op.to ?? '?'}”`);
        return;
      case 'setWorkflowSettings':
        if (scope.kind !== 'selected') say(op.op);
        return;
      default:
        say(op.op);
    }
  });
  return out.sort((a, b) => a.index - b.index);
}
