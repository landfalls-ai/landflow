/**
 * The sealed realm expressions run in: a fresh `node:vm` context with code generation from strings and WebAssembly
 * off, a null-prototype global, and no host object inside it. The only way in is `bridge(op, text) -> text`; what
 * comes out is tagged JSON text the host parses, so nothing a realm object does (a getter, a Proxy, a poisoned
 * prototype) can run outside the evaluation's timeout. Expressions stay synchronous and keep V8 semantics (Intl
 * included), which is why this is a vm context and not a worker or WASM engine (docs/features/engine.md).
 *
 * Not a hard boundary against a V8 bug, and memory exhaustion inside the time window is still possible.
 */
import vm from 'node:vm';
import type { ExpressionData } from '../expression';
import { secretsSandbox } from '../secrets';
import { BOOTSTRAP_SOURCE } from './bootstrap';

const TAG = '\u0001';
const EVAL_TIMEOUT_MS = 250;
const scriptCache = new Map<string, vm.Script>();
const bootstrap = new vm.Script(BOOTSTRAP_SOURCE, { filename: 'expression-bootstrap.js' });

/** Words after which a `/` starts a regex literal, not a division. */
const REGEX_AFTER = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const ID_CHAR = /[\p{ID_Continue}$\u200c\u200d]/u;

type Token = { id: boolean; value: string };

/** The identifiers and punctuation of an expression, with strings, template text, comments and regex literals skipped. */
function tokens(code: string): Token[] {
  const out: Token[] = [];
  const braces: ('b' | 't')[] = []; // '{' of a block or object, or the '${' of a template
  let i = 0;
  const template = () => {
    // inside template text, from just after a backtick or a closing `}` of a `${ }`
    while (i < code.length) {
      const c = code[i];
      if (c === '\\') i += 2;
      else if (c === '`') {
        i++;
        out.push({ id: false, value: '`' });
        return;
      } else if (c === '$' && code[i + 1] === '{') {
        i += 2;
        braces.push('t');
        return;
      } else i++;
    }
  };
  while (i < code.length) {
    const c = code[i];
    if (/\s/.test(c)) i++;
    else if (c === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n' && code[i] !== '\r' && code[i] !== '\u2028' && code[i] !== '\u2029') i++;
    } else if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end < 0 ? code.length : end + 2;
    } else if (c === '"' || c === "'") {
      i++;
      while (i < code.length && code[i] !== c) i += code[i] === '\\' ? 2 : 1;
      i++;
      out.push({ id: false, value: 'str' });
    } else if (c === '`') {
      i++;
      template();
    } else if (c === '/') {
      const prev = out[out.length - 1];
      const isRegex = !prev || (prev.id ? REGEX_AFTER.has(prev.value) : !(prev.value === ')' || prev.value === ']' || prev.value === '}' || prev.value === '`' || prev.value === 'str'));
      if (isRegex) {
        i++;
        let inClass = false;
        while (i < code.length && (inClass || code[i] !== '/') && code[i] !== '\n') {
          if (code[i] === '\\') i++;
          else if (code[i] === '[') inClass = true;
          else if (code[i] === ']') inClass = false;
          i++;
        }
        i++;
        while (i < code.length && ID_CHAR.test(code[i])) i++; // flags
        out.push({ id: false, value: 're' });
      } else {
        i++;
        out.push({ id: false, value: '/' });
      }
    } else if (ID_CHAR.test(c)) {
      const start = i;
      while (i < code.length && ID_CHAR.test(code[i])) i++;
      out.push({ id: true, value: code.slice(start, i) });
    } else if (c === '.' && code.startsWith('...', i)) {
      i += 3;
      out.push({ id: false, value: '...' });
    } else {
      i++;
      if (c === '{') braces.push('b');
      else if (c === '}') {
        if (braces.pop() === 't') {
          template();
          continue;
        }
      }
      out.push({ id: false, value: c });
    }
  }
  return out;
}

/**
 * `async` and `import(` need a Promise, and a rejected one in any context is an unhandled rejection of the host process
 * (which exits on it). Only real keyword uses are refused: the words inside strings, templates, comments, regexes, as
 * object keys (`{ async: 1 }`) and after a member `.` (`$json.async`) are ordinary text and pass. The spread
 * `...async () => {}` is not a member access.
 */
function refuseAsync(code: string): void {
  const list = tokens(code);
  for (let i = 0; i < list.length; i++) {
    const token = list[i];
    if (!token.id || (token.value !== 'async' && token.value !== 'import')) continue;
    const prev = list[i - 1];
    if (prev && !prev.id && prev.value === '.') continue;
    const next = list[i + 1];
    const keyword =
      token.value === 'import' ? next?.value === '(' : !!next && (next.id || next.value === '(' || next.value === '[' || next.value === '*' || next.value === 'str');
    if (keyword) throw new Error(`"${token.value}" is not available in expressions (async functions, await and import() are not supported)`);
  }
}

