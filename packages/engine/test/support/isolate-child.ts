// One expression in a process of its own (argv[2]), against the isolate backend with the default cap: the parent test
// treats a crash (a V8 abort) as a failure. Prints `failed: <message>` or `done`, then `alive` when a fresh resolver still works.
import { configureExpressionSandbox, ExpressionResolver, type ExpressionData } from '../../src/expression';

const data = {
  items: [{ json: { name: 'Ada', n: 1 } }],
  nodeOutputs: {},
  workflow: { id: 'w', name: 'W' },
  execution: { id: 'e', mode: 'manual' },
  parameters: {},
} as ExpressionData;

configureExpressionSandbox({ backend: 'isolate', memoryMb: 64 });
try {
  new ExpressionResolver(data).evaluate(process.argv[2], 0);
  console.log('done');
} catch (error) {
  console.log(`failed: ${(error as Error).message}`);
}
console.log(new ExpressionResolver(data).evaluate('$json.n', 0) === 1 ? 'alive' : 'broken');
