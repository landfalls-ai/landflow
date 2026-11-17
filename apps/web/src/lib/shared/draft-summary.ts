/**
 * The build summary (wave sb3, SB15; docs/assistant.md "Empty canvas"): what a first draft hands the person, in words:
 * the steps, what was assumed, what is left for them and what no node here can do. Read from the plan's words when the
 * draft has a plan, else from the nodes; never from the model's prose. Types and pure helpers only: no zod (the browser
 * loads it for the summary card), no I/O.
 */
import { planLines, type BuildPlan } from './build-plan';
import type { PropertyDescriptor } from '@landflow/protocol';
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

const plain = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Nothing in it: unset, '', or lists and objects of only such values. */
export function isBlank(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.every(isBlank)) || (plain(v) && Object.values(v).every(isBlank));
}

/** A row with nothing in it: every value blank, or an option still at its default. */
function rowEmpty(fields: PropertyDescriptor[] | undefined, row: unknown): boolean {
  if (!plain(row)) return isBlank(row);
  return Object.entries(row).every(([k, v]) => {
    const f = fields?.find((x) => x.name === k);
    if (f?.type === 'options' && v === f.default) return true;
    return f?.type === 'fixedCollection' && f.groups ? collectionEmpty(f, v) : isBlank(v);
  });
}

/** A fixedCollection's value with no usable row: missing, `{}`, or only empty rows (the guard's own emptiness). */
function collectionEmpty(p: PropertyDescriptor, value: unknown): boolean {
  if (isBlank(value)) return true;
  if (!plain(value)) return false;
  return Object.entries(value).every(([name, rows]) => (Array.isArray(rows) ? rows : [rows]).every((row) => rowEmpty(p.groups?.find((g) => g.name === name)?.values, row)));
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether a person filled a parameter. Blank, an empty list or only empty rows is not filled, and neither is a value
 * still equal to the descriptor's default (the canvas put it there, not the person).
 */
export function fieldEmpty(property: PropertyDescriptor | undefined, value: unknown): boolean {
  if (property?.type === 'fixedCollection' && property.groups) {
    if (collectionEmpty(property, value)) return true;
  } else if (isBlank(value)) return true;
  return property?.default !== undefined && !isBlank(property.default) && same(value, property.default);
}

/** The list a step type cannot work without, for a left row that names no field (a hollow If, Filter or Set). */
export function neededField(type: string): string | undefined {
  if (type === 'core.if' || type === 'core.filter') return 'conditions';
  if (type === 'core.set') return 'fields';
  return undefined;
}

/** The display name of a credential item's type, from the text the guard wrote ("“X” needs a Linear API credential: pick one"). */
export function credentialLabel(item: DraftLeft): string | undefined {
  return /needs an? (.+?) credential: pick one/.exec(item.text)?.[1];
}
