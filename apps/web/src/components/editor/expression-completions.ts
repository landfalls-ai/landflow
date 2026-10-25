/**
 * Autocomplete for `{{ expressions }}` in the parameter editor. Given the text,
 * the caret and sample data (the node's input items, upstream nodes' last
 * output, variable names), it works out what is being typed (`$json.us…`,
 * `$('Na…`, `$now.to…`) and returns the matching fields, methods and
 * variables. Pure functions: the input component (expression-input.tsx) only
 * renders the result.
 */

export interface CompletionData {
  /** A sample of `$json`: the first input items merged. */
  json?: unknown;
  /** Nodes `$('Name')` can refer to (upstream first), with a sample of their output's first item. */
  nodes: Array<{ name: string; json?: unknown }>;
  /** `$vars` names. */
  vars: string[];
}

export interface Completion {
  label: string;
  /** Replaces the text from `from` to `to`. */
  insert: string;
  kind: 'variable' | 'field' | 'method' | 'node' | 'keyword';
  /** Type and sample value, or what it does. */
  detail?: string;
  /** Caret offset inside `insert` after accepting (default: its end). */
  caret?: number;
  /** Replace the `.` before the partial too (bracket access for keys that aren't identifiers). */
  replaceDot?: boolean;
  /** Show completions again after accepting (e.g. node names after `$('`). */
  reopen?: boolean;
}

export interface CompletionResult {
  from: number;
  to: number;
  items: Completion[];
  /** Why there is nothing to suggest (no data yet). */
  hint?: string;
}

export type Segment = { text: string; kind: 'text' | 'brace' | 'code' };

/** Split a value into plain text and `{{ code }}` parts for highlighting (an unclosed `{{` highlights to the end). */
export function expressionSegments(value: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < value.length) {
    const open = value.indexOf('{{', i);
    if (open < 0) {
      out.push({ text: value.slice(i), kind: 'text' });
      break;
    }
    if (open > i) out.push({ text: value.slice(i, open), kind: 'text' });
    const close = value.indexOf('}}', open + 2);
    out.push({ text: '{{', kind: 'brace' });
    if (close < 0) {
      if (open + 2 < value.length) out.push({ text: value.slice(open + 2), kind: 'code' });
      break;
    }
    if (close > open + 2) out.push({ text: value.slice(open + 2, close), kind: 'code' });
    out.push({ text: '}}', kind: 'brace' });
    i = close + 2;
  }
  return out;
}

/** The code between the `{{` that encloses `caret` and the caret, or undefined when the caret is outside an expression. */
export function expressionAt(value: string, caret: number): { start: number; code: string } | undefined {
  const before = value.slice(0, caret);
  const open = before.lastIndexOf('{{');
  if (open < 0 || before.indexOf('}}', open) >= 0) return undefined;
  return { start: open + 2, code: before.slice(open + 2) };
}

// ---- abstract values: what a path points at, as far as the sample data tells ----

type Abstract =
  | { kind: 'value'; sample: unknown; known: boolean }
  | { kind: 'accessor'; items: unknown[] }
  | { kind: 'item'; json: unknown }
  | { kind: 'date' }
  | { kind: 'vars'; names: string[] }
  | { kind: 'unknown' };

const value = (sample: unknown, known = true): Abstract => ({ kind: 'value', sample, known });
const IDENT = /^[A-Za-z_$][\w$]*$/;

function typeOf(sample: unknown): string {
  if (Array.isArray(sample)) return `array[${sample.length}]`;
  if (sample === null) return 'null';
  return typeof sample;
}

function preview(sample: unknown): string {
  if (typeof sample === 'string') return JSON.stringify(sample.length > 40 ? `${sample.slice(0, 40)}…` : sample);
  if (typeof sample === 'number' || typeof sample === 'boolean' || sample === null) return String(sample);
  return '';
}

function detailOf(sample: unknown) {
  const p = preview(sample);
  return p ? `${typeOf(sample)} · ${p}` : typeOf(sample);
}

