/**
 * YAML frontmatter of Claude Code agent and skill files: the subset they use. Scalars (plain,
 * quoted), block scalars (`|`, `>`, with chomping indicators), flow lists (`[a, "b"]`), block lists
 * (`- a`) and one level of nested maps (`metadata:`). Anything else is kept as a string.
 */

export type FrontmatterValue = string | number | boolean | null | FrontmatterValue[] | { [key: string]: FrontmatterValue };

export interface Frontmatter {
  data: Record<string, FrontmatterValue>;
  body: string;
}

function unquote(raw: string): string {
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\(["\\nt])/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

/** Split a flow list on commas outside quotes. */
function splitFlow(inner: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (const char of inner) {
    if (quote) {
      if (char === quote) quote = undefined;
      current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ',') {
      parts.push(current);
      current = '';
    } else current += char;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function scalar(raw: string): FrontmatterValue {
  const text = raw.trim();
  // A trailing comment only counts after whitespace, and never inside quotes.
  const value = /^["']/.test(text) ? text : text.replace(/\s+#.*$/, '');
  if (value.startsWith('[') && value.endsWith(']')) return splitFlow(value.slice(1, -1)).map((part) => scalar(part));
  if (/^["']/.test(value)) return unquote(value);
  if (value === '' || value === '~' || value === 'null') return null;
  if (value === 'true' || value === 'false') return value === 'true';
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

function blockScalar(lines: string[], start: number, parentIndent: number, header: string): { value: string; next: number } {
  const folded = header.startsWith('>');
  const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
  const collected: string[] = [];
  let indent: number | undefined;
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      collected.push('');
      continue;
    }
    const lineIndent = indentOf(line);
    if (lineIndent <= parentIndent) break;
    indent ??= lineIndent;
    collected.push(line.slice(Math.min(indent, lineIndent)));
  }
  // Blank lines before the next key belong to nobody.
  while (collected.length && collected[collected.length - 1] === '' && chomp !== 'keep') collected.pop();
  let value = collected.join('\n');
  // Folded: single line breaks become spaces, blank lines become line breaks.
  if (folded) value = value.replace(/([^\n])\n(?=[^\n\s])/g, '$1 ').replace(/\n\n/g, '\n');
  if (chomp !== 'strip') value += '\n';
  return { value: chomp === 'clip' ? value.replace(/\n+$/, '\n') : value, next: i };
}

function parseBlock(lines: string[], start: number, indent: number): { value: Record<string, FrontmatterValue>; next: number } {
  const result: Record<string, FrontmatterValue> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      i++;
      continue;
    }
    const lineIndent = indentOf(line);
    if (lineIndent < indent) break;
    const match = /^([^:#]+?):(?:\s+(.*)|\s*)$/.exec(line.trim());
    if (!match) {
      i++;
      continue;
    }
    const key = match[1].trim();
    const rest = (match[2] ?? '').trim();
    if (/^[|>][+-]?\d*$/.test(rest)) {
      const block = blockScalar(lines, i + 1, lineIndent, rest);
      result[key] = block.value;
      i = block.next;
      continue;
    }
    if (rest !== '') {
      result[key] = scalar(rest);
      i++;
      continue;
    }
    // Nothing after the colon: a block list, a nested map, or null.
    const next = lines.slice(i + 1).findIndex((l) => l.trim() !== '' && !l.trimStart().startsWith('#'));
    const child = next >= 0 ? lines[i + 1 + next] : undefined;
    if (child && child.trimStart().startsWith('- ') && indentOf(child) >= lineIndent) {
      const items: FrontmatterValue[] = [];
      let j = i + 1 + next;
      for (; j < lines.length; j++) {
        const item = lines[j];
        if (item.trim() === '') continue;
        if (!item.trimStart().startsWith('- ') || indentOf(item) < indentOf(child)) break;
        items.push(scalar(item.trimStart().slice(2)));
      }
      result[key] = items;
      i = j;
    } else if (child && indentOf(child) > lineIndent) {
      const nested = parseBlock(lines, i + 1 + next, indentOf(child));
      result[key] = nested.value;
      i = nested.next;
    } else {
      result[key] = null;
      i++;
    }
  }
  return { value: result, next: i };
}

export function parseFrontmatter(text: string): Frontmatter {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) return { data: {}, body: normalized.trim() };
  return { data: parseBlock(match[1].split('\n'), 0, 0).value, body: normalized.slice(match[0].length).trim() };
}

/** A string list from `tools: Read, Grep`, `tools: ["Read"]` or a block list. */
export function stringList(value: FrontmatterValue | undefined): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((v) => (v === null || typeof v === 'object' ? [] : [String(v).trim()])).filter(Boolean);
  if (typeof value === 'object') return [];
  // Commas or spaces separate entries, except inside parentheses: `Bash(git add:*), Read`.
  const text = String(value);
  const separator = text.includes(',') ? ',' : ' ';
  const items: string[] = [];
  let current = '';
  let depth = 0;
  for (const char of text) {
    if (char === '(') depth++;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (char === separator || char === '\n')) {
      items.push(current);
      current = '';
    } else current += char;
  }
  items.push(current);
  return items.map((s) => s.trim()).filter(Boolean);
}

export const asText = (value: FrontmatterValue | undefined): string | undefined =>
  value === undefined || value === null || typeof value === 'object' ? undefined : String(value).trim() || undefined;
