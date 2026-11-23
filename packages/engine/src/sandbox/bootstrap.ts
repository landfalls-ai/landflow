/**
 * The JavaScript that runs INSIDE the expression realm (see ./realm.ts), once per resolver. It is a string, not a
 * function, on purpose: a transpiler or bundler must not rewrite it, and it must never share a scope with host code.
 *
 * It defines everything an expression can name (`$json`, `$input`, `$('Node')`, `$node`, `$secrets`, `$fromAI`, …)
 * with the behaviour the host-side accessors have in expression.ts, and takes its data lazily through ONE host
 * function, `bridge(op, arg) -> string`, that is captured here and deleted from the global. Only text crosses the
 * boundary, in both directions: no host object is ever reachable from an expression, so `x.constructor.constructor`
 * and friends only find the realm's own Function (whose code generation is switched off by the context).
 *
 * The script's completion value is the register array `[itemIndex, nowMs]` the host writes before each evaluation.
 * `__eval(fn)` (also defined here, and locked) runs the expression, converts the result to tagged JSON inside the
 * same timeout, and returns `'V' + json` or `'E' + message`: the host never touches a realm object except the
 * register array (typed arrays have no accessor-able elements, so writing an index runs no realm code).
 *
 * Written without template literals and `${` so it can live in String.raw.
 */
