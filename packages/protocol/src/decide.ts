/**
 * The Decide node's questions as the parameters hold them, shared by the server (which runs them) and the editor
 * (which draws the node's outputs): a Choice question's options and a Score question's levels are one line each in a
 * text field, `name: description`, and the node's outputs follow the options of the question it routes by.
 */

/** What a decision model takes in one request (the System One API: docs/features/ai.md#decide). */
export const DECIDE_LIMITS = { questions: 64, options: 26, nameChars: 40, /** The state, serialised: what one call may carry (about 8k tokens). */ stateChars: 32_000 } as const;

export type DecideQuestionType = 'choice' | 'yesno' | 'score';

/** A parameter name, and so a key of the node's `decision` output. */
export const DECIDE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
/** `model` is a field of `decision` itself. */
const RESERVED = new Set(['model']);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface DecideLine {
  name: string;
  description?: string;
}

/** `billing: Charges and refunds` per line; blank lines are skipped. Only the first colon splits. */
export function parseDecideLines(text: unknown): DecideLine[] {
  if (typeof text !== 'string') return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const colon = line.indexOf(':');
      const name = (colon < 0 ? line : line.slice(0, colon)).trim();
      const description = colon < 0 ? '' : line.slice(colon + 1).trim();
      return description ? { name, description } : { name };
    });
}

/** Why an option name cannot be a key of the answer, or undefined when it can. */
export function optionNameProblem(name: string): string | undefined {
  if (!name) return 'an option has no name';
  // The Choice routing's own last output is called that.
  if (name.toLowerCase() === UNSURE_LABEL.toLowerCase()) return `an option cannot be called “${UNSURE_LABEL}”: that is the output for answers the model is not sure of`;
  if (name.length > DECIDE_LIMITS.nameChars) return `the option "${name.slice(0, 12)}…" is longer than ${DECIDE_LIMITS.nameChars} characters`;
  if (UNSAFE_KEYS.has(name)) return `"${name}" cannot be an option name`;
  return undefined;
}

export function questionNameProblem(name: string): string | undefined {
  if (!DECIDE_NAME.test(name)) return `the question name "${name}" must start with a letter and use letters, digits and _`;
  if (name.length > DECIDE_LIMITS.nameChars) return `the question name "${name}" is longer than ${DECIDE_LIMITS.nameChars} characters`;
  if (RESERVED.has(name)) return `"${name}" is reserved: the answer's model name is called that`;
  return undefined;
}

/** The questions as the form stores them: a fixedCollection `{ question: [...] }`. */
export function decideQuestions(value: unknown): Array<Record<string, unknown>> {
  const list = (value as { question?: unknown } | undefined)?.question;
  return Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
}

export interface DecideRouting {
  kind: 'none' | 'choice' | 'yesno';
  /** The question routed by (blank for none). */
  question?: string;
  /** The output names in order; the last of a choice routing is "Unsure". */
  labels: string[];
}

export const UNSURE_LABEL = 'Unsure';

/** The outputs the node shows for these parameters. Unfinished questions leave the single output. */
export function decideRouting(parameters: Record<string, unknown>): DecideRouting {
  const route = typeof parameters.routeBy === 'string' ? parameters.routeBy.trim() : '';
  const question = route ? decideQuestions(parameters.questions).find((q) => String(q.name ?? '').trim() === route) : undefined;
  if (question?.type === 'yesno') return { kind: 'yesno', question: route, labels: ['Yes', 'No'] };
  if (question?.type === 'choice') {
    const names = parseDecideLines(question.options).map((o) => o.name).filter((n, i, all) => n && all.indexOf(n) === i);
    if (names.length >= 2) return { kind: 'choice', question: route, labels: [...names.slice(0, DECIDE_LIMITS.options), UNSURE_LABEL] };
  }
  return { kind: 'none', labels: ['Decided'] };
}

/**
 * Connections of a Decide node's main outputs, after its parameters changed from `oldParams` to `newParams`: each
 * connection stays on the output of the same name (an option, Unsure, Yes, No), moves with it when the numbering
 * changes, and is removed when that name is gone. A Choice with the same number of options as before and one new
 * name is a rename: the connection stays on its place. `connections` are this node's outgoing main connections.
 */
export function remapExpandedConnections<C extends { sourceIndex?: number }>(oldParams: Record<string, unknown>, newParams: Record<string, unknown>, connections: C[]): C[] {
  const before = decideRouting(oldParams);
  const after = decideRouting(newParams);
  const target = new Map<number, number>();
  before.labels.forEach((label, index) => {
    const found = after.labels.indexOf(label);
    if (found >= 0) target.set(index, found);
  });
  if (before.kind === after.kind && before.kind === 'choice' && before.labels.length === after.labels.length) {
    const taken = new Set(target.values());
    const lost = before.labels.map((_l, i) => i).filter((i) => !target.has(i));
    const fresh = after.labels.map((_l, i) => i).filter((i) => !taken.has(i));
    if (lost.length === 1 && fresh.length === 1 && lost[0] === fresh[0]) target.set(lost[0], fresh[0]);
  }
  return connections.flatMap((c) => {
    const to = target.get(c.sourceIndex ?? 0);
    return to === undefined ? [] : [{ ...c, sourceIndex: to }];
  });
}

/** How many main outputs a Decide node shows for `parameters`. */
export const decideOutputCount = (parameters: Record<string, unknown>) => decideRouting(parameters).labels.length;
