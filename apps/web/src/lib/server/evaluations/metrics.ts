/**
 * Evaluation metrics: the deterministic ones (exact match, contains, regex, JSON equality, numeric closeness,
 * string similarity, tools used), each a score from 0 to 1, and the LLM-as-judge ones (correctness,
 * helpfulness, faithfulness, a custom rubric), scored 1–5 by a chat model. Pure apart from the model call.
 */
import type { LanguageModel } from '@landflow/engine';
import { generateStructured, type JsonSchema } from '../nodes/structured';

/** A value as comparable text: strings as they are, everything else as JSON. */
export function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export interface TextOptions {
  caseSensitive?: boolean;
  /** Trim and collapse whitespace before comparing (default true). */
  normalizeWhitespace?: boolean;
}

function normalize(value: unknown, options: TextOptions = {}): string {
  let text = asText(value);
  if (options.normalizeWhitespace !== false) text = text.trim().replace(/\s+/g, ' ');
  return options.caseSensitive ? text : text.toLowerCase();
}

/** 1 when the texts are equal (after the options), else 0. */
export const exactMatch = (expected: unknown, actual: unknown, options: TextOptions = {}) => (normalize(expected, options) === normalize(actual, options) ? 1 : 0);

/** 1 when `actual` contains `expected`, else 0. An empty expectation always matches. */
export const contains = (expected: unknown, actual: unknown, options: TextOptions = {}) => (normalize(actual, options).includes(normalize(expected, options)) ? 1 : 0);

/** A pattern as written, or `/pattern/flags`. */
export function toRegExp(pattern: string, caseSensitive = true): RegExp {
  const literal = /^\/([\s\S]+)\/([dgimsuvy]*)$/.exec(pattern.trim());
  const flags = literal ? literal[2].replace(/g/g, '') : '';
  return new RegExp(literal ? literal[1] : pattern, caseSensitive || flags.includes('i') ? flags : `${flags}i`);
}

/** 1 when `actual` matches the pattern, else 0. */
export const regexMatch = (pattern: string, actual: unknown, caseSensitive = true) => (toRegExp(pattern, caseSensitive).test(asText(actual)) ? 1 : 0);

/** A JSON value from text (or the value itself when it isn't text). */
export function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(text);
  try {
    return JSON.parse(fence ? fence[1] : text);
  } catch {
    return value;
  }
}

/** Deep equality of JSON values; object key order doesn't matter, array order does. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((value, i) => deepEqual(value, other[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  const otherKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  return keys.length === otherKeys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]));
}

/** 1 when both sides parse to the same JSON value (text is parsed first), else 0. */
export const jsonEquality = (expected: unknown, actual: unknown) => (deepEqual(parseJson(expected), parseJson(actual)) ? 1 : 0);

/** The first number in a value: a number, or the first number written in a text ("about 42.5 km" → 42.5). */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const match = /-?\d+(?:[.,]\d+)?(?:e[-+]?\d+)?/i.exec(asText(value).replace(/(\d),(\d{3})\b/g, '$1$2'));
  if (!match) return undefined;
  const number = Number(match[0].replace(',', '.'));
  return Number.isFinite(number) ? number : undefined;
}

export interface NumericOptions {
  /** Allowed difference: an absolute amount, or a fraction of the expected value (`relative`). */
  tolerance?: number;
  relative?: boolean;
}

/**
 * Numeric closeness: 1 within the tolerance, otherwise 1 minus the relative error beyond it, floored at 0
 * (expected 100, actual 90, no tolerance → 0.9). 0 when either side has no number.
 */
export function numericCloseness(expected: unknown, actual: unknown, options: NumericOptions = {}): number {
  const e = toNumber(expected);
  const a = toNumber(actual);
  if (e === undefined || a === undefined) return 0;
  const tolerance = Math.max(0, Number(options.tolerance) || 0) * (options.relative ? Math.abs(e) : 1);
  const difference = Math.abs(a - e);
  if (difference <= tolerance + 1e-12) return 1;
  const scale = Math.abs(e) || 1;
  return Math.max(0, 1 - (difference - tolerance) / scale);
}

/** Levenshtein edit distance (two rows). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length];
}

/** String similarity: 1 − edit distance ÷ the longer length (1 = identical, 0 = nothing in common). */
export function stringSimilarity(expected: unknown, actual: unknown, options: TextOptions = {}): number {
  const a = normalize(expected, options);
  const b = normalize(actual, options);
  const longest = Math.max(a.length, b.length);
  if (!longest) return 1;
  return 1 - editDistance(a, b) / longest;
}

/** A list of names from a comma- or newline-separated text, an array, or n8n/Landflow agent steps. */
export function namesOf(value: unknown): string[] {
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) {
    return parsed
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object') {
          const step = entry as { tool?: unknown; name?: unknown; action?: { tool?: unknown } };
          return asText(step.tool ?? step.action?.tool ?? step.name);
        }
        return asText(entry);
      })
      .map((name) => name.trim())
      .filter(Boolean);
  }
  return asText(parsed)
    .split(/[,\n]/)
    .map((name) => name.trim())
    .filter(Boolean);
}

const toolKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Tools used: the share of the expected tools that were called (names compared without case and punctuation). 1 when none are expected. */
export function toolsUsed(expected: unknown, called: string[]): number {
  const wanted = [...new Set(namesOf(expected).map(toolKey))].filter(Boolean);
  if (!wanted.length) return 1;
  const used = new Set(called.map(toolKey));
  return wanted.filter((name) => used.has(name)).length / wanted.length;
}

