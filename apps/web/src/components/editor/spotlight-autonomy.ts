/**
 * When Spotlight may act alone: the user's decision D1 (2026-11-16) and constitution notes 21 and 23.
 *
 * Contract file: backbone/contracts/sb1/spotlight-autonomy.ts, copied byte for byte to
 * apps/web/src/components/editor/spotlight-autonomy.ts by SB04 (owner) and SB03. Change it in the contracts folder first.
 *
 * Autonomous (the "Autonomous" side of Spotlight's switch) only while Spotlight builds a brand-new draft: a workflow
 * this tab opened with no nodes and that has never been published. A saved workflow (opened with nodes: autosave of
 * the new draft does not count, a reload does) or a published one is asks-first: Spotlight shows the change and waits
 * for Apply. Even on a brand-new draft a change that removes a step, or leaves one without its input, waits for a click.
 * A workflow this tab knows nothing about is asks-first.
 */
import { create } from 'zustand';

export type Autonomy = 'auto' | 'asks-first';

export interface AutonomyFacts {
  /** The person's switch (Autonomous / Asks first), as ./autonomous.ts keeps it. */
  switchOn: boolean;
  /** This tab opened the workflow with no nodes: Spotlight is building it now. */
  bornEmpty: boolean;
  /** The workflow has a published version (read when it opened, or published from this tab since). */
  published: boolean;
}

/** The rule itself (D1). */
export function autonomyFor(facts: AutonomyFacts): Autonomy {
  return facts.switchOn && facts.bornEmpty && !facts.published ? 'auto' : 'asks-first';
}

interface Opened {
  bornEmpty: boolean;
  published: boolean;
}

interface AutonomyState {
  /** Mirrors ./autonomous.ts's switch (on by default there too); SB04 keeps it in step. */
  switchOn: boolean;
  /** What this tab knows of each workflow it opened, by id. */
  workflows: Record<string, Opened>;
}

export const useAutonomyFacts = create<AutonomyState>(() => ({ switchOn: true, workflows: {} }));

/** The editor opened `workflowId` holding `nodeCount` nodes. Only the first call for an id in this tab counts. */
export function noteOpened(workflowId: string, nodeCount: number): void {
  if (!workflowId) return;
  useAutonomyFacts.setState((s) => (s.workflows[workflowId] ? s : { workflows: { ...s.workflows, [workflowId]: { bornEmpty: nodeCount === 0, published: false } } }));
}

/** The workflow has a published version: read when it opened, or published from this tab. */
export function notePublished(workflowId: string): void {
  if (!workflowId) return;
  useAutonomyFacts.setState((s) => ({ workflows: { ...s.workflows, [workflowId]: { bornEmpty: s.workflows[workflowId]?.bornEmpty ?? false, published: true } } }));
}

/** The person moved the switch. */
export function noteSwitch(on: boolean): void {
  useAutonomyFacts.setState({ switchOn: on });
}

/** What Spotlight may do on `workflowId` now. */
export function autonomyOf(workflowId: string): Autonomy {
  const { switchOn, workflows } = useAutonomyFacts.getState();
  const known = workflows[workflowId];
  return autonomyFor({ switchOn, bornEmpty: known?.bornEmpty ?? false, published: known?.published ?? true });
}

/** The fields of an op this rule reads (AssistantOp is assignable to it). */
export interface ChangeOp {
  op: string;
  node?: string;
  from?: string;
  to?: string;
  type?: string;
  settings?: object;
}

/** The canvas before the change: node ids and names, and its connections. */
export interface ChangeGraph {
  nodes: ReadonlyArray<{ id: string; name: string }>;
  connections: ReadonlyArray<{ source: string; target: string; type?: string }>;
}

/**
 * The removals an autonomous fix session may make without a click (the person's decision of 2026-11-18): a step the session
 * itself added (`own`, node ids) and a step that plainly duplicates what the bound agent does (`duplicates`: node id to the
 * agent's name, from `dropRepeatedAgentWork`). Anything else, a step the person built included, still waits.
 */
export interface RemovalsAllowed {
  own?: ReadonlySet<string>;
  duplicates?: ReadonlyMap<string, string>;
}

/** The ids of the steps these ops remove that `allowed` lets go without a click. */
function allowedGone(ops: readonly ChangeOp[], before: ChangeGraph, allowed: RemovalsAllowed | undefined): Map<string, string> {
  const gone = new Map<string, string>();
  if (!allowed) return gone;
  for (const op of ops) {
    if (op.op !== 'removeNode') continue;
    const node = op.node ? before.nodes.find((n) => n.name === op.node || n.id === op.node) : undefined;
    if (!node) continue;
    if (allowed.own?.has(node.id)) gone.set(node.id, `Removed “${node.name}”: this session added it`);
    else if (allowed.duplicates?.has(node.id)) gone.set(node.id, `Removed “${node.name}”: “${allowed.duplicates.get(node.id)}” does it itself`);
  }
  return gone;
}

/** The timeline's line for each removal that went through without a click, with its reason. */
export function removedWithoutClick(ops: readonly ChangeOp[], before: ChangeGraph, allowed: RemovalsAllowed | undefined): string[] {
  return [...allowedGone(ops, before, allowed).values()];
}

/**
 * Why a change needs the person's click even where Spotlight may act alone: it removes an existing step, turns one off
 * (a step the goal does not name is no less the person's), or it disconnects one so that it is left without any main
 * input (and the same change does not connect it again). Empty when nothing needs a click. Each reason is a short clause for
 * the card: "removes “Notify VIP”". `allowed` (an autonomous fix session only) lets two removals through: see `RemovalsAllowed`.
 */
export function needsAClick(ops: readonly ChangeOp[], before: ChangeGraph, allowed?: RemovalsAllowed): string[] {
  const find = (ref: string | undefined) => (ref ? before.nodes.find((n) => n.name === ref || n.id === ref) : undefined);
  const isMain = (type: string | undefined) => (type ?? 'main') === 'main';
  const gone = allowedGone(ops, before, allowed);
  const reasons: string[] = [];
  for (const op of ops) {
    if (op.op === 'removeNode') {
      const node = find(op.node);
      if (node && !gone.has(node.id)) reasons.push(`removes “${node.name}”`);
    } else if (op.op === 'setNodeSettings' && (op.settings as { disabled?: boolean } | undefined)?.disabled === true) {
      const node = find(op.node);
      if (node) reasons.push(`turns off “${node.name}”`);
    } else if (op.op === 'disconnect' && isMain(op.type)) {
      const source = find(op.from);
      const target = find(op.to);
      if (!source || !target) continue;
      if (gone.has(target.id) || allowed?.own?.has(target.id)) continue; // a step that is going, or the session's own
      const others = before.connections.filter((c) => c.target === target.id && isMain(c.type) && c.source !== source.id);
      const reconnected = ops.some((o) => o.op === 'connect' && isMain(o.type) && find(o.to)?.id === target.id);
      if (!others.length && !reconnected) reasons.push(`leaves “${target.name}” without its input`);
    }
  }
  return [...new Set(reasons)];
}
