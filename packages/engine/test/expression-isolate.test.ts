/**
 * The isolate expression backend (isolated-vm): the whole sealed-realm suite against it, a memory bomb that must fail
 * only the expression, and a benchmark against the realm. Skipped unless LANDFLOW_INTEGRATION=isolate; run it with
 * NODE_OPTIONS=--no-node-snapshot (isolated-vm needs it on Node 20+).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureExpressionSandbox, ExpressionError, ExpressionResolver, type ExpressionData } from '../src/expression';

const on = (process.env.LANDFLOW_INTEGRATION ?? '').split(',').includes('isolate');
const data: ExpressionData = {
  items: [{ json: { name: 'Ada', n: 1 } }],
  nodeOutputs: {},
  workflow: { id: 'w', name: 'W' },
  execution: { id: 'e', mode: 'manual' },
  parameters: {},
} as ExpressionData;

// The backend stays configured for the whole file, including the realm suite imported at the bottom, whose tests
// create their resolvers when they run (after the describe below has finished).
beforeAll(() => {
  if (on) configureExpressionSandbox({ backend: 'isolate', memoryMb: 64 });
});
afterAll(() => configureExpressionSandbox({}));

/** One expression in a process of its own: a V8 abort is a test failure here, not the end of the test run. */
function inChild(code: string, memoryMb = 64) {
  const support = (name: string) => fileURLToPath(new URL(`./support/${name}`, import.meta.url));
  const run = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', '--import', support('ts-register.mjs'), support('isolate-child.ts'), code, String(memoryMb)],
    { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '--no-node-snapshot' }, timeout: 30_000 },
  );
  return { status: run.status, signal: run.signal, out: run.stdout.trim().split('\n'), err: run.stderr.slice(0, 300) };
}

