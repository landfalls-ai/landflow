/**
 * The flow as a list, for the phone's Steps view (docs/mobile.md#the-steps-view): steps in the order they run, read
 * from the triggers along the main connections, like a program's blocks:
 *
 * - A step with more than one way on (an If, a Switch) opens one indented group per branch, labelled with its output.
 * - A step that several steps lead into (a Merge, or one step two triggers share) is listed once all of them are, back
 *   at the depth of the step that split; so after a branch the main line goes on where it was.
 * - A connection back to a step already on the path (a loop) doesn't hold that step back: the step it comes from names
 *   it instead (`then`).
 * - Sub-nodes (a model, a tool, a memory, and the sub-nodes of those) are not steps: they ride on the step they serve.
 */
export interface StepNode {
  id: string;
  position: { x: number; y: number };
}
export interface StepEdge {
  source: string;
  target: string;
  /** "<connectionType>:<index>", as the canvas writes it; missing means "main:0". */
  sourceHandle?: string | null;
  connectionType: string;
}
export interface Step {
  id: string;
  /** How far in it sits: 0 for the main line, one more per branch it is on. */
  depth: number;
  /** The first step of a branch, or the one after a step with several outputs: that output's name. */
  branch?: string;
  /** Next steps listed earlier (a loop back), by id. */
  then: string[];
  /** Sub-nodes that serve this step, and theirs, by id. */
  attached: string[];
}
export interface StepLabels {
  /** The name of a step's main output ("true", "Done"…). */
  output?: (nodeId: string, output: number) => string;
  /** How many main outputs a step has: with more than one, every output it goes on from is named. */
  outputs?: (nodeId: string) => number;
}

const outputIndex = (handle?: string | null) => Number((handle ?? 'main:0').split(':')[1] ?? 0) || 0;
const byPlace = (a: StepNode, b: StepNode) => a.position.y - b.position.y || a.position.x - b.position.x;

export function stepOrder(nodes: StepNode[], edges: StepEdge[], labels: StepLabels = {}): Step[] {
  const name = labels.output ?? ((_id: string, i: number) => `Output ${i + 1}`);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const known = (e: StepEdge) => byId.has(e.source) && byId.has(e.target);

  // Sub-nodes: sources of non-main connections, collected under the step they serve, with their own sub-nodes.
  const servedBy = new Map<string, string[]>();
  const sub = new Set<string>();
  for (const e of edges) {
    if (e.connectionType === 'main' || !known(e) || e.source === e.target) continue;
    sub.add(e.source);
    const list = servedBy.get(e.target) ?? [];
    if (!list.includes(e.source)) servedBy.set(e.target, [...list, e.source]);
  }
  const attachedOf = (id: string) => {
    const out: string[] = [];
    const walk = (at: string) => {
      for (const s of servedBy.get(at) ?? []) if (s !== id && !out.includes(s)) out.push(s), walk(s);
    };
    walk(id);
    return out;
  };

  const main = edges.filter((e) => e.connectionType === 'main' && known(e) && !sub.has(e.target));
  const out = (id: string) =>
    main
      .filter((e) => e.source === id)
      .sort((a, b) => outputIndex(a.sourceHandle) - outputIndex(b.sourceHandle) || byPlace(byId.get(a.target)!, byId.get(b.target)!));
  const roots = nodes.filter((n) => !sub.has(n.id) && !main.some((e) => e.target === n.id && e.source !== n.id)).sort(byPlace);
  const rest = [...nodes].filter((n) => !sub.has(n.id)).sort(byPlace);

  // Loops: a connection to a step on the current path. They don't count as a way into that step.
  const back = new Set<StepEdge>();
  {
    const state = new Map<string, 'open' | 'done'>();
    const dfs = (id: string) => {
      state.set(id, 'open');
      for (const e of out(id)) {
        const s = state.get(e.target);
        if (s === 'open') back.add(e);
        else if (!s) dfs(e.target);
      }
      state.set(id, 'done');
    };
    for (const n of [...roots, ...rest]) if (!state.has(n.id)) dfs(n.id);
  }
  const waysIn = new Map<string, number>();
  for (const e of main) if (!back.has(e)) waysIn.set(e.target, (waysIn.get(e.target) ?? 0) + 1);
  const left = new Map(waysIn);

  const steps: Step[] = [];
  const seen = new Set<string>();
  /** Lists `id` and what follows it; returns the merges reached that the caller (a split or the top) lists. */
  const visit = (id: string, depth: number, branch?: string): string[] => {
    seen.add(id);
    const step: Step = { id, depth, branch, then: [], attached: attachedOf(id) };
    steps.push(step);
    const next = out(id);
    const named = (labels.outputs?.(id) ?? 1) > 1 || new Set(next.map((e) => outputIndex(e.sourceHandle))).size > 1;
    const fresh = next.filter((e) => !back.has(e) && !seen.has(e.target));
    const splits = fresh.length > 1;
    let merges: string[] = [];
    for (const e of next) {
      const target = e.target;
      if (back.has(e) || seen.has(target)) {
        if (!step.then.includes(target) && target !== id) step.then.push(target);
        continue;
      }
      if ((waysIn.get(target) ?? 0) > 1) {
        // A merge: one fewer way in to wait for.
        left.set(target, (left.get(target) ?? 1) - 1);
        if (!merges.includes(target)) merges.push(target);
        continue;
      }
      const label = named ? name(id, outputIndex(e.sourceHandle)) : undefined;
      merges = [...merges, ...visit(target, splits ? depth + 1 : depth, label).filter((m) => !merges.includes(m))];
    }
    return splits ? settle(merges, depth) : merges;
  };
  /** Lists the merges whose every way in is listed, at this depth; hands the others up. */
  const settle = (merges: string[], depth: number): string[] => {
    let pending = merges;
    for (;;) {
      const ready = pending.find((m) => !seen.has(m) && (left.get(m) ?? 0) <= 0);
      if (!ready) return pending.filter((m) => !seen.has(m));
      pending = [...pending.filter((m) => m !== ready), ...visit(ready, depth)];
    }
  };

  let pending: string[] = [];
  for (const n of roots) {
    if (seen.has(n.id)) continue;
    pending = settle([...pending, ...visit(n.id, 0)], 0);
  }
  // A merge whose other way in never comes (it starts inside a loop nothing reaches): list it anyway, in place order.
  for (const m of pending) if (!seen.has(m)) settle([...visit(m, 0)], 0);
  for (const n of rest) if (!seen.has(n.id)) settle(visit(n.id, 0), 0);
  return steps;
}
