/**
 * Syntax highlighting for the code editor (code-editor.tsx): a small tokenizer for JavaScript, Python and JSON that
 * turns the text into coloured runs. It doesn't parse, it scans: comments, strings (template literals with their
 * `${ }` parts, Python's triple quotes and prefixes), regular expression literals, numbers, keywords, literals, the
 * workflow globals (`$json`, `$input`, `_json`, `_input`…), calls and, in JSON, keys and `{{ expressions }}`. Joining
 * the tokens' text always gives back the input exactly, so the highlight layer lines up with the field. Pure, no DOM.
 * Also: what the caret is in (a string or comment stops completions) and the Python names the completions map.
 */
import type { Completion, CompletionData, CompletionResult } from './expression-completions';
import { codeCompletionsAt } from './expression-completions';

export type TokenKind = 'plain' | 'keyword' | 'literal' | 'string' | 'number' | 'comment' | 'variable' | 'function' | 'property' | 'expression' | 'brace';
export interface Token {
  kind: TokenKind;
  text: string;
}
export type CodeLanguage = 'javascript' | 'python' | 'json' | 'plain';

/** A parameter's `typeOptions.language` as one the tokenizer knows (code parameters without one are JavaScript). */
export function languageOf(language: string | undefined, type: 'code' | 'json' = 'code'): CodeLanguage {
  const name = (language ?? '').toLowerCase();
  if (['javascript', 'js', 'typescript', 'ts', 'jsx', 'tsx'].includes(name)) return 'javascript';
  if (['python', 'py', 'python3'].includes(name)) return 'python';
  if (name === 'json' || (!name && type === 'json')) return 'json';
  return name ? 'plain' : 'javascript';
}

const JS_KEYWORDS = new Set(
  'async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield'.split(
    ' ',
  ),
);
const JS_LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
/** After these a `/` starts a regular expression, not a division. */
const JS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);
/** Globals the Code node's JavaScript gets besides the `$` ones. */
const JS_GLOBALS = new Set(['items', 'item', 'DateTime', 'console']);

const PY_KEYWORDS = new Set(
  'and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield'.split(' '),
);
const PY_LITERALS = new Set(['True', 'False', 'None']);
/** The Python Code node's globals (services/code-runner/child/py_runner.py). */
export const PY_GLOBALS = new Set(['_json', '_input', '_items', '_item', '_', '_vars', '_execution', '_workflow', '_now', '_today', '_itemIndex', 'self']);

