/**
 * The code editor's editing logic (code-editor.tsx), pure and without the DOM so it can be tested: bracket matching,
 * auto-closing of brackets and quotes, search and replace over the text, and the decorations (matches, brackets) that
 * the highlight layer draws over the tokens. Nothing here knows about the textarea; the component applies what these
 * functions return.
 */
import { inStringOrComment, type CodeLanguage, type Token, type TokenKind } from './code-highlight';

// ---------------------------------------------------------------------------
// Bracket matching
// ---------------------------------------------------------------------------

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
/** Brackets inside these tokens belong to a string, comment or `{{ }}` expression, not to the code's structure. */
const LITERAL: ReadonlySet<TokenKind> = new Set(['string', 'comment', 'expression', 'brace']);
/** Past this length the scan for a partner is skipped (a paste of a huge file shouldn't stall typing). */
const MAX_SCAN = 200_000;

/** 1 for each character that sits inside a literal token. */
function literalMask(length: number, tokens: readonly Token[]): Uint8Array {
  const mask = new Uint8Array(length);
  let at = 0;
  for (const token of tokens) {
    const end = Math.min(length, at + token.text.length);
    if (LITERAL.has(token.kind)) mask.fill(1, at, end);
    at += token.text.length;
  }
  return mask;
}

export interface BracketMatch {
  /** The bracket next to the caret, and its partner (undefined: no partner, drawn as a mismatch). */
  at: number;
  partner?: number;
}

/**
 * The bracket touching the caret (the one before it first, as editors do) and its partner. Brackets in strings,
 * comments and `{{ }}` don't count. Only the same kind of bracket is counted while scanning, so `( [ )` still pairs
 * its parentheses.
 */
export function matchBracket(text: string, caret: number, tokens: readonly Token[]): BracketMatch | undefined {
  if (text.length > MAX_SCAN) return undefined;
  const mask = literalMask(text.length, tokens);
  const isLiteral = (offset: number) => mask[offset] === 1;
  for (const at of [caret - 1, caret]) {
    const c = text[at];
    if (c === undefined || (!PAIRS[c] && !CLOSERS[c]) || isLiteral(at)) continue;
    if (PAIRS[c]) {
      let depth = 0;
      for (let i = at; i < text.length; i++) {
        if (text[i] !== c && text[i] !== PAIRS[c]) continue;
        if (isLiteral(i)) continue;
        depth += text[i] === c ? 1 : -1;
        if (depth === 0) return { at, partner: i };
      }
    } else {
      const opener = CLOSERS[c];
      let depth = 0;
      for (let i = at; i >= 0; i--) {
        if (text[i] !== c && text[i] !== opener) continue;
        if (isLiteral(i)) continue;
        depth += text[i] === c ? 1 : -1;
        if (depth === 0) return { at, partner: i };
      }
    }
    return { at };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Auto-close
// ---------------------------------------------------------------------------

/** What to do to the text: replace `from`–`to` with `insert`, then put the selection at `select`. */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
  select: [number, number];
}

const QUOTES: Record<CodeLanguage, string> = { javascript: '\'"`', python: '\'"', json: '"', plain: '' };
const WORD = /[\w$]/;
/** After these (or whitespace, or the end) an opening bracket is closed automatically. */
const CLOSE_BEFORE = /^[\s)\]}>,;:.]?$/;

/**
 * What typing `key` does with the selection `start`–`end`: the pair for an opening bracket or quote (wrapping the
 * selection when there is one), a step over a closing character that is already there, or nothing (the browser types
 * the key). Pairs are not made inside strings and comments, and a quote after a word character (an apostrophe, or the
 * end of a Python prefix) or before one stays single.
 */
export function autoCloseEdit(text: string, start: number, end: number, key: string, language: CodeLanguage, tokens: readonly Token[]): TextEdit | undefined {
  if (language === 'plain' || key.length !== 1) return undefined;
  const quotes = QUOTES[language];
  const opens = Boolean(PAIRS[key]);
  const quote = quotes.includes(key);
  const closes = Boolean(CLOSERS[key]);
  if (!opens && !quote && !closes) return undefined;
  const next = text[end];
  if (start !== end) {
    if (!opens && !quote) return undefined;
    const close = opens ? PAIRS[key] : key;
    return { from: start, to: end, insert: `${key}${text.slice(start, end)}${close}`, select: [start + 1, end + 1] };
  }
  // Typing the closing character that is already next: step over it.
  if ((closes || quote) && next === key) {
    return { from: start, to: start, insert: '', select: [start + 1, start + 1] };
  }
  if (closes) return undefined;
  if (inStringOrComment(tokens, start)) return undefined;
  if (opens) {
    if (!CLOSE_BEFORE.test(next ?? '')) return undefined;
    return { from: start, to: start, insert: key + PAIRS[key], select: [start + 1, start + 1] };
  }
  const before = text[start - 1] ?? '';
  if (WORD.test(before) || before === key || (next !== undefined && (WORD.test(next) || next === key))) return undefined;
  return { from: start, to: start, insert: key + key, select: [start + 1, start + 1] };
}

