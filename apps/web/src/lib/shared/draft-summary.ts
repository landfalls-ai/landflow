/**
 * The build summary (wave sb3, SB15; docs/assistant.md "Empty canvas"): what a first draft hands the person, in words:
 * the steps, what was assumed, what is left for them and what no node here can do. Read from the plan's words when the
 * draft has a plan, else from the nodes; never from the model's prose. Types and pure helpers only: no zod (the browser
 * loads it for the summary card), no I/O.
 */
import { planLines, type BuildPlan } from './build-plan';
import type { DraftLeft } from './draft-left';

export interface DraftSummary {
  /** Numbered lines, one per step: "2. Get issues (Linear)". */
  steps: string[];
  /** What was taken for granted, one line each (the plan's). */
  assumptions: string[];
  /** What the request asks that no node here can do (the plan's). */
  cannot: string[];
  /** What is left for the person, as the guarded draft has it. */
  left: DraftLeft[];
}

/** What a summary reads of a draft: the nodes and edges, the plan when there is one, and what the guards left. */
export interface SummarySource {
  nodes: Array<{ key: string; type: string; name: string }>;
  edges: Array<[string, string, number, string]>;
  plan?: BuildPlan;
  left?: DraftLeft[];
}

/** Node keys in edge order from the trigger (breadth first along `main`), each sub-node right after the node it serves; leftovers last. */
function orderedKeys(draft: SummarySource): string[] {
  const known = new Set(draft.nodes.map((n) => n.key));
  const main = draft.edges.filter(([from, to, , type]) => type === 'main' && known.has(from) && known.has(to));
  const subs = draft.edges.filter(([from, to, , type]) => type !== 'main' && known.has(from) && known.has(to));
  const subKeys = new Set(subs.map(([from]) => from));
  const order: string[] = [];
  const seen = new Set<string>();
  const add = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    order.push(key);
    for (const [from, to] of subs) if (to === key) add(from);
  };
  const roots = draft.nodes.filter((n) => !subKeys.has(n.key) && !main.some(([, to]) => to === n.key)).map((n) => n.key);
  const queue = [...roots];
  while (queue.length) {
    const key = queue.shift()!;
    if (seen.has(key)) continue;
    add(key);
    for (const [from, to] of main) if (from === key && !seen.has(to)) queue.push(to);
  }
  for (const n of draft.nodes) add(n.key);
  return order;
}

/** The summary of a draft. `label` names a node type ("Linear"); `left` is the guarded draft's whole list. */
export function draftSummary(draft: SummarySource, label: (type: string) => string = (type) => type): DraftSummary {
  const byKey = new Map(draft.nodes.map((n) => [n.key, n]));
  const steps = draft.plan
    ? planLines(draft.plan, label)
    : orderedKeys(draft).flatMap((key, index) => {
        const n = byKey.get(key);
        return n ? [`${index + 1}. ${n.name} (${label(n.type)})`] : [];
      });
  return { steps, assumptions: [...(draft.plan?.assumptions ?? [])], cannot: [...(draft.plan?.cannot ?? [])], left: [...(draft.left ?? [])] };
}

/** The summary in plain words: what the harness reads and the reply's copy text. */
export function summaryText(name: string, summary: DraftSummary): string {
  const count = summary.steps.length;
  const block = (title: string, lines: string[]) => (lines.length ? [title, ...lines] : []);
  return [
    `Built “${name}” in ${count} ${count === 1 ? 'step' : 'steps'}.`,
    ...block('Steps:', summary.steps),
    ...block('Assumed:', summary.assumptions.map((a) => `- ${a}`)),
    ...block('Left for you:', summary.left.map((l) => `- ${l.text}`)),
    ...block('Not possible here:', summary.cannot.map((c) => `- ${c}`)),
  ].join('\n');
}

/** Whether a parameter value holds anything (a person filled it): not unset, blank, or an empty list or object. */
export function isFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

/** The display name of a credential item's type, from the text the guard wrote ("“X” needs a Linear API credential: pick one"). */
export function credentialLabel(item: DraftLeft): string | undefined {
  return /needs an? (.+?) credential: pick one/.exec(item.text)?.[1];
}
