/**
 * The isolate expression backend (isolated-vm): the whole sealed-realm suite against it, a memory bomb that must fail
 * only the expression, and a benchmark against the realm. Skipped unless LANDFLOW_INTEGRATION=isolate; run it with
 * NODE_OPTIONS=--no-node-snapshot (isolated-vm needs it on Node 20+).
 */
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

describe.skipIf(!on)('isolate backend', () => {
  beforeAll(() => configureExpressionSandbox({ backend: 'isolate', memoryMb: 64 }));
  afterAll(() => configureExpressionSandbox({}));

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

  it('survives the usual bombs', () => {
    const bombs = [
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
    ];
    for (const code of bombs) {
      try {
        new ExpressionResolver(data).evaluate(code, 0);
      } catch (error) {
        expect(error).toBeInstanceOf(ExpressionError);
      }
    }
    expect(new ExpressionResolver(data).evaluate('$json.n', 0)).toBe(1);
  }, 60_000);

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
});

// The sealed-realm suite, unchanged, now resolving through the isolate (its resolvers read the configured backend).
if (on) {
  configureExpressionSandbox({ backend: 'isolate', memoryMb: 64 });
  await import('./expression-sandbox.test');
}
