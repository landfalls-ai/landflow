/**
 * The strict expression backend (LANDFLOW_EXPRESSION_SANDBOX=isolate): the same bootstrap and bridge as the sealed realm
 * (./realm.ts), but inside an isolated-vm Isolate instead of a node:vm context. The isolate has its own V8 heap with a
 * memory cap, so a memory bomb ends the evaluation (and the isolate, which is rebuilt) instead of the host process, and
 * a V8 bug in an expression's code reaches an isolate rather than the host's heap. One isolate per process, one Context
 * per resolver (the 32 most recently used stay, the rest are released and rebuilt on demand); only strings cross the boundary, as in the realm. Semantics are the realm's (V8, Intl).
 *
 * isolated-vm is an optional dependency with a native addon, and on Node 20+ every process that loads it needs
 * `NODE_OPTIONS=--no-node-snapshot`. Nothing here loads it until `isolate` is asked for.
 */
import { createRequire } from 'node:module';
import type { ExpressionData } from '../expression';
import { BOOTSTRAP_SOURCE } from './bootstrap';
import { checkExpression, createBridge, revive, type ExpressionRealm } from './realm';

const EVAL_TIMEOUT_MS = 250;
export const DEFAULT_MEMORY_MB = 64;

// The slice of isolated-vm used here, typed locally so a machine where the addon is missing still typechecks.
interface IvmScript {
  runSync(context: IvmContext, options: { timeout: number }): unknown;
}
interface IvmFunctionRef {
  applySync(receiver: undefined, args: unknown[]): unknown;
}
interface IvmContext {
  global: { setSync(name: string, value: unknown): void; getSync(name: string, options: { reference: true }): IvmFunctionRef };
  release(): void;
}
interface IvmIsolate {
  isDisposed: boolean;
  getHeapStatisticsSync(): { used_heap_size: number };
  compileScriptSync(code: string, options?: { filename?: string }): IvmScript;
  createContextSync(): IvmContext;
  dispose(): void;
}
interface IvmModule {
  Isolate: new (options: { memoryLimit: number }) => IvmIsolate;
  Callback: new (fn: (...args: string[]) => string) => unknown;
}

let loaded: IvmModule | null | undefined;
let loadError = '';

/**
 * isolated-vm, or undefined when it is not installed or its addon does not load (the reason is in `isolateUnavailable()`).
 * It is required from this package's own location first and, when a bundler moved this file, from where the package
 * lives (found through the workspace link), because pnpm keeps the addon in the engine's node_modules only.
 */
export function loadIsolatedVm(): IvmModule | undefined {
  if (loaded !== undefined) return loaded ?? undefined;
  const bases: string[] = [import.meta.url];
  try {
    bases.push(createRequire(`${process.cwd()}/`).resolve('@landflow/engine/package.json'));
  } catch {
    // not resolvable from the working directory: the first base is all there is
  }
  for (const base of bases) {
    try {
      loaded = createRequire(base)('isolated-vm') as IvmModule;
      return loaded;
    } catch (error) {
      loadError = (error as Error).message.split('\n')[0];
    }
  }
  loaded = null;
  return undefined;
}

/** Why isolated-vm could not be loaded ('' while it can). */
export const isolateUnavailable = (): string => (loadIsolatedVm() ? '' : loadError || 'isolated-vm is not installed');

/** A resolver's context in the isolate; `released` once it was handed back (evicted), when its resolver builds a new one. */
interface Live {
  context: IvmContext;
  released: boolean;
}
interface Shared {
  isolate: IvmIsolate;
  memoryMb: number;
  scripts: Map<string, IvmScript>;
  /** The bootstrap, compiled once per isolate and run in every context. */
  setup?: IvmScript;
  /** Live contexts, least recently used first. The host's GC cannot see the isolate's heap, so contexts are released here, not when a resolver is collected. */
  live: Set<Live>;
}
const SHARED = Symbol.for('landflow.expression.isolate');
const holder = globalThis as unknown as Record<symbol, Shared | undefined>;

/** The process's isolate, made on first use and again after one was disposed (memory limit). */
function shared(ivm: IvmModule, memoryMb: number): Shared {
  let current = holder[SHARED];
  if (!current || current.isolate.isDisposed || current.memoryMb !== memoryMb) {
    if (current && !current.isolate.isDisposed) current.isolate.dispose();
    current = { isolate: new ivm.Isolate({ memoryLimit: memoryMb }), memoryMb, scripts: new Map(), live: new Set() };
    holder[SHARED] = current;
  }
  return current;
}

// V8 cannot recover from ONE allocation larger than the heap limit (it aborts the process before isolated-vm's memory
// limit can end the isolate), so the builtins that make a big block in a single step from a length the caller gives
// refuse sizes the cap could never hold: `new Array(1e8).fill(1)`, `Array.from({ length: 1e8 }, f)`, `x.repeat(2 ** 28)`.
// Everything that grows in steps (push loops, string concatenation) reaches the cap normally and ends the isolate.
// This is a list of the builtins found to allocate that way (about 150 single-step bombs were tried, and only
// `Array.from` with a length, `fill`, `join`, `repeat`, `padStart` and `padEnd` aborted): it cannot be shown to be
// complete, and docs/features/engine.md says so.
const guards = (memoryMb: number) => `(function () {
  const maxElements = ${memoryMb * 32768};
  const maxChars = ${memoryMb * 262144};
  const define = Object.defineProperty;
  const wrap = (proto, name, size, max, message) => {
    const original = proto[name];
    const guarded = { [name](...args) { if (size(this, args) > max) throw new RangeError(message); return original.apply(this, args); } }[name];
    define(guarded, 'length', { value: original.length, configurable: true });
    define(proto, name, { value: guarded, writable: true, configurable: true });
  };
  const arrayLike = (items) => (items !== null && (typeof items === 'object' || typeof items === 'function') ? Object(items).length >>> 0 : 0);
  const length = (self) => (self == null ? 0 : self.length >>> 0);
  wrap(Array, 'from', (self, args) => arrayLike(args[0]), maxElements, 'Invalid array length');
  wrap(Array.prototype, 'fill', (self) => length(self), maxElements, 'Invalid array length');
  wrap(Array.prototype, 'join', (self) => length(self), maxElements, 'Invalid string length');
  wrap(String.prototype, 'repeat', (self, args) => String(self).length * Math.max(0, Number(args[0]) || 0), maxChars, 'Invalid string length');
  wrap(String.prototype, 'padStart', (self, args) => Math.max(0, Number(args[0]) || 0), maxChars, 'Invalid string length');
  wrap(String.prototype, 'padEnd', (self, args) => Math.max(0, Number(args[0]) || 0), maxChars, 'Invalid string length');
})();`;

