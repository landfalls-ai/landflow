/**
 * SCIM filters (RFC 7644 §3.4.2.2), evaluated against a resource's SCIM representation: comparisons (`eq`, `ne`,
 * `co`, `sw`, `ew`, `gt`, `ge`, `lt`, `le`), `pr`, `and`, `or`, `not (…)`, grouping and value paths such as
 * `emails[type eq "work"].value eq "a@b.c"`. Attribute names and string values compare case-insensitively (the
 * attributes identity providers filter on, `userName`, `emails`, `displayName`, `externalId`, aren't case-exact
 * here). Also parses PATCH paths (`members[value eq "id"]`, `name.givenName`).
 */
import { SCHEMAS, ScimError } from './http';

type Op = 'eq' | 'ne' | 'co' | 'sw' | 'ew' | 'gt' | 'ge' | 'lt' | 'le';
const OPS = new Set<string>(['eq', 'ne', 'co', 'sw', 'ew', 'gt', 'ge', 'lt', 'le']);
type Value = string | number | boolean | null;

export type Filter =
  | { type: 'and' | 'or'; left: Filter; right: Filter }
  | { type: 'not'; expr: Filter }
  | { type: 'cmp'; path: string[]; op: Op; value: Value }
  | { type: 'pr'; path: string[] }
  | { type: 'valuePath'; path: string[]; filter: Filter; sub?: string; op?: Op | 'pr'; value?: Value };

type Token = { kind: 'word' | 'string' | 'punct'; text: string };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (/\s/.test(char)) {
      i++;
    } else if ('()[]'.includes(char)) {
      tokens.push({ kind: 'punct', text: char });
      i++;
    } else if (char === '"') {
      let value = '';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) {
          i++;
          value += text[i] === 'n' ? '\n' : text[i] === 't' ? '\t' : text[i];
        } else value += text[i];
        i++;
      }
      if (text[i] !== '"') throw new ScimError(400, 'Unterminated string in filter', 'invalidFilter');
      i++;
      tokens.push({ kind: 'string', text: value });
    } else {
      let word = '';
      while (i < text.length && !/[\s()[\]"]/.test(text[i])) word += text[i++];
      tokens.push({ kind: 'word', text: word });
    }
  }
  return tokens;
}

/** An attribute path as segments, without a core schema URN prefix (extension URNs stay as the first segment). */
export function attributePath(text: string): string[] {
  if (/^urn:/i.test(text)) {
    for (const core of [SCHEMAS.user, SCHEMAS.group]) {
      if (text.toLowerCase().startsWith(`${core.toLowerCase()}:`)) return text.slice(core.length + 1).split('.').filter(Boolean);
    }
    // urn:…:enterprise:2.0:User:department → [urn:…:User, department]
    const at = text.lastIndexOf(':');
    return [text.slice(0, at), ...text.slice(at + 1).split('.').filter(Boolean)];
  }
  return text.split('.').filter(Boolean);
}

class Parser {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private next(): Token {
    const token = this.tokens[this.index++];
    if (!token) throw new ScimError(400, 'The filter ends too early', 'invalidFilter');
    return token;
  }

  private keyword(word: string): boolean {
    const token = this.peek();
    if (token?.kind === 'word' && token.text.toLowerCase() === word) {
      this.index++;
      return true;
    }
    return false;
  }

  private expect(punct: string) {
    const token = this.next();
    if (token.kind !== 'punct' || token.text !== punct) throw new ScimError(400, `Expected “${punct}” in the filter`, 'invalidFilter');
  }

  done(): boolean {
    return this.index >= this.tokens.length;
  }

  parse(): Filter {
    let left = this.and();
    while (this.keyword('or')) left = { type: 'or', left, right: this.and() };
    return left;
  }

  private and(): Filter {
    let left = this.unary();
    while (this.keyword('and')) left = { type: 'and', left, right: this.unary() };
    return left;
  }

  private unary(): Filter {
    if (this.keyword('not')) {
      this.expect('(');
      const expr = this.parse();
      this.expect(')');
      return { type: 'not', expr };
    }
    const token = this.peek();
    if (token?.kind === 'punct' && token.text === '(') {
      this.index++;
      const expr = this.parse();
      this.expect(')');
      return expr;
    }
    return this.attribute();
  }

  private value(): Value {
    const token = this.next();
    if (token.kind === 'string') return token.text;
    if (token.kind !== 'word') throw new ScimError(400, 'Expected a value in the filter', 'invalidFilter');
    const lower = token.text.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    if (lower === 'null') return null;
    const number = Number(token.text);
    if (token.text !== '' && Number.isFinite(number)) return number;
    throw new ScimError(400, `Unexpected “${token.text}” in the filter (quote strings)`, 'invalidFilter');
  }