// Sticky patterns, matched where the scan is (no slicing: long scripts stay fast).
const NUMBER = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)[njJ]?/y;
const JS_IDENT = /[A-Za-z_$][\w$]*/y;
const PY_IDENT = /[A-Za-z_]\w*/y;
const CALL = /\s*\(/y;
const FLAGS = /[a-z]*/y;
const PY_STRING = /([rRbBuUfF]{0,2})('''|"""|'|")/y;
const DECORATOR = /@[\w.]+/y;
const JSON_KEY = /\s*:/y;
const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const JSON_WORD = /(?:true|false|null)\b/y;

/** `pattern` matched at `i` (sticky), or undefined. */
function match(pattern: RegExp, text: string, i: number): RegExpExecArray | undefined {
  pattern.lastIndex = i;
  return pattern.exec(text) ?? undefined;
}

class Out {
  tokens: Token[] = [];
  push(kind: TokenKind, text: string) {
    if (!text) return;
    const last = this.tokens.at(-1);
    if (last && last.kind === kind && (kind === 'plain' || kind === 'string' || kind === 'comment')) last.text += text;
    else this.tokens.push({ kind, text });
  }
}

/** The end of a quoted string starting at `i` (the quote), stopping at a newline when it isn't closed. */
function quotedEnd(text: string, i: number, quote: string): number {
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') j += 2;
    else if (c === quote) return j + 1;
    else if (c === '\n') return j;
    else j++;
  }
  return text.length;
}

function tokenizeJs(text: string): Token[] {
  const out = new Out();
  /** Brace depth at each open `${`, so its `}` goes back to the template. */
  const templates: number[] = [];
  let depth = 0;
  /** Whether what came last is a value (then `/` divides) or an operator (then `/` starts a regex). */
  let afterValue = false;
  let i = 0;
  const template = (from: number) => {
    // From a backtick (or the `}` closing a substitution) to the closing backtick or the next `${`.
    let j = from + 1;
    let closed = false;
    while (j < text.length) {
      const c = text[j];
      if (c === '\\') j += 2;
      else if (c === '`') {
        j++;
        closed = true;
        break;
      } else if (c === '$' && text[j + 1] === '{') {
        j += 2;
        templates.push(depth);
        break;
      } else j++;
    }
    out.push('string', text.slice(from, Math.min(j, text.length)));
    afterValue = closed;
    return Math.min(j, text.length);
  };
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '`') {
      i = template(i);
      continue;
    }
    if (c === '}' && templates.length && depth === templates.at(-1)) {
      templates.pop();
      i = template(i);
      continue;
    }
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      out.push('comment', text.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out.push('comment', text.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = quotedEnd(text, i, c);
      out.push('string', text.slice(i, end));
      i = end;
      afterValue = true;
      continue;
    }
    if (c === '/' && !afterValue) {
      // A regular expression literal: up to the unescaped `/` outside a [class], then its flags. A newline first: just a slash.
      let j = i + 1;
      let inClass = false;
      let end = -1;
      while (j < text.length && text[j] !== '\n') {
        const ch = text[j];
        if (ch === '\\') j += 2;
        else {
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) {
            end = j + 1;
            break;
          }
          j++;
        }
      }
      if (end > 0) {
        const flags = match(FLAGS, text, end)![0];
        out.push('string', text.slice(i, end + flags.length));
        i = end + flags.length;
        afterValue = true;
        continue;
      }
    }
    if (/\d/.test(c) || (c === '.' && next !== undefined && /\d/.test(next))) {
      const number = match(NUMBER, text, i)![0];
      out.push('number', number);
      i += number.length;
      afterValue = true;
      continue;
    }
    const ident = /[A-Za-z_$]/.test(c) ? match(JS_IDENT, text, i)![0] : undefined;
    if (ident) {
      const member = text[i - 1] === '.' && text[i - 2] !== '.';
      const call = Boolean(match(CALL, text, i + ident.length));
      let kind: TokenKind = 'plain';
      if (!member && JS_KEYWORDS.has(ident)) kind = 'keyword';
      else if (!member && JS_LITERALS.has(ident)) kind = 'literal';
      else if (!member && (ident.startsWith('$') || JS_GLOBALS.has(ident))) kind = 'variable';
      else if (call) kind = 'function';
      out.push(kind, ident);
      i += ident.length;
      afterValue = !(kind === 'keyword' && JS_BEFORE_REGEX.has(ident));
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    out.push('plain', c);
    if (!/\s/.test(c)) afterValue = c === ')' || c === ']' || c === '}';
    i++;
  }
  return out.tokens;
}

/** Only spaces or tabs between the line's start and `i`. */
function startsLine(text: string, i: number): boolean {
  for (let j = i - 1; j >= 0; j--) {
    if (text[j] === '\n') return true;
    if (text[j] !== ' ' && text[j] !== '\t') return false;
  }
  return true;
}

function tokenizePython(text: string): Token[] {
  const out = new Out();
  let i = 0;
  let afterDef = false;
  while (i < text.length) {
    const c = text[i];
    if (c === '#') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      out.push('comment', text.slice(i, stop));
      i = stop;
      continue;
    }
    // Strings, with an optional prefix (r, b, f, rb…) and triple quotes across lines.
    const string = match(PY_STRING, text, i);
    if (string && (string[1] === '' || !/[\w]/.test(text[i - 1] ?? ''))) {
      const quote = string[2];
      const start = i + string[0].length;
      let end: number;
      if (quote.length === 3) {
        end = text.length;
        for (let j = start; j < text.length; j++) {
          if (text[j] === '\\') j++;
          else if (text.startsWith(quote, j)) {
            end = j + 3;
            break;
          }
        }
      } else end = quotedEnd(text, start - 1, quote);
      out.push('string', text.slice(i, end));
      i = end;
      continue;
    }
    if (/\d/.test(c) || (c === '.' && /\d/.test(text[i + 1] ?? ''))) {
      const number = match(NUMBER, text, i)![0];
      out.push('number', number);
      i += number.length;
      continue;
    }
    if (c === '@' && /[A-Za-z_]/.test(text[i + 1] ?? '') && startsLine(text, i)) {
      const name = match(DECORATOR, text, i)![0];
      out.push('function', name);
      i += name.length;
      continue;
    }
    const ident = /[A-Za-z_]/.test(c) ? match(PY_IDENT, text, i)![0] : undefined;
    if (ident) {
      const member = text[i - 1] === '.';
      const call = Boolean(match(CALL, text, i + ident.length));
      let kind: TokenKind = 'plain';
      if (!member && PY_KEYWORDS.has(ident)) kind = 'keyword';
      else if (!member && PY_LITERALS.has(ident)) kind = 'literal';
      else if (!member && PY_GLOBALS.has(ident)) kind = 'variable';
      else if (call || afterDef) kind = 'function';
      out.push(kind, ident);
      afterDef = kind === 'keyword' && (ident === 'def' || ident === 'class');
      i += ident.length;
      continue;
    }
    out.push('plain', c);
    i++;
  }
  return out.tokens;
}

/** `{{ code }}` inside JSON text: braces and the expression apart. */
function pushWithExpressions(out: Out, kind: TokenKind, text: string) {
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{{', i);
    if (open < 0) return out.push(kind, text.slice(i));
    out.push(kind, text.slice(i, open));
    const close = text.indexOf('}}', open + 2);
    out.push('brace', '{{');
    if (close < 0) return out.push('expression', text.slice(open + 2));
    out.push('expression', text.slice(open + 2, close));
    out.push('brace', '}}');
    i = close + 2;
  }
}

function tokenizeJson(text: string): Token[] {
  const out = new Out();
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const end = quotedEnd(text, i, '"');
      const key = Boolean(match(JSON_KEY, text, end));
      pushWithExpressions(out, key ? 'property' : 'string', text.slice(i, end));
      i = end;
      continue;
    }
    if (c === '{' && text[i + 1] === '{') {
      const close = text.indexOf('}}', i + 2);
      const end = close < 0 ? text.length : close + 2;
      pushWithExpressions(out, 'plain', text.slice(i, end));
      i = end;
      continue;
    }
    if (c === '-' || /\d/.test(c)) {
      const number = match(JSON_NUMBER, text, i)?.[0];
      if (number) {
        out.push('number', number);
        i += number.length;
        continue;
      }
    }
    const word = match(JSON_WORD, text, i)?.[0];
    if (word) {
      out.push('literal', word);
      i += word.length;
      continue;
    }
    out.push('plain', c);
    i++;
  }
  return out.tokens;
}

/** The text as coloured runs; their text joined is the input. */
export function highlightCode(text: string, language: CodeLanguage): Token[] {
  if (!text) return [];
  if (language === 'javascript') return tokenizeJs(text);
  if (language === 'python') return tokenizePython(text);
  if (language === 'json') return tokenizeJson(text);
  return [{ kind: 'plain', text }];
}

/** The token the caret sits in (the one ending at it when it is between two), with where it ends. */
export function tokenAt(tokens: readonly Token[], caret: number): { token: Token; end: number } | undefined {
  let at = 0;
  for (const token of tokens) {
    const end = at + token.text.length;
    if (caret > at && caret <= end) return { token, end };
    at = end;
  }
  return undefined;
}

/** Inside a string or a comment, where completions stay away. Right after a closed string or block comment is outside. */
export function inStringOrComment(tokens: readonly Token[], caret: number): boolean {
  const found = tokenAt(tokens, caret);
  if (!found || (found.token.kind !== 'string' && found.token.kind !== 'comment')) return false;
  const { text } = found.token;
  const closed = text.length > 1 && (found.token.kind === 'string' ? /['"`]$/.test(text) : text.startsWith('/*') && text.length > 3 && text.endsWith('*/'));
  return !(closed && caret === found.end);
}

const PY_TO_JS: Array<[RegExp, string]> = [
  [/(^|[^\w$.])_\(/g, '$1$('],
  [/(^|[^\w$.])_(json|input|vars|now|today|execution|workflow|itemIndex)\b/g, '$1$$$2'],
  // A name being typed at the caret (`_js` → `$js`), so the roots complete too.
  [/(^|[^\w$.])_(\w*)$/g, '$1$$$2'],
];
/** Python members that are JavaScript only (`length`, `[0]`, string and date methods). */
const PY_KEEP_METHODS = new Set(['first()', 'last()', 'all()']);

/**
 * Completions for the code editor: JavaScript gets the `$` names (`$json.…`, `$input.…`, `$('Node').…`); Python the
 * same through its `_` names (`_json`, `_input`, `_('Node')`), without the JavaScript-only methods. Nothing inside
 * strings and comments.
 */
export function codeEditorCompletions(text: string, caret: number, language: CodeLanguage, data: CompletionData, tokens: readonly Token[]): CompletionResult | undefined {
  if (language !== 'javascript' && language !== 'python') return undefined;
  if (inStringOrComment(tokens, caret)) return undefined;
  if (language === 'javascript') return codeCompletionsAt(text, caret, data);
  // Python: read the line as JavaScript ($ for _), then turn the suggestions back.
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  const line = PY_TO_JS.reduce((out, [pattern, replace]) => out.replace(pattern, replace), text.slice(lineStart, caret));
  const result = codeCompletionsAt(line, line.length, data);
  if (!result) return undefined;
  const shift = caret - line.length;
  const toPy = (value: string) => value.replace(/^\$/, '_');
  const items = result.items
    .filter((item: Completion) => (item.kind !== 'method' || PY_KEEP_METHODS.has(item.label)) && item.label !== 'length' && item.label !== '[0]' && item.label !== '$secrets')
    .map((item) => ({ ...item, label: toPy(item.label), insert: toPy(item.insert) }));
  if (!items.length) return undefined;
  // The replaced range is the same length in both spellings ($ and _ are one character each).
  const tail = /^[\w]*/.exec(text.slice(caret))?.[0].length ?? 0;
  return { ...result, from: result.from + shift, to: caret + tail, items };
}