const STRING_METHODS: Array<[string, string, string?]> = [
  ['length', 'number of characters'],
  ['toUpperCase()', 'UPPER CASE'],
  ['toLowerCase()', 'lower case'],
  ['trim()', 'without surrounding spaces'],
  ['split(\',\')', 'to an array', "split('"],
  ['replace(\'\', \'\')', 'replace the first match', "replace('"],
  ['replaceAll(\'\', \'\')', 'replace every match', "replaceAll('"],
  ['includes(\'\')', 'true if it contains the text', "includes('"],
  ['startsWith(\'\')', 'true if it starts with the text', "startsWith('"],
  ['endsWith(\'\')', 'true if it ends with the text', "endsWith('"],
  ['slice(0, 10)', 'part of the text'],
  ['padStart(2, \'0\')', 'pad to a length'],
  ['match(/\\d+/)', 'regular expression match'],
];
const ARRAY_METHODS: Array<[string, string, string?]> = [
  ['length', 'number of entries'],
  ['[0]', 'first entry'],
  ['at(-1)', 'last entry'],
  ['join(\', \')', 'to text', "join('"],
  ['map(x => x)', 'transform each entry', 'map(x => '],
  ['filter(x => x)', 'keep matching entries', 'filter(x => '],
  ['find(x => x)', 'first matching entry', 'find(x => '],
  ['includes()', 'true if it contains a value', 'includes('],
  ['slice(0, 5)', 'part of the array'],
  ['indexOf()', 'position of a value', 'indexOf('],
];
const NUMBER_METHODS: Array<[string, string, string?]> = [
  ['toFixed(2)', 'text with 2 decimals'],
  ['toString()', 'to text'],
  ['toLocaleString()', 'formatted for the locale'],
  ['toPrecision(3)', 'significant digits'],
];
const DATE_METHODS: Array<[string, string, string?]> = [
  ['toISOString()', '2026-10-25T14:30:00.000Z'],
  ['toLocaleString()', 'date and time for the locale'],
  ['toLocaleDateString()', 'date for the locale'],
  ['toLocaleTimeString()', 'time for the locale'],
  ['getTime()', 'milliseconds since 1970'],
  ['getFullYear()', 'year'],
  ['getMonth()', 'month, 0–11'],
  ['getDate()', 'day of the month'],
  ['getDay()', 'weekday, 0 = Sunday'],
  ['getHours()', 'hour'],
  ['getMinutes()', 'minutes'],
];
const ACCESSOR_MEMBERS: Array<[string, string]> = [
  ['item', 'the item paired with the current one'],
  ['json', "the paired item's data"],
  ['first()', 'the first item'],
  ['last()', 'the last item'],
  ['all()', 'every item'],
];
const GLOBALS: Array<[string, string, string?]> = [
  ['JSON.stringify()', 'value to JSON text', 'JSON.stringify('],
  ['JSON.parse()', 'JSON text to a value', 'JSON.parse('],
  ['Math.round()', 'round a number', 'Math.round('],
  ['Math.max()', 'largest number', 'Math.max('],
  ['Object.keys()', 'the keys of an object', 'Object.keys('],
  ['Date.now()', 'milliseconds since 1970'],
  ['String()', 'to text', 'String('],
  ['Number()', 'to a number', 'Number('],
];

/** A method list entry → completion; `upTo` puts the caret after that prefix (inside the parentheses or quotes). */
function methods(list: Array<[string, string, string?]>): Completion[] {
  return list.map(([label, detail, upTo]) => ({ label, insert: label, kind: label.endsWith(')') ? 'method' : 'field', detail, ...(upTo && { caret: upTo.length }) }));
}