/** The script for one expression: parsed on its own first, so it can only be one expression (nothing can end the wrapper early). */
function compile(code: string): vm.Script {
  let script = scriptCache.get(code);
  if (!script) {
    refuseAsync(code);
    new vm.Script(`(\n${code}\n)`); // a syntax error here is the user's; this script is never run
    script = new vm.Script(`__eval(() => { return (\n${code}\n); })`, { filename: 'expression.js' });
    if (scriptCache.size > 2000) scriptCache.clear();
    scriptCache.set(code, script);
  }
  return script;
}

/** The host side of `bridge`: answers with `{"v":…}` or `{"e":message}`, never throws. */
function createBridge(data: ExpressionData) {
  const own = (record: Record<string, unknown> | undefined, key: string) => (record && Object.hasOwn(record, key) ? record[key] : undefined);
  const secrets = secretsSandbox(data.secrets) as Record<string, Record<string, unknown>>;
  const handle = (op: string, arg: string): unknown => {
    switch (op) {
      case 'inputHas':
        return true;
      case 'inputItem':
        return data.items[Number(arg)] ?? null;
      case 'inputItems':
        return data.items;
      case 'nodeHas':
        return own(data.nodeOutputs, arg) !== undefined;
      case 'nodeItem': {
        const [name, index] = JSON.parse(arg) as [string, number];
        return (own(data.nodeOutputs, name) as unknown[] | undefined)?.[index] ?? null;
      }
      case 'nodeItems':
        return own(data.nodeOutputs, arg) ?? null;
      case 'static':
        return { workflow: data.workflow, execution: data.execution, variables: data.variables ?? {}, composite: data.composite };
      case 'parameters':
        return data.parameters;
      case 'toolArg':
        return own(data.toolArgs, arg) ?? null;
      case 'secretProvider':
        void secrets[arg]; // throws when the provider isn't loaded
        return true;
      case 'secret': {
        const [provider, name] = JSON.parse(arg) as [string, string];
        return secrets[provider][name];
      }
      default:
        throw new Error(`Unknown bridge call "${op}"`);
    }
  };
  return (op: string, arg: string): string => {
    try {
      return JSON.stringify({ v: handle(op, arg) ?? null });
    } catch (error) {
      return JSON.stringify({ e: error instanceof Error ? error.message : String(error) });
    }
  };
}

/** Back from tagged JSON: undefined, NaN, ±Infinity, -0 and Dates, as host-realm values. */
function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (TAG in record) {
    if (record[TAG] === 'd') return new Date(record.v === null ? NaN : (record.v as number));
    if (record[TAG] === 'n') return Number(record.v);
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === '__proto__') Object.defineProperty(out, key, { value: revive(entry), enumerable: true, writable: true, configurable: true });
    else out[key] = revive(entry);
  }
  return out;
}

export interface ExpressionRealm {
  /** Evaluate one expression for item `itemIndex`; throws a host Error with the expression's message. */
  run(code: string, itemIndex: number): unknown;
}

export function createExpressionRealm(data: ExpressionData): ExpressionRealm {
  const global = Object.create(null) as Record<string, unknown>;
  global.__bridge = createBridge(data);
  // afterEvaluate: microtasks drain inside the evaluation's timeout (the realm has no way to make a Promise; belt and braces).
  const context = vm.createContext(global, { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
  const registers = bootstrap.runInContext(context, { timeout: 1_000 }) as Float64Array;
  return {
    run(code, itemIndex) {
      registers[0] = itemIndex;
      registers[1] = Date.now();
      const script = compile(code); // a host SyntaxError (or the async refusal): safe to read
      const started = performance.now();
      let out: unknown;
      try {
        out = script.runInContext(context, { timeout: EVAL_TIMEOUT_MS });
      } catch {
        // What escapes the realm's own try/catch is the timeout or a stack overflow. The thrown value belongs to the
        // realm (a poisoned `message` getter would run outside the timeout), so it is never read.
        throw new Error(performance.now() - started >= EVAL_TIMEOUT_MS - 2 ? `Script execution timed out after ${EVAL_TIMEOUT_MS}ms` : 'The expression failed (out of stack)');
      }
      if (typeof out !== 'string') throw new Error('The expression failed');
      if (out[0] === 'E') throw new Error(out.slice(1));
      const json = out.slice(1);
      return json.includes('\\u0001') ? revive(JSON.parse(json)) : JSON.parse(json);
    },
  };
}
