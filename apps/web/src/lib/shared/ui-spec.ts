/**
 * Model-written UI specs for Run Trace cards (docs/research/json-render-verdict.md). A spec is untrusted model output, so it is
 * checked here before json-render ever sees it: a closed catalog of three leaf cards (Status, Diff, Approval), strict props
 * (only the named fields, plain strings, capped lengths, no `{ $state }`-style expressions, no URLs or HTML), no children, no
 * state and no actions. An element of an unknown type, or with props that fail, is dropped and reported; nothing is ever
 * executed. The Approval card only points at an approval that already exists: deciding it stays on the approval path.
 * Behind the json-render setting (Settings → General; LANDFLOW_JSON_RENDER is its default; off otherwise).
 */
import { z } from 'zod';

/**
 * The flag. `saved` is the instance setting (Settings → General, `jsonRender`): when set it wins. Unset, the environment
 * decides: `LANDFLOW_JSON_RENDER=1` (server) or `NEXT_PUBLIC_LANDFLOW_JSON_RENDER=1` (inlined at build, so the browser
 * sees it too). The browser passes the value GET /api/settings reports (`jsonRender`), never a build-time constant alone.
 */
export function jsonRenderEnabled(saved?: boolean): boolean {
  if (typeof saved === 'boolean') return saved;
  return process.env.LANDFLOW_JSON_RENDER === '1' || process.env.NEXT_PUBLIC_LANDFLOW_JSON_RENDER === '1';
}

const MAX_ELEMENTS = 8;
const MAX_DIFF_LINES = 200;

/** Plain text: a bounded string with no control characters (React draws it as text, never as markup). */
const text = (max: number) => z.string().max(max).refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s), 'control characters');
const TONES = ['ok', 'warn', 'bad', 'neutral'] as const;

export const statusProps = z.strictObject({
  title: text(120),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'waiting']),
  detail: text(500).optional(),
  tone: z.enum(TONES).optional(),
});
export const diffProps = z.strictObject({
  path: text(200),
  lines: z.array(z.strictObject({ kind: z.enum(['add', 'del', 'ctx']), text: text(400) })).max(MAX_DIFF_LINES),
});
export const approvalProps = z.strictObject({
  title: text(120),
  summary: text(500),
  /** The id of the approval wait in the run: the card names it, it cannot decide it. */
  approvalId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  risk: z.enum(['low', 'medium', 'high']).optional(),
});

/** The catalog: component name to its props schema. The one place a new card type is added. */
export const CARD_PROPS = { Status: statusProps, Diff: diffProps, Approval: approvalProps } as const;
export type CardType = keyof typeof CARD_PROPS;
export type StatusProps = z.infer<typeof statusProps>;
export type DiffProps = z.infer<typeof diffProps>;
export type ApprovalProps = z.infer<typeof approvalProps>;

export const CARD_DESCRIPTIONS: Record<CardType, string> = {
  Status: 'A status card: a title, a status word, an optional detail line.',
  Diff: 'A diff card: a file path and its changed lines (add, del or ctx).',
  Approval: 'An approval card: what is waiting for a person and how risky it is. Display only; it cannot decide.',
};

export interface UiSpec {
  root: string;
  elements: Record<string, { type: CardType; props: Record<string, unknown> }>;
}
export interface ParsedSpec {
  /** The safe spec to render, or null when nothing in it can be shown. */
  spec: UiSpec | null;
  /** Why parts were dropped (unknown component, bad props, extra fields), for logs and the card's plain-text note. */
  problems: string[];
}

const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate an untrusted spec (an object, or JSON text). Only `root` and `elements[*].type/props` are read: `state`,
 * `children`, `slots`, `visible`, `on` and every other field is ignored, so none of json-render's expressions or actions can
 * reach the renderer. The root must be a valid card; the result holds that card alone (cards are leaves).
 */
export function parseUiSpec(input: unknown): ParsedSpec {
  const problems: string[] = [];
  let raw = input;
  if (typeof raw === 'string') {
    if (raw.length > 100_000) return { spec: null, problems: ['spec too large'] };
    try {
      raw = JSON.parse(raw);
    } catch {
      return { spec: null, problems: ['not JSON'] };
    }
  }
  if (!isRecord(raw) || typeof raw.root !== 'string' || !isRecord(raw.elements)) return { spec: null, problems: ['needs a root and elements'] };
  const entries = Object.entries(raw.elements);
  if (entries.length > MAX_ELEMENTS) problems.push(`more than ${MAX_ELEMENTS} elements: the rest are ignored`);
  const elements: UiSpec['elements'] = {};
  for (const [key, el] of entries.slice(0, MAX_ELEMENTS)) {
    if (!KEY.test(key)) {
      problems.push('bad element key');
      continue;
    }
    if (!isRecord(el) || typeof el.type !== 'string') {
      problems.push(`${key}: not an element`);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(CARD_PROPS, el.type)) {
      problems.push(`${key}: unknown component "${el.type.slice(0, 40)}" ignored`);
      continue;
    }
    const type = el.type as CardType;
    const parsed = CARD_PROPS[type].safeParse(el.props ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      problems.push(`${key}: ${type} props rejected (${issue?.path.join('.') || 'props'}: ${issue?.message})`);
      continue;
    }
    elements[key] = { type, props: parsed.data };
  }
  if (!Object.prototype.hasOwnProperty.call(elements, raw.root)) return { spec: null, problems: [...problems, 'the root is not a valid card'] };
  return { spec: { root: raw.root, elements: { [raw.root]: elements[raw.root] } }, problems };
}