/** What a method call on a sample returns, roughly, so `$json.name.toUpperCase().` keeps suggesting string methods. */
function callResult(target: Abstract, name: string): Abstract {
  if (target.kind === 'accessor') {
    if (name === 'first') return { kind: 'item', json: target.items[0] };
    if (name === 'last') return { kind: 'item', json: target.items.at(-1) };
    if (name === 'all') return value(target.items.map((json) => ({ json })), target.items.length > 0);
    return { kind: 'unknown' };
  }
  if (target.kind === 'date') return /^to/.test(name) ? value('') : value(0);
  if (target.kind !== 'value') return { kind: 'unknown' };
  const sample = target.sample;
  if (typeof sample === 'string') {
    if (name === 'split' || name === 'match') return value(['']);
    if (['includes', 'startsWith', 'endsWith'].includes(name)) return value(true);
    if (name === 'indexOf' || name === 'search') return value(0);
    return value('');
  }
  if (Array.isArray(sample)) {
    if (['map', 'filter', 'slice', 'concat', 'reverse', 'sort', 'flat'].includes(name)) return value(name === 'map' ? [] : sample, name !== 'map');
    if (name === 'join') return value('');
    if (name === 'at' || name === 'find') return value(sample[0], sample.length > 0);
    if (name === 'includes' || name === 'some' || name === 'every') return value(true);
    return value(0);
  }
  if (typeof sample === 'number') return value(name.startsWith('to') ? '' : 0);
  return { kind: 'unknown' };
}

function member(target: Abstract, key: string): Abstract {
  switch (target.kind) {
    case 'accessor':
      if (key === 'item') return { kind: 'item', json: target.items[0] };
      if (key === 'json') return value(target.items[0], target.items.length > 0);
      return { kind: 'unknown' };
    case 'item':
      return key === 'json' ? value(target.json, target.json !== undefined) : { kind: 'unknown' };
    case 'vars':
      return value('');
    case 'value': {
      const sample = target.sample;
      if (key === 'length' && (typeof sample === 'string' || Array.isArray(sample))) return value(sample.length);
      if (Array.isArray(sample)) return /^\d+$/.test(key) ? value(sample[Number(key)] ?? sample[0], sample.length > 0) : { kind: 'unknown' };
      if (sample && typeof sample === 'object') return key in sample ? value((sample as Record<string, unknown>)[key]) : { kind: 'unknown' };
      return { kind: 'unknown' };
    }
    default:
      return { kind: 'unknown' };
  }
}

