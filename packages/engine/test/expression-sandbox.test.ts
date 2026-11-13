/** Expressions run in a sealed realm: nothing of the host is reachable, and the semantics stay those of V8. */
import { describe, expect, it } from 'vitest';
import { ExpressionError, ExpressionResolver, type ExpressionData } from '../src/expression';

const data = (extra: Record<string, unknown> = {}): ExpressionData => ({
  items: [{ json: { name: 'Ada', nested: { x: 1 }, list: [1, 2] } }, { json: { name: 'Bob' } }] as ExpressionData['items'],
  nodeOutputs: { A: [{ json: { v: 'a0' } }, { json: { v: 'a1' } }] },
  workflow: { id: 'w', name: 'W' },
  execution: { id: 'e', mode: 'manual' },
  parameters: {},
  ...extra,
} as ExpressionData);
const resolver = (extra?: Record<string, unknown>) => new ExpressionResolver(data(extra));

/** Whatever the expression does, it must not return anything that is (or reaches) a host object. */
function attempt(code: string, extra?: Record<string, unknown>): unknown {
  try {
    return resolver(extra).evaluate(code, 0);
  } catch (error) {
    expect(error).toBeInstanceOf(ExpressionError);
    return undefined;
  }
}
const isHost = (value: unknown) => typeof value === 'object' && value !== null && (value as { versions?: unknown }).versions !== undefined;