// The bootstrap returns its register array, which cannot cross the boundary: this wrapper keeps it in a closure and
// gives the host one locked function to set [item index, now]. It runs before any expression, so only its own context is affected.
const setup = (memoryMb: number) => `${guards(memoryMb)}
(function () {
  const regs = ${BOOTSTRAP_SOURCE};
  Object.defineProperty(globalThis, '__at', { value: (index, now) => { regs[0] = index; regs[1] = now; }, writable: false, configurable: false, enumerable: false });
})()`;

/** Contexts one isolate keeps at once; the least recently used is released beyond it (its resolver builds a new one on its next evaluation). */
const MAX_LIVE_CONTEXTS = 32;

/** Isolate disposal that is no fault of the expression: (re)build once and go on. */
const fresh = (current: Shared) => {
  if (holder[SHARED] === current) holder[SHARED] = undefined;
};

export function createIsolateRealm(data: ExpressionData, options: { memoryMb?: number } = {}): ExpressionRealm {
  const ivm = loadIsolatedVm();
  if (!ivm) throw new Error(`The isolate expression backend is not available: ${isolateUnavailable()}`);
  const memoryMb = Math.max(8, Math.floor(options.memoryMb ?? DEFAULT_MEMORY_MB));
  const bridge = createBridge(data);
  let state: Shared | undefined;
  let entry: Live | undefined;
  let setRegisters: IvmFunctionRef | undefined;

  /** A new bootstrapped context in `current`, with the least recently used ones released past the limit. */
  const build = (current: Shared) => {
    const context = current.isolate.createContextSync();
    const created: Live = { context, released: false };
    current.live.add(created);
    try {
      context.global.setSync('__bridge', new ivm.Callback(bridge));
      current.setup ??= current.isolate.compileScriptSync(setup(memoryMb), { filename: 'expression-bootstrap.js' });
      current.setup.runSync(context, { timeout: 1_000 });
      setRegisters = context.global.getSync('__at', { reference: true });
    } catch (error) {
      current.live.delete(created);
      created.released = true;
      if (!current.isolate.isDisposed) context.release();
      throw error;
    }
    state = current;
    entry = created;
    for (const old of current.live) {
      if (current.live.size <= MAX_LIVE_CONTEXTS) break;
      current.live.delete(old);
      old.released = true;
      old.context.release();
    }
  };

  /** A context in the current isolate (a new one when the isolate was replaced after hitting its memory limit). */
  const ensure = () => {
    for (let attempt = 0; ; attempt++) {
      const current = shared(ivm, memoryMb);
      if (state === current && entry && !entry.released && setRegisters) {
        current.live.delete(entry); // most recently used last
        current.live.add(entry);
        return current;
      }
      try {
        build(current);
        return current;
      } catch (error) {
        if (!current.isolate.isDisposed || attempt > 0) throw error;
        fresh(current); // another resolver filled the heap: start over in a new isolate
      }
    }
  };

  /** Compiled expressions are kept per isolate (each costs heap, so the count follows the cap). */
  const compile = (current: Shared, code: string): IvmScript => {
    const script = current.isolate.compileScriptSync(`__eval(() => { return (\n${code}\n); })`, { filename: 'expression.js' });
    if (current.scripts.size >= memoryMb * 4) current.scripts.clear();
    current.scripts.set(code, script);
    return script;
  };

  return {
    run(code, itemIndex) {
      checkExpression(code); // a host SyntaxError (or the async refusal): safe to read
      let current = ensure();
      let script = current.scripts.get(code);
      if (!script) {
        try {
          script = compile(current, code);
        } catch (error) {
          if (!current.isolate.isDisposed) throw error;
          fresh(current); // filled by other resolvers' scripts, not by this expression: once more in a new isolate
          current = ensure();
          script = compile(current, code);
        }
      }
      const started = performance.now();
      let out: unknown;
      try {
        setRegisters!.applySync(undefined, [itemIndex, Date.now()]);
        out = script.runSync(entry!.context, { timeout: EVAL_TIMEOUT_MS });
      } catch {
        // Only the timeout, a stack overflow or the memory limit escape the bootstrap's own try/catch.
        if (current.isolate.isDisposed) {
          fresh(current);
          throw new Error(`The expression used more than ${memoryMb} MB of memory`);
        }
        throw new Error(performance.now() - started >= EVAL_TIMEOUT_MS - 2 ? `Script execution timed out after ${EVAL_TIMEOUT_MS}ms` : 'The expression failed (out of stack)');
      }
      if (typeof out !== 'string') throw new Error('The expression failed');
      if (out[0] === 'E') throw new Error(out.slice(1));
      const json = out.slice(1);
      return json.includes('\\u0001') ? revive(JSON.parse(json)) : JSON.parse(json);
    },
  };
}