function rootValue(root: string, data: CompletionData): Abstract {
  const node = /^\$\(\s*(['"`])(.*)\1\s*\)$/.exec(root);
  if (node) {
    const found = data.nodes.find((n) => n.name === node[2]);
    return { kind: 'accessor', items: found && found.json !== undefined ? [found.json] : [] };
  }
  switch (root) {
    case '$json':
      return value(data.json, data.json !== undefined);
    case '$input':
      return { kind: 'accessor', items: data.json !== undefined ? [data.json] : [] };
    case '$now':
    case '$today':
      return { kind: 'date' };
    case '$workflow':
      return value({ id: 'wf_…', name: '…' });
    case '$execution':
      return value({ id: '…', mode: 'manual' });
    case '$itemIndex':
      return value(0);
    case '$vars':
      return { kind: 'vars', names: data.vars };
    default:
      return { kind: 'unknown' };
  }
}

/** `$json.user["first name"].length` → ['$json', 'user', 'first name', 'length'] with calls marked `name()`. */
function splitPath(path: string): string[] | undefined {
  const parts: string[] = [];
  const root = /^(\$\(\s*(['"`])(?:(?!\2).)*\2\s*\)|\$?[A-Za-z_][\w$]*)/.exec(path);
  if (!root) return undefined;
  parts.push(root[1]);
  let rest = path.slice(root[0].length);
  const step = /^(?:\.([A-Za-z_$][\w$]*)|\[\s*(\d+|'[^']*'|"[^"]*")\s*\]|\(([^()]*)\))/;
  while (rest) {
    const m = step.exec(rest);
    if (!m) return undefined;
    if (m[1] !== undefined) parts.push(m[1]);
    else if (m[2] !== undefined) parts.push(/^\d+$/.test(m[2]) ? m[2] : m[2].slice(1, -1));
    else parts[parts.length - 1] += '()';
    rest = rest.slice(m[0].length);
  }
  return parts;
}

function evaluatePath(path: string, data: CompletionData): Abstract {
  const parts = splitPath(path);
  if (!parts) return { kind: 'unknown' };
  let current = rootValue(parts[0], data);
  for (const part of parts.slice(1)) {
    current = part.endsWith('()') ? callResult(current, part.slice(0, -2)) : member(current, part);
    if (current.kind === 'unknown') break;
  }
  return current;
}

function membersOf(target: Abstract): { items: Completion[]; hint?: string } {
  switch (target.kind) {
    case 'accessor':
      return { items: ACCESSOR_MEMBERS.map(([label, detail]) => ({ label, insert: label, kind: label.endsWith(')') ? 'method' : 'field', detail })) };
    case 'item':
      return { items: [{ label: 'json', insert: 'json', kind: 'field', detail: "the item's data" }] };
    case 'date':
      return { items: methods(DATE_METHODS) };
    case 'vars':
      return target.names.length
        ? { items: target.names.map((name) => ({ label: name, insert: name, kind: 'variable', detail: 'variable', replaceDot: !IDENT.test(name) })) }
        : { items: [], hint: 'No variables yet: add them in Settings → Variables.' };
    case 'value': {
      const sample = target.sample;
      if (!target.known) return { items: [], hint: 'No data yet: run the previous nodes to get field suggestions.' };
      if (typeof sample === 'string') return { items: methods(STRING_METHODS) };
      if (typeof sample === 'number') return { items: methods(NUMBER_METHODS) };
      if (typeof sample === 'boolean') return { items: [{ label: 'toString()', insert: 'toString()', kind: 'method', detail: 'to text' }] };
      if (Array.isArray(sample)) return { items: methods(ARRAY_METHODS) };
      if (sample && typeof sample === 'object') {
        return {
          items: Object.entries(sample as Record<string, unknown>).map(([key, entry]) => ({
            label: key,
            insert: IDENT.test(key) ? key : `[${JSON.stringify(key).replace(/^"|"$/g, "'")}]`,
            replaceDot: !IDENT.test(key),
            kind: 'field',
            detail: detailOf(entry),
          })),
        };
      }
      return { items: [] };
    }
    default:
      return { items: [] };
  }
}

function rootCompletions(data: CompletionData): Completion[] {
  const roots: Completion[] = [
    { label: '$json', insert: '$json', kind: 'variable', detail: data.json !== undefined ? "the current item's data" : 'the current item (no data yet)' },
    { label: '$input', insert: '$input', kind: 'variable', detail: "this node's input items" },
    { label: "$('…')", insert: "$('", kind: 'variable', detail: "another node's output", reopen: true },
    ...data.nodes.map<Completion>((n) => ({ label: `$('${n.name}')`, insert: `$('${n.name.replaceAll("'", "\\'")}').item.json`, kind: 'node', detail: n.json !== undefined ? 'output of the node' : 'has not run yet' })),
    { label: '$now', insert: '$now', kind: 'variable', detail: 'current date and time' },
    { label: '$today', insert: '$today', kind: 'variable', detail: 'today at midnight' },
    { label: '$itemIndex', insert: '$itemIndex', kind: 'variable', detail: 'position of the current item' },
    { label: '$workflow', insert: '$workflow', kind: 'variable', detail: 'id and name' },
    { label: '$execution', insert: '$execution', kind: 'variable', detail: 'id and mode' },
    { label: '$vars', insert: '$vars', kind: 'variable', detail: data.vars.length ? `${data.vars.length} variable${data.vars.length === 1 ? '' : 's'}` : 'variables' },
  ];
  return roots;
}

function rank(items: Completion[], partial: string): Completion[] {
  if (!partial) return items.slice(0, 60);
  const needle = partial.toLowerCase().replace(/^\$/, '');
  const key = (c: Completion) => c.label.toLowerCase().replace(/^\$\(?'?/, '');
  const starts = items.filter((c) => key(c).startsWith(needle) || c.label.toLowerCase().startsWith(partial.toLowerCase()));
  const contains = items.filter((c) => !starts.includes(c) && key(c).includes(needle));
  return [...starts, ...contains].filter((c) => c.label !== partial).slice(0, 60);
}

/** Completions for the caret position, or undefined when the caret is not inside `{{ }}` or nothing applies. */
export function completionsAt(text: string, caret: number, data: CompletionData): CompletionResult | undefined {
  const expression = expressionAt(text, caret);
  if (!expression) return undefined;
  const { code } = expression;
  // The rest of an identifier after the caret is replaced too.
  const tail = /^[\w$]*/.exec(text.slice(caret))?.[0].length ?? 0;

  // $('Na…  → node names
  const nodeName = /\$\(\s*(['"`])((?:(?!\1).)*)$/.exec(code);
  if (nodeName) {
    const partial = nodeName[2];
    const quote = nodeName[1];
    const items = data.nodes
      .filter((n) => n.name.toLowerCase().includes(partial.toLowerCase()))
      .map<Completion>((n) => ({ label: n.name, insert: `${n.name.replaceAll(quote, `\\${quote}`)}${quote})`, kind: 'node', detail: n.json !== undefined ? 'output available' : 'has not run yet' }));
    const after = text.slice(caret);
    const closing = new RegExp(`^[^${quote}\\n]*${quote}\\s*\\)`).exec(after)?.[0].length ?? 0;
    return items.length ? { from: caret - partial.length, to: caret + closing, items } : { from: caret, to: caret, items: [], hint: 'No other nodes lead into this one.' };
  }

  // path.partial  → members
  const memberMatch = /((?:\$\(\s*(['"`])(?:(?!\2).)*\2\s*\)|\$?[A-Za-z_][\w$]*)(?:\.[A-Za-z_$][\w$]*|\[\s*(?:\d+|'[^']*'|"[^"]*")\s*\]|\([^()]*\))*)\.([A-Za-z_$][\w$]*)?$/.exec(code);
  if (memberMatch) {
    const base = memberMatch[1];
    const partial = memberMatch[3] ?? '';
    const target = evaluatePath(base, data);
    const { items, hint } = membersOf(target);
    const from = caret - partial.length;
    const ranked = rank(items, partial).map((c) => (c.replaceDot ? { ...c } : c));
    if (!ranked.length) return hint && !partial ? { from, to: caret + tail, items: [], hint } : undefined;
    return { from, to: caret + tail, items: ranked };
  }

  // A bare word or `$…` at the start of a term → roots, plus a few JS globals.
  const word = /(?:^|[^\w$.'"`\])])(\$?[A-Za-z_][\w$]*|\$)$/.exec(code);
  if (word || /(^|[\s(,+\-*/%!?:=<>&|{[])$/.test(code)) {
    const partial = word?.[1] ?? '';
    const pool = partial.startsWith('$') || !partial ? rootCompletions(data) : [...rootCompletions(data), ...methods(GLOBALS).map((c) => ({ ...c, kind: 'keyword' as const }))];
    const items = rank(pool, partial);
    // An empty term only suggests once something was typed, so `{{ ` alone shows the variables but spaces elsewhere don't.
    if (!partial && !/\{\{\s*$/.test(text.slice(0, caret))) return undefined;
    return items.length ? { from: caret - partial.length, to: caret + tail, items } : undefined;
  }
  return undefined;
}

/** Apply a completion: the new text and where the caret goes. */
export function applyCompletion(text: string, result: Pick<CompletionResult, 'from' | 'to'>, item: Completion): { text: string; caret: number } {
  const from = item.replaceDot && text[result.from - 1] === '.' ? result.from - 1 : result.from;
  const next = text.slice(0, from) + item.insert + text.slice(result.to);
  return { text: next, caret: from + (item.caret ?? item.insert.length) };
}

/** Merge the first few items' data into one sample, so fields that only some items have still show up. */
export function sampleOf(items: Array<{ json: unknown }> | undefined, limit = 5): unknown {
  if (!items?.length) return undefined;
  const merge = (a: unknown, b: unknown): unknown => {
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      const out: Record<string, unknown> = { ...(b as Record<string, unknown>) };
      for (const [key, entry] of Object.entries(a as Record<string, unknown>)) out[key] = key in out ? merge(entry, out[key]) : entry;
      return out;
    }
    return a === undefined ? b : a;
  };
  return items.slice(0, limit).reduce<unknown>((acc, item) => merge(acc, item.json), undefined);
}