/** Backspace between an empty pair (`()`, `[]`, `{}`, `''`, `""`, ` `` `) takes both characters. */
export function backspaceEdit(text: string, start: number, end: number, language: CodeLanguage): TextEdit | undefined {
  if (language === 'plain' || start !== end || start === 0) return undefined;
  const open = text[start - 1];
  const close = text[start];
  const pair = (PAIRS[open] === close && close !== undefined) || (QUOTES[language].includes(open) && open === close);
  if (!pair) return undefined;
  return { from: start - 1, to: start + 1, insert: '', select: [start - 1, start - 1] };
}

// ---------------------------------------------------------------------------
// Search and replace
// ---------------------------------------------------------------------------

export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

export interface SearchMatch {
  from: number;
  to: number;
  /** The regular expression's match, for `$1` in the replacement. */
  groups: RegExpExecArray;
}

export const MAX_MATCHES = 5000;

function searchPattern(query: string, options: SearchOptions): RegExp {
  const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(options.wholeWord ? `\\b(?:${source})\\b` : source, `gm${options.caseSensitive ? '' : 'i'}`);
}

/** Every match of `query` in `text` (empty matches skipped, at most MAX_MATCHES); a bad regular expression is `error`. */
export function searchMatches(text: string, query: string, options: SearchOptions = {}): { matches: SearchMatch[]; error?: string; truncated?: boolean } {
  if (!query) return { matches: [] };
  let pattern: RegExp;
  try {
    pattern = searchPattern(query, options);
  } catch (error) {
    return { matches: [], error: (error as Error).message.replace(/^Invalid regular expression: /, '') };
  }
  const matches: SearchMatch[] = [];
  for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
    if (found[0] === '') {
      pattern.lastIndex++;
      continue;
    }
    if (matches.length >= MAX_MATCHES) return { matches, truncated: true };
    matches.push({ from: found.index, to: found.index + found[0].length, groups: found });
  }
  return { matches };
}

/** The replacement for one match: `$&`, `$1`…`$99`, `$<name>` and `$$` in regular-expression mode, the text as is otherwise. */
export function expandReplacement(match: SearchMatch, replacement: string, options: SearchOptions = {}): string {
  if (!options.regex) return replacement;
  const { groups } = match;
  return replacement.replace(/\$(\$|&|\d{1,2}|<[^>]*>)/g, (all, token: string) => {
    if (token === '$') return '$';
    if (token === '&') return groups[0];
    if (token.startsWith('<')) return groups.groups?.[token.slice(1, -1)] ?? '';
    const index = Number(token);
    return index > 0 && index < groups.length ? (groups[index] ?? '') : all;
  });
}

/** `text` with every match replaced. */
export function replaceAllMatches(text: string, matches: readonly SearchMatch[], replacement: string, options: SearchOptions = {}): string {
  let out = '';
  let at = 0;
  for (const match of matches) {
    out += text.slice(at, match.from) + expandReplacement(match, replacement, options);
    at = match.to;
  }
  return out + text.slice(at);
}

/** Index of the match to go to from `caret`: the first starting at or after it (the last one ending before it, going back); wraps. */
export function stepMatch(matches: readonly SearchMatch[], caret: number, direction: 1 | -1, from = caret): number {
  if (!matches.length) return -1;
  if (direction === 1) {
    const index = matches.findIndex((match) => match.from >= caret);
    return index < 0 ? 0 : index;
  }
  for (let i = matches.length - 1; i >= 0; i--) if (matches[i].to <= from) return i;
  return matches.length - 1;
}

// ---------------------------------------------------------------------------
// Decorations
// ---------------------------------------------------------------------------

export type MarkKind = 'match' | 'current' | 'bracket' | 'unmatched';

export interface Mark {
  from: number;
  to: number;
  kind: MarkKind;
}

export interface Piece {
  kind: TokenKind;
  text: string;
  /** What covers this piece (a search match, a bracket…). */
  marks: MarkKind[];
}

/** The tokens cut wherever a mark starts or ends, each piece with the marks that cover it. Their text still joins to the input. */
export function decorate(tokens: readonly Token[], marks: readonly Mark[]): Piece[] {
  if (!marks.length) return tokens.map((token) => ({ ...token, marks: [] }));
  const sorted = [...marks].sort((a, b) => a.from - b.from);
  const cuts = [...new Set(sorted.flatMap((mark) => [mark.from, mark.to]))].sort((a, b) => a - b);
  const pieces: Piece[] = [];
  let nextMark = 0;
  let active: Mark[] = [];
  let cut = 0;
  let at = 0;
  for (const token of tokens) {
    const end = at + token.text.length;
    let from = at;
    while (from < end) {
      while (cut < cuts.length && cuts[cut] <= from) cut++;
      const to = cut < cuts.length ? Math.min(end, cuts[cut]) : end;
      while (nextMark < sorted.length && sorted[nextMark].from <= from) active.push(sorted[nextMark++]);
      active = active.filter((mark) => mark.to > from);
      pieces.push({ kind: token.kind, text: token.text.slice(from - at, to - at), marks: active.map((mark) => mark.kind) });
      from = to;
    }
    at = end;
  }
  return pieces;
}