export const BOOTSTRAP_SOURCE = String.raw`(function () {
  'use strict';
  const g = globalThis;
  const bridge = g.__bridge;
  delete g.__bridge;

  // Primordials: expressions may rewrite builtins (their own realm only); this code keeps using the originals.
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const isArray = Array.isArray;
  const freeze = Object.freeze;
  const assign = Object.assign;
  const keysOf = Object.keys;
  const defineProperty = Object.defineProperty;
  const create = Object.create;
  const hasOwn = Object.hasOwn;
  const DateC = Date;
  const ErrorC = Error;
  const ProxyC = Proxy;
  const StringC = String;
  const NumberC = Number;
  const getTime = Date.prototype.getTime;
  const toDateString = Date.prototype.toDateString;
  const isNaNn = Number.isNaN;
  const TAG = '\u0001';

  // No stack frames are captured, so a user-set Error.prepareStackTrace has nothing (host frames included) to read.
  defineProperty(ErrorC, 'stackTraceLimit', { value: 0, writable: false, configurable: false });
  defineProperty(ErrorC, 'prepareStackTrace', { value: undefined, writable: false, configurable: false });

  // Nothing in here may make a Promise that can reject: Node reports an unhandled rejection of ANY context to the host
  // process, which exits on it by default. Promises are made inert (no then, no constructor), the globals and builtins
  // that return one are removed, and the host refuses async and import( in an expression's source.
  const promiseProto = Promise.prototype;
  delete promiseProto.then;
  delete promiseProto.catch;
  delete promiseProto.finally;
  defineProperty(promiseProto, 'constructor', { value: undefined, writable: false, configurable: false });
  freeze(promiseProto);
  delete g.Promise;
  delete g.WebAssembly;
  // Finalizer callbacks run later on the host's event loop, outside any timeout (and a throw in one is an uncaughtException).
  delete g.FinalizationRegistry;
  delete g.WeakRef;
  delete Array.fromAsync;
  delete Atomics.waitAsync;
  // Node 24+: AsyncDisposableStack.prototype.disposeAsync() returns a promise that rejects when a disposer throws.
  delete g.AsyncDisposableStack;

  const regs = new Float64Array(2); // [item index, now in ms]

  const call = (op, arg) => {
    const reply = parse(bridge(op, arg === undefined ? '' : arg));
    if (reply.e !== undefined) throw new ErrorC(reply.e);
    return reply.v;
  };

  // A list of items read lazily and cached for the life of the resolver: one item at a time until all() is asked for.
  function source(hasOp, atOp, allOp, name) {
    let has;
    let all;
    const parsed = create(null);
    return {
      has: () => (has === undefined ? (has = call(hasOp, name)) : has),
      all: () => (all === undefined ? (all = call(allOp, name)) : all),
      at: (index) => {
        if (all !== undefined) return all[index];
        const key = StringC(index);
        if (!(key in parsed)) parsed[key] = call(atOp, name === undefined ? key : stringify([name, index]));
        return parsed[key] === null ? undefined : parsed[key];
      },
    };
  }

  // nodeAccessor() of expression.ts.
  function accessor(name, src) {
    const list = () => {
      if (!src.has()) throw new ErrorC('Node "' + name + '" has not run yet (or produced no output)');
      return src.all();
    };
    const current = () => {
      if (!src.has()) throw new ErrorC('Node "' + name + '" has not run yet (or produced no output)');
      const found = src.at(regs[0]);
      return found !== undefined ? found : src.at(0);
    };
    return {
      all: () => list(),
      first: () => list()[0],
      last: () => {
        const items = list();
        return items[items.length - 1];
      },
      itemMatching(index) {
        if (!src.has()) throw new ErrorC('Node "' + name + '" has not run yet (or produced no output)');
        const matched = src.at(index);
        if (!matched) throw new ErrorC('Node "' + name + '" has no item matching input item ' + index);
        return matched;
      },
      get item() {
        return current();
      },
      get json() {
        const item = current();
        return item === undefined ? undefined : item.json;
      },
      get binary() {
        const item = current();
        return item === undefined ? undefined : item.binary;
      },
      isExecuted: src.has(),
    };
  }

  // legacyNodeData() of expression.ts.
  function legacy(src) {
    if (!src.has()) return undefined;
    return {
      get json() {
        const first = src.at(0);
        return first === undefined ? undefined : first.json;
      },
      get binary() {
        const first = src.at(0);
        return first === undefined ? undefined : first.binary;
      },
      get items() {
        return src.all();
      },
    };
  }

  const input = source('inputHas', 'inputItem', 'inputItems');
  const inputAccessor = accessor(undefined, input);
  const nodes = create(null);
  const nodeSource = (name) => {
    const key = StringC(name);
    if (!(key in nodes)) nodes[key] = source('nodeHas', 'nodeItem', 'nodeItems', key);
    return nodes[key];
  };

  let statics;
  const staticData = () => (statics === undefined ? (statics = call('static')) : statics);
  const lazy = (name, make) => {
    let made = false;
    let value;
    defineProperty(g, name, {
      configurable: true,
      enumerable: true,
      get: () => {
        if (!made) {
          value = make();
          made = true;
        }
        return value;
      },
    });
  };

  const fail = () => {
    throw new ErrorC('$secrets is read-only');
  };
  const readOnly = { set: fail, defineProperty: fail, deleteProperty: fail };
  const skipKey = (key) => typeof key === 'symbol' || key === 'then' || key === 'toJSON';
  const secrets = new ProxyC(freeze({}), {
    set: fail,
    defineProperty: fail,
    deleteProperty: fail,
    get: (_target, provider) => {
      if (skipKey(provider)) return undefined;
      call('secretProvider', provider);
      return new ProxyC(freeze({}), {
        set: fail,
        defineProperty: fail,
        deleteProperty: fail,
        get: (_inner, name) => {
          if (skipKey(name)) return undefined;
          const value = call('secret', stringify([provider, name]));
          return typeof value === 'object' && value !== null ? freeze(assign({}, value)) : value;
        },
      });
    },
  });

  let now;
  let today;
  defineProperty(g, '$json', {
    configurable: true,
    enumerable: true,
    get: () => {
      const item = input.at(regs[0]);
      return item === undefined || item === null || item.json === undefined || item.json === null ? {} : item.json;
    },
  });
  defineProperty(g, '$input', { configurable: true, enumerable: true, get: () => inputAccessor });
  defineProperty(g, '$itemIndex', { configurable: true, enumerable: true, get: () => regs[0] });
  defineProperty(g, '$now', { configurable: true, enumerable: true, get: () => (now === undefined ? (now = new DateC(regs[1])) : now) });
  defineProperty(g, '$today', {
    configurable: true,
    enumerable: true,
    get: () => (today === undefined ? (today = new DateC(toDateString.call(new DateC(regs[1])))) : today),
  });
  lazy('$workflow', () => staticData().workflow);
  lazy('$execution', () => staticData().execution);
  lazy('$parameter', () => call('parameters'));
  lazy('$vars', () => freeze(assign({}, staticData().variables)));
  lazy('$composite', () => {
    const composite = staticData().composite;
    return freeze(assign({}, composite, { params: freeze(assign({}, composite && composite.params)) }));
  });
  defineProperty(g, '$secrets', { configurable: true, enumerable: true, get: () => secrets });
  defineProperty(g, '$', {
    configurable: true,
    enumerable: true,
    get: () => (name) => accessor(name, nodeSource(name)),
  });
  const nodeProxy = new ProxyC(create(null), {
    get: (_target, name) => (typeof name === 'symbol' ? undefined : legacy(nodeSource(name))),
  });
  defineProperty(g, '$node', { configurable: true, enumerable: true, get: () => nodeProxy });
  defineProperty(g, '$fromAI', {
    configurable: true,
    enumerable: true,
    get: () => (key, _description, _type, fallback) => {
      const found = call('toolArg', StringC(key));
      if (found !== undefined && found !== null) return found;
      return fallback !== undefined && fallback !== null ? fallback : '';
    },
  });

  // The result of an expression as tagged JSON: what JSON cannot say (undefined, NaN, Infinity, -0, Date) is a
  // one-key object under TAG; the host turns it back into the value.
  const isDate = (value) => {
    try {
      getTime.call(value);
      return true;
    } catch (_e) {
      return false;
    }
  };
  const convert = (value, seen) => {
    switch (typeof value) {
      case 'undefined':
      case 'function':
      case 'symbol':
        return { [TAG]: 'u' };
      case 'bigint':
        return StringC(value);
      case 'number':
        if (value === 0 && 1 / value < 0) return { [TAG]: 'n', v: '-0' };
        if (isNaNn(value) || value === Infinity || value === -Infinity) return { [TAG]: 'n', v: StringC(value) };
        return value;
      case 'object': {
        if (value === null) return null;
        if (isDate(value)) {
          const time = getTime.call(value);
          return { [TAG]: 'd', v: isNaNn(time) ? null : time };
        }
        if (seen.indexOf(value) !== -1) throw new ErrorC('Converting circular structure to JSON');
        seen.push(value);
        let out;
        if (isArray(value)) {
          out = [];
          for (let i = 0; i < value.length; i++) out[i] = convert(value[i], seen);
        } else if (typeof value.toJSON === 'function') {
          out = convert(value.toJSON(), seen);
        } else {
          out = create(null);
          const names = keysOf(value);
          for (let i = 0; i < names.length; i++) out[names[i]] = convert(value[names[i]], seen);
        }
        seen.pop();
        return out;
      }
      default:
        return value;
    }
  };
  const message = (error) => {
    try {
      return StringC(typeof error === 'object' && error !== null ? error.message : error);
    } catch (_e) {
      return 'Expression error';
    }
  };
  const run = (fn) => {
    now = undefined;
    today = undefined;
    try {
      return 'V' + stringify(convert(fn(), []));
    } catch (error) {
      return 'E' + message(error);
    }
  };
  defineProperty(g, '__eval', { value: run, writable: false, configurable: false, enumerable: false });
  return regs;
})()`;
