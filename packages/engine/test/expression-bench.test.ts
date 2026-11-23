/**
 * Budget check for the sealed realm: 100k evaluations of `$json.name + " " + $json.nested.x` over 1k items must stay
 * within 1.25x of the old in-context evaluation (inlined below). Skipped unless LANDFLOW_BENCH=1.
 */
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ExpressionResolver } from '../src/expression';

const ITEMS = 1_000;
const RUNS = 100_000;
const CODE = '$json.name + " " + $json.nested.x';
const items = Array.from({ length: ITEMS }, (_, i) => ({ json: { name: `n${i}`, nested: { x: i } } }));

function oldEvaluation(): number {
  const script = new vm.Script(`(${CODE})`);
  const sandbox: Record<string, unknown> = {};
  const context = vm.createContext(sandbox);
  const started = performance.now();
  for (let n = 0; n < RUNS; n++) {
    sandbox.$itemIndex = n % ITEMS;
    sandbox.$json = items[n % ITEMS]!.json;
    sandbox.$now = new Date();
    sandbox.$today = new Date(new Date().toDateString());
    script.runInContext(context, { timeout: 250 });
  }
  return performance.now() - started;
}

function newEvaluation(): number {
  const resolver = new ExpressionResolver({ items, nodeOutputs: {}, workflow: { id: 'w', name: 'W' }, execution: { id: 'e', mode: 'manual' }, parameters: {} });
  const started = performance.now();
  for (let n = 0; n < RUNS; n++) resolver.evaluate(CODE, n % ITEMS);
  return performance.now() - started;
}

describe.skipIf(process.env.LANDFLOW_BENCH !== '1')('expression benchmark', () => {
  it('stays within 1.25x of the old evaluation', () => {
    const timings = { old: [] as number[], sealed: [] as number[] };
    for (let round = 0; round < 3; round++) {
      timings.sealed.push(newEvaluation());
      timings.old.push(oldEvaluation());
    }
    const before = Math.min(...timings.old);
    const after = Math.min(...timings.sealed);
    console.log(JSON.stringify(timings));
    console.log(`old ${((before / RUNS) * 1000).toFixed(1)} us, sealed realm ${((after / RUNS) * 1000).toFixed(1)} us per evaluation, ratio ${(after / before).toFixed(2)}`);
    expect(after).toBeLessThanOrEqual(before * 1.25);
  }, 120_000);
});