  private attribute(): Filter {
    const token = this.next();
    if (token.kind !== 'word') throw new ScimError(400, 'Expected an attribute name in the filter', 'invalidFilter');
    const path = attributePath(token.text);
    const after = this.peek();
    if (after?.kind === 'punct' && after.text === '[') {
      this.index++;
      const filter = this.parse();
      this.expect(']');
      let sub: string | undefined;
      const dotted = this.peek();
      if (dotted?.kind === 'word' && dotted.text.startsWith('.')) {
        sub = dotted.text.slice(1);
        this.index++;
      }
      const opToken = this.peek();
      if (opToken?.kind === 'word' && (OPS.has(opToken.text.toLowerCase()) || opToken.text.toLowerCase() === 'pr')) {
        this.index++;
        const op = opToken.text.toLowerCase() as Op | 'pr';
        return { type: 'valuePath', path, filter, ...(sub && { sub }), op, ...(op !== 'pr' && { value: this.value() }) };
      }
      return { type: 'valuePath', path, filter, ...(sub && { sub }) };
    }
    const opToken = this.next();
    const op = opToken.text.toLowerCase();
    if (opToken.kind !== 'word') throw new ScimError(400, 'Expected an operator in the filter', 'invalidFilter');
    if (op === 'pr') return { type: 'pr', path };
    if (!OPS.has(op)) throw new ScimError(400, `Unknown filter operator “${opToken.text}”`, 'invalidFilter');
    return { type: 'cmp', path, op: op as Op, value: this.value() };
  }
}

export function parseFilter(text: string): Filter {
  const parser = new Parser(tokenize(text));
  const filter = parser.parse();
  if (!parser.done()) throw new ScimError(400, 'Unexpected text at the end of the filter', 'invalidFilter');
  return filter;
}

/** The value of `key` in `object`, matching the key case-insensitively. */
export function getKey(object: unknown, key: string): unknown {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return undefined;
  const record = object as Record<string, unknown>;
  if (key in record) return record[key];
  const lower = key.toLowerCase();
  const found = Object.keys(record).find((k) => k.toLowerCase() === lower);
  return found === undefined ? undefined : record[found];
}

/** Every value at `path` (multi-valued attributes are flattened). */
function resolve(values: unknown[], path: string[]): unknown[] {
  let current = values;
  for (const segment of path) {
    current = current.flatMap((value) => (Array.isArray(value) ? value : [value])).map((value) => getKey(value, segment));
  }
  return current.flatMap((value) => (Array.isArray(value) ? value : [value])).filter((value) => value !== undefined);
}

function compare(actual: unknown, op: Op, expected: Value): boolean {
  if (expected === null) return op === 'eq' ? actual === null : op === 'ne' ? actual !== null : false;
  if (typeof expected === 'boolean') {
    const value = typeof actual === 'string' ? actual.toLowerCase() === 'true' : actual;
    return op === 'eq' ? value === expected : op === 'ne' ? value !== expected : false;
  }
  if (typeof expected === 'number' && typeof actual === 'number') {
    return { eq: actual === expected, ne: actual !== expected, gt: actual > expected, ge: actual >= expected, lt: actual < expected, le: actual <= expected, co: false, sw: false, ew: false }[op];
  }
  const a = String(actual ?? '').toLowerCase();
  const e = String(expected).toLowerCase();
  return { eq: a === e, ne: a !== e, co: a.includes(e), sw: a.startsWith(e), ew: a.endsWith(e), gt: a > e, ge: a >= e, lt: a < e, le: a <= e }[op];
}

/** Whether `resource` (a SCIM representation) matches `filter`. */
export function matches(resource: unknown, filter: Filter): boolean {
  switch (filter.type) {
    case 'and':
      return matches(resource, filter.left) && matches(resource, filter.right);
    case 'or':
      return matches(resource, filter.left) || matches(resource, filter.right);
    case 'not':
      return !matches(resource, filter.expr);
    case 'pr':
      return resolve([resource], filter.path).some((value) => value !== null && value !== '' && !(Array.isArray(value) && !value.length));
    case 'cmp': {
      const values = resolve([resource], filter.path);
      if (filter.op === 'ne') return values.every((value) => compare(value, 'ne', filter.value));
      return values.some((value) => compare(value, filter.op, filter.value));
    }
    case 'valuePath': {
      const elements = resolve([resource], filter.path).filter((element) => matches(element, filter.filter));
      if (!filter.op) return elements.length > 0;
      const values = filter.sub ? resolve(elements, [filter.sub]) : elements;
      if (filter.op === 'pr') return values.some((value) => value !== null && value !== '');
      return values.some((value) => compare(value, filter.op as Op, filter.value ?? null));
    }
  }
}

/** A PATCH path: the attribute, an optional value filter (`members[value eq "x"]`) and sub-attribute (`.value`). */
export interface PatchPath {
  attr: string[];
  filter?: Filter;
  sub?: string;
}

export function parsePatchPath(text: string): PatchPath {
  const bracket = text.indexOf('[');
  if (bracket < 0) return { attr: attributePath(text) };
  const close = text.lastIndexOf(']');
  if (close < bracket) throw new ScimError(400, `Invalid path “${text}”`, 'invalidPath');
  const rest = text.slice(close + 1);
  return {
    attr: attributePath(text.slice(0, bracket)),
    filter: parseFilter(text.slice(bracket + 1, close)),
    ...(rest.startsWith('.') && rest.length > 1 && { sub: rest.slice(1) }),
  };
}