describe.skipIf(!on)('isolate backend', () => {
  it('evaluates in an isolate', () => {
    expect(new ExpressionResolver(data).evaluate('$json.name + 1', 0)).toBe('Ada1');
  });

  it('fails a memory bomb without taking the process down, and keeps working afterwards', () => {
    const resolver = new ExpressionResolver(data);
    const other = new ExpressionResolver(data);
    expect(other.evaluate('$json.n', 0)).toBe(1);
    expect(() => resolver.evaluate('(() => { const a = []; while (true) a.push(new Array(1e6).fill(1)); })()', 0)).toThrow(ExpressionError);
    expect(() => resolver.evaluate('new Array(1e8).fill(1).length', 0)).toThrow(ExpressionError);
    // Both resolvers get a fresh context in a fresh isolate.
    expect(resolver.evaluate('$json.name', 0)).toBe('Ada');
    expect(other.evaluate('$json.n + 1', 0)).toBe(2);
  });

  it('survives the usual bombs, each in a process of its own', () => {
    const bombs = [
      'Array.from({ length: 1e8 }, () => 1).length',
      'Array.from({ length: 6e7 }, function () {}).length',
      'Array.from.call(Array, { length: 1e8 }, (x) => x).length',
      'new Map(Array.from({ length: 1e8 }, () => [1, 2])).size',
      'Array(1e8).fill().length',
      'new Array(2 ** 32 - 1).fill(0)',
      'Array.prototype.fill.call({ length: 1e8 }, 1)',
      'Array.prototype.join.call({ length: 1e8 })',
      'Array.prototype.map.call({ length: 6e7 }, (x) => 1).length',
      '[].concat({ length: 6e7, [Symbol.isConcatSpreadable]: true }).length',
      'new Array(1e8).toSorted().length',
      'new Array(6e7).toSpliced(0, 0, 1).length',
      '[...new Array(5e7)].length',
      'Math.max(...new Array(1e8))',
      '(() => { const a = []; while (true) a.push(new Array(1e6).fill(1)); })()',
      'new Array(1e8).fill(1)',
      'Array(1e9).fill(0).length',
      '"x".repeat(2 ** 28)',
      '"x".padEnd(2 ** 28, "y")',
      'new Array(1e8).join("x")',
      'Array.from({ length: 1e8 }).length',
      '(() => { let s = "xxxxxxxx"; while (true) s += s; })()',
      '(() => { const a = []; while (true) a.push({ x: [1, 2, 3] }); })()',
      'new Uint8Array(2 ** 30).length',
      'new ArrayBuffer(2 ** 31).byteLength',
      '(() => { const s = new WeakMap(); for (let i = 0; ; i++) s.set({}, i); })()',
    ];
    for (const code of bombs) {
      const result = inChild(code);
      expect({ code, status: result.status, signal: result.signal, err: result.err }).toEqual({ code, status: 0, signal: null, err: '' });
      expect(result.out.at(-1)).toBe('alive');
    }
  }, 240_000);

  // The known limit, pinned so that the docs are corrected the day it is closed: hash-table growth aborts the process
  // (V8's heap OOM) before the cap or the timeout can end the evaluation. engine.md and limitations.md say so.
  it('still aborts the process on hash-table growth (documented limit)', () => {
    const aborting = [
      '(() => { const s = new Set(); for (let i = 0; ; i++) s.add(i); })()',
      '(() => { const o = {}; for (let i = 0; ; i++) o[i * 1000] = i; })()',
      'Object.groupBy(Array(2000000).fill(0), (x, i) => i)',
    ];
    for (const code of aborting) {
      const result = inChild(code);
      expect({ code, aborted: result.status !== 0 || result.signal !== null }).toEqual({ code, aborted: true });
    }
  }, 120_000);

  it('does not fail an innocent expression when thousands of short-lived resolvers come and go', () => {
    const failures: string[] = [];
    for (let n = 0; n < 5_000; n++) {
      try {
        expect(new ExpressionResolver(data).evaluate(`$json.name + ${n}`, 0)).toBe(`Ada${n}`);
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('rebuilds a resolver whose context was released', () => {
    const first = new ExpressionResolver(data);
    expect(first.evaluate('$json.n', 0)).toBe(1);
    for (let n = 0; n < 100; n++) new ExpressionResolver(data).evaluate('1', 0);
    expect(first.evaluate('$json.n + 1', 0)).toBe(2);
  });

  it('times out an endless loop', () => {
    expect(() => new ExpressionResolver(data).evaluate('(() => { while (true); })()', 0)).toThrow(/timed out/);
  });

  it('stays within 1.5x of the realm', () => {
    const items = Array.from({ length: 1_000 }, (_, i) => ({ json: { name: `n${i}`, nested: { x: i } } }));
    const big = { ...data, items } as ExpressionData;
    const time = (backend: 'realm' | 'isolate') => {
      const resolver = new ExpressionResolver(big, { backend });
      const started = performance.now();
      for (let n = 0; n < 20_000; n++) resolver.evaluate('$json.name + " " + $json.nested.x', n % 1_000);
      return performance.now() - started;
    };
    time('realm');
    time('isolate');
    const realm = Math.min(time('realm'), time('realm'));
    const isolate = Math.min(time('isolate'), time('isolate'));
    console.log(`realm ${realm.toFixed(0)} ms, isolate ${isolate.toFixed(0)} ms, ratio ${(isolate / realm).toFixed(2)}`);
    expect(isolate).toBeLessThanOrEqual(realm * 1.5);
  }, 120_000);

  it('stays within 2x of the realm with a fresh resolver per evaluation, as the executor makes them', () => {
    const time = (backend: 'realm' | 'isolate') => {
      const started = performance.now();
      for (let n = 0; n < 5_000; n++) new ExpressionResolver(data, { backend }).evaluate(`$json.name + ${n}`, 0);
      return performance.now() - started;
    };
    time('realm');
    time('isolate');
    const realm = Math.min(time('realm'), time('realm'));
    const isolate = Math.min(time('isolate'), time('isolate'));
    console.log(`fresh resolvers: realm ${realm.toFixed(0)} ms, isolate ${isolate.toFixed(0)} ms, ratio ${(isolate / realm).toFixed(2)}`);
    expect(isolate).toBeLessThanOrEqual(realm * 2);
  }, 120_000);
});

// The sealed-realm suite, unchanged, now resolving through the isolate (its resolvers read the configured backend).
if (on) {
  configureExpressionSandbox({ backend: 'isolate', memoryMb: 64 });
  await import('./expression-sandbox.test');
  // Runs after the imported tests were registered, in the same run: proof they resolve through the isolate and not the realm.
  describe('imported realm suite', () => {
    it('is running on the isolate', () => {
      expect(() => new ExpressionResolver(data).evaluate('"x".repeat(64 * 262144 + 1).length', 0)).toThrow(/Invalid string length/);
    });
  });
}