describe('sealed realm', () => {
  const escapes = [
    "$json.constructor.constructor('return process')()",
    "this.constructor.constructor('return process')()",
    "$input.all.constructor('return process')()",
    "$('A').constructor",
    "$('A').all.constructor('return process')()",
    "$fromAI.constructor('return process')()",
    "$node.A.constructor.constructor('return process')()",
    "Object.getPrototypeOf($json).constructor.constructor('return process')()",
    "(() => {}).constructor('return this')()",
    "(function () {}).constructor('return process')()",
    "eval('1')",
    "new Function('return process')()",
    'WebAssembly.compile(new Uint8Array())',
    "import('fs')",
    'globalThis.process',
    'typeof require',
    "Reflect.getPrototypeOf(async function () {}).constructor('return process')()",
    "$secrets.constructor.constructor('return process')()",
    "$now.constructor.constructor('return process')()",
  ];
  for (const code of escapes) {
    it(`gives no host access: ${code}`, () => {
      const value = attempt(code);
      expect(isHost(value)).toBe(false);
      expect(value === process || (typeof value === 'function')).toBe(false);
    });
  }

  it('does not let Error.prepareStackTrace read host frames', () => {
    const code =
      "(Error.prepareStackTrace = (e, frames) => frames.map((f) => [f.getThis(), f.getFunction()]), $input.all.call(null), (() => { try { $('Nope').all() } catch (e) { return typeof e.stack } })())";
    expect(() => resolver().evaluate(code, 0)).not.toThrow(TypeError);
    const out = attempt(code);
    expect(typeof out === 'string' || out === undefined).toBe(true);
  });

  it('keeps prototype pollution inside the realm', () => {
    attempt('$json.__proto__.polluted = 1');
    attempt('Object.prototype.polluted2 = 1');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined();
  });

  it('has no way to make a Promise (an unhandled rejection would end the host process)', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      for (const code of [
        "Promise.reject(new Error('x'))",
        'Promise.resolve().then(() => { while (true) {} })',
        "(async () => { throw 1 })()",
        "(async function () { await 1; return $json.constructor.constructor('return process')() })()",
        "[...async () => 1]",
        "import('fs').catch((e) => e.constructor.constructor('return process')())",
        "import\n/* c */ ('fs')",
        "WebAssembly.compile(new Uint8Array())",
        "WebAssembly.instantiate(new Uint8Array())",
        "Array.fromAsync([1])",
        "Atomics.waitAsync(new Int32Array(new SharedArrayBuffer(8)), 0, 0, 1).value.then(() => { throw 1 })",
        "Object.getPrototypeOf(Atomics).constructor",
        "(a => a++ /(async()=>{throw 'B1'})()/ 1)(1)",
        "(()=>{ var a = 1; a-- /(async()=>{throw 'B8'})()/ 1; return 1})()",
        "1. /(async()=>{throw 'B2'})()/ 1",
        "(()=>{ {} /'/; (async()=>{throw 'B3'})(); return '1' })()",
        "(()=>{ if (1) /'/.test(1); (async()=>{throw 'B5'})(); return '1' })()",
        "(()=>{ for (const x of []) /'/; (async()=>{throw 'B12'})(); return '1' })()",
        "new (class { async #x(){ throw 'B4' } y(){ this.#x(); return 1 } })().y()",
        "(()=>{ {} /'/; import('fs'); return '1' })()",
      ]) {
        attempt(code);
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(rejections).toEqual([]);
  });

  it('refuses async and import( with a clear message but allows them as property names', () => {
    expect(() => resolver().evaluate('(async () => 1)()', 0)).toThrow(/"async" is not available/);
    expect(() => resolver().evaluate("import('fs')", 0)).toThrow(/"import" is not available/);
    expect(resolver({ items: [{ json: { async: 1, import: 2 } }] }).evaluate('$json.async + $json.import', 0)).toBe(3);
  });

  it('allows the words async and import inside strings, keys, templates, regexes and comments', () => {
    const r = resolver({ items: [{ json: { mode: 'async', name: 'x', import: 5 } }] });
    expect(r.evaluate('$json.mode === "async"', 0)).toBe(true);
    expect(r.evaluate('"Your import finished: " + $json.name', 0)).toBe('Your import finished: x');
    expect(r.evaluate('$json["import"]', 0)).toBe(5);
    expect(r.evaluate('({ async: 1 }).async', 0)).toBe(1);
    expect(r.evaluate('`import ${1} ${`async ${2}`}`', 0)).toBe('import 1 async 2');
    expect(r.evaluate('/import/.test("x")', 0)).toBe(false);
    expect(r.evaluate('1 // async note', 0)).toBe(1);
    expect(r.evaluate('1 /* import( */ + 1', 0)).toBe(2);
    expect(r.evaluate('({ import: 2 }).import', 0)).toBe(2);
    expect(() => r.evaluate('`${import("fs")}`', 0)).toThrow(/"import" is not available/);
    expect(() => r.evaluate('"a" + async function () {}', 0)).toThrow(/"async" is not available/);
    expect(r.evaluate('({import(){return 1}}).import()', 0)).toBe(1);
    expect(r.evaluate('({async(){return 1}}).async()', 0)).toBe(1);
    expect(r.evaluate('(()=>{ const async = 2; return async * 2 })()', 0)).toBe(4);
    expect(() => r.evaluate("(()=>{ {} /'/; (async()=>{})(); return 1 })()", 0)).toThrow(/"async" is not available/);
  });

  it('has no FinalizationRegistry or WeakRef (their callbacks would run outside the timeout)', () => {
    expect(resolver().evaluate('typeof FinalizationRegistry', 0)).toBe('undefined');
    expect(resolver().evaluate('typeof WeakRef', 0)).toBe('undefined');
  });

  it('times out an endless loop', () => {
    const started = Date.now();
    expect(() => resolver().evaluate('(() => { while (true) {} })()', 0)).toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('answers a thrown getter or message without running it outside the timeout', () => {
    expect(() => resolver().evaluate('(() => { throw { get message() { return "boom" } } })()', 0)).toThrow(/boom/);
    expect(() => resolver().evaluate('(() => { throw 5 })()', 0)).toThrow(/5/);
    // A poisoned Error.prototype can't run in the host either: the timeout is told apart without reading the thrown value.
    const r = resolver();
    r.evaluate('Object.defineProperty(Error.prototype, "message", { get() { while (true) {} } })', 0);
    expect(() => r.evaluate('(() => { while (true) {} })()', 0)).toThrow(/timed out/);
  });

  it('cannot end the wrapper early with a crafted expression', () => {
    for (const code of ['1) }); throw 1; __eval(() => { return (2', '1), process.exit(']) expect(() => resolver().evaluate(code, 0)).toThrow(ExpressionError);
    // Valid on its own as two statements, but inside the wrapper everything after the return is dead code.
    expect(resolver().evaluate('1); throw { get message() { while (1) {} } }; (2', 0)).toBe(1);
  });

  it('returns host-realm values', () => {
    const list = resolver().evaluate('[1, {a: [2]}]', 0);
    const object = resolver().evaluate('({ a: 1 })', 0) as object;
    expect(Array.isArray(list)).toBe(true);
    expect(list).toBeInstanceOf(Array);
    expect(object).toBeInstanceOf(Object);
    expect(Object.getPrototypeOf(object)).toBe(Object.prototype);
    expect((resolver().evaluate('$json', 0) as { list: unknown }).list).toBeInstanceOf(Array);
  });

  it('keeps types JSON cannot carry', () => {
    const r = resolver();
    expect(r.evaluate('$now', 0)).toBeInstanceOf(Date);
    expect(r.evaluate('new Date("2020-01-02T03:04:05Z")', 0)).toEqual(new Date('2020-01-02T03:04:05Z'));
    expect(r.evaluate('new Date("x")', 0)).toBeInstanceOf(Date);
    expect(r.evaluate('undefined', 0)).toBeUndefined();
    expect(r.evaluate('[1, undefined, 3]', 0)).toEqual([1, undefined, 3]);
    expect(r.evaluate('({ a: undefined })', 0)).toHaveProperty('a', undefined);
    expect(r.evaluate('NaN', 0)).toBeNaN();
    expect(r.evaluate('1 / 0', 0)).toBe(Infinity);
    expect(r.evaluate('-1 / 0', 0)).toBe(-Infinity);
    expect(Object.is(r.evaluate('-0', 0), -0)).toBe(true);
    expect(r.evaluate('10n ** 20n', 0)).toBe('100000000000000000000');
    expect(r.evaluate('() => 1', 0)).toBeUndefined();
    expect(r.evaluate('({ ["__proto__"]: 1 })', 0)).toEqual(expect.objectContaining({}));
  });

  it('keeps V8 and Intl semantics', () => {
    const r = resolver();
    expect(r.evaluate("$now.toLocaleDateString('en-US')", 0)).toBe(new Date().toLocaleDateString('en-US'));
    expect(r.evaluate("(1234.5).toLocaleString('de-DE')", 0)).toBe('1.234,5');
    expect(r.evaluate('$today.getHours()', 0)).toBe(0);
    expect(r.evaluate('$json.name + " " + $json.nested.x', 0)).toBe('Ada 1');
    expect(r.evaluate('$json.name', 1)).toBe('Bob');
    expect(r.evaluate('$itemIndex', 1)).toBe(1);
  });

  it('reads items, nodes and pairing as the host accessors do', () => {
    const r = resolver();
    expect(r.evaluate('$input.item.json.name', 1)).toBe('Bob');
    expect(r.evaluate('$input.all().length', 0)).toBe(2);
    expect(r.evaluate('$input.first().json.name', 1)).toBe('Ada');
    expect(r.evaluate('$input.last().json.name', 0)).toBe('Bob');
    expect(r.evaluate("$('A').item.json.v", 1)).toBe('a1');
    expect(r.evaluate("$('A').json.v", 5)).toBe('a0');
    expect(r.evaluate("$('A').itemMatching(1).json.v", 0)).toBe('a1');
    expect(() => r.evaluate("$('A').itemMatching(9)", 0)).toThrow(/no item matching input item 9/);
    expect(r.evaluate("$('A').isExecuted", 0)).toBe(true);
    expect(r.evaluate("$('Nope').isExecuted", 0)).toBe(false);
    expect(() => r.evaluate("$('Nope').first()", 0)).toThrow(/has not run yet/);
    expect(r.evaluate("$node['A'].json.v", 0)).toBe('a0');
    expect(r.evaluate('$node.A.items.length', 0)).toBe(2);
    expect(r.evaluate('$node.Nope', 0)).toBeUndefined();
    expect(r.evaluate('$node.constructor', 0)).toBeUndefined();
  });

  it('reads variables, composite, execution, parameters and tool arguments', () => {
    const r = resolver({ variables: { REGION: 'eu' }, composite: { id: 'c', name: 'C', type: 't', params: { p: 1 } }, parameters: { q: 'raw' }, toolArgs: { city: 'Oslo' } });
    expect(r.evaluate('$vars.REGION', 0)).toBe('eu');
    expect(r.evaluate('$vars.NOPE', 0)).toBeUndefined();
    expect(r.evaluate('$composite.params.p', 0)).toBe(1);
    expect(resolver().evaluate('$composite.params', 0)).toEqual({});
    expect(r.evaluate('$execution.mode + $workflow.id', 0)).toBe('manualw');
    expect(r.evaluate('$parameter.q', 0)).toBe('raw');
    expect(r.evaluate('$fromAI("city")', 0)).toBe('Oslo');
    expect(r.evaluate('$fromAI("zip", "d", "string", "0000")', 0)).toBe('0000');
    expect(r.evaluate('$fromAI("zip")', 0)).toBe('');
    expect(r.evaluate('Object.isFrozen($vars)', 0)).toBe(true);
  });

  it('keeps $secrets read-only and strict', () => {
    const r = resolver({ secrets: { vault: { db: { password: 'pw' }, token: 't' } } });
    expect(r.evaluate('$secrets.vault.token', 0)).toBe('t');
    expect(r.evaluate('$secrets.vault.db.password', 0)).toBe('pw');
    expect(() => r.evaluate('$secrets.aws.x', 0)).toThrow(/No secret of external secrets provider "aws"/);
    expect(() => r.evaluate('$secrets.vault.other', 0)).toThrow(/was not loaded/);
    expect(() => r.evaluate('($secrets.vault.token = 1)', 0)).toThrow(/read-only/);
    expect(() => resolver().evaluate('$secrets.vault.x', 0)).toThrow(/only be used in credential fields/);
  });

  it('keeps the items-is-not-defined hint and the expression on errors', () => {
    try {
      resolver().evaluate('items.length', 0);
      expect.unreachable();
    } catch (error) {
      expect((error as ExpressionError).message).toMatch(/items is not defined \(an expression sees/);
      expect((error as ExpressionError).expression).toBe('items.length');
    }
    expect(() => resolver().evaluate('1 +', 0)).toThrow(ExpressionError);
  });

  it('copies each item once and never lets an expression change the host data', () => {
    const d = data();
    const r = new ExpressionResolver(d);
    r.evaluate('($json.name = "changed", 1)', 0);
    r.evaluate('$input.all().push(1)', 0);
    expect(d.items[0]!.json.name).toBe('Ada');
    expect(d.items).toHaveLength(2);
  });

  it('resolves strings, a single raw expression and nested parameters', () => {
    const r = resolver();
    expect(r.resolveValue('Hello {{ $json.name }}', 0)).toBe('Hello Ada');
    expect(r.resolveValue('={{ $json.list }}', 0)).toEqual([1, 2]);
    expect(r.resolveValue({ a: ['{{ 1 + 1 }}'] }, 0)).toEqual({ a: [2] });
  });
});