// ---------------------------------------------------------------------------
// LLM as judge
// ---------------------------------------------------------------------------

export type JudgeMetric = 'correctness' | 'helpfulness' | 'faithfulness' | 'rubric';

export interface JudgeInput {
  question?: string;
  expected?: unknown;
  actual: unknown;
  /** Faithfulness: the passages the answer must stay within. */
  context?: unknown;
  /** Rubric: what a good answer looks like. */
  rubric?: string;
  /** Replaces the metric's instructions (the scale and the JSON format are always added). */
  instructions?: string;
}

export interface JudgeResult {
  /** 1–5. */
  score: number;
  reasoning: string;
}

const SCALE = `Score on a scale from 1 to 5:
5 = fully meets the criterion; 4 = meets it with minor gaps; 3 = partly meets it; 2 = mostly fails it; 1 = fails it completely.`;

const INSTRUCTIONS: Record<JudgeMetric, string> = {
  correctness:
    'You are a strict evaluator. Compare the ACTUAL answer with the EXPECTED answer (the ground truth) and judge factual correctness: does the actual answer state the same facts, without contradicting or omitting what matters? Wording, length and style do not matter; wrong or missing facts do.',
  helpfulness:
    'You are an evaluator of assistant replies. Judge how helpful the ACTUAL answer is for the user’s QUESTION: does it address what was asked, completely and clearly, with useful detail and without irrelevant content?',
  faithfulness:
    'You are an evaluator of grounded answers. Judge whether every claim in the ACTUAL answer is supported by the CONTEXT. Claims not found in the context, or contradicting it, lower the score, even if they are true in general.',
  rubric: 'You are an evaluator of an AI agent’s replies. Grade the agent’s REPLY in the CONVERSATION against the RUBRIC.',
};

const JUDGE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    reasoning: { type: 'string', description: 'One to three sentences explaining the score' },
    // Untyped: some models send "4"; the checks below read it as a number.
    score: { description: 'An integer from 1 to 5' },
  },
  required: ['score'],
};

const scoreOf = (raw: unknown) => Number((raw as { score?: unknown } | null)?.score);

/** The judge's prompt for a metric. */
export function judgePrompt(metric: JudgeMetric, input: JudgeInput): string {
  const sections: string[] = [];
  const add = (label: string, value: unknown) => {
    const text = asText(value).trim();
    if (text) sections.push(`${label}:\n${text.length > 12_000 ? `${text.slice(0, 12_000)}…` : text}`);
  };
  if (metric === 'rubric') {
    add('RUBRIC', input.rubric);
    add('CONVERSATION', input.question);
    add('REPLY', input.actual);
  } else {
    add('QUESTION', input.question);
    if (metric === 'correctness') add('EXPECTED', input.expected);
    if (metric === 'faithfulness') add('CONTEXT', input.context);
    add('ACTUAL', input.actual);
  }
  return sections.join('\n\n');
}

/** Ask the model for a 1–5 score with its reasoning (JSON, validated, one retry). */
export async function judge(model: LanguageModel, metric: JudgeMetric, input: JudgeInput, signal?: AbortSignal): Promise<JudgeResult> {
  const system = `${input.instructions?.trim() || INSTRUCTIONS[metric]}\n\n${SCALE}\n\nAnswer with a JSON object {"reasoning": "...", "score": <1-5>} and nothing else.`;
  const { value } = await generateStructured<{ reasoning?: string; score: number }>(model, {
    system,
    prompt: judgePrompt(metric, input),
    schema: JUDGE_SCHEMA,
    check: (raw) => {
      const score = scoreOf(raw);
      return Number.isFinite(score) && score >= 0.5 && score < 5.5 ? [] : ['score must be a number from 1 to 5'];
    },
    // 4.5 asks once more for a whole number, then rounds.
    soft: (raw) => (Number.isInteger(scoreOf(raw)) ? [] : ['score must be a whole number']),
    ...(signal && { signal }),
  }).catch(async (error) => {
    // A reply that isn't valid JSON but names a score ("Score: 4") still counts.
    const fallback = await scoreFromText(model, system, judgePrompt(metric, input), signal).catch(() => undefined);
    if (fallback) return { value: fallback };
    throw error;
  });
  return { score: clampScore(value.score), reasoning: String(value.reasoning ?? '').trim() };
}

/** Last resort for models that ignore the JSON format: a plain reply with "score: N". */
async function scoreFromText(model: LanguageModel, system: string, prompt: string, signal?: AbortSignal): Promise<{ reasoning: string; score: number } | undefined> {
  const turn = await model.generate({ system, messages: [{ role: 'user', content: prompt }], tools: [], ...(signal && { signal }) });
  const match = /score["'\s:=]*([1-5](?:\.\d+)?)/i.exec(turn.text) ?? /\b([1-5])\s*\/\s*5\b/.exec(turn.text);
  return match ? { score: Number(match[1]), reasoning: turn.text.replace(/<think>[\s\S]*?<\/think>/g, '').trim().slice(0, 500) } : undefined;
}

export const clampScore = (value: unknown) => Math.min(5, Math.max(1, Math.round(Number(value) || 1)));
