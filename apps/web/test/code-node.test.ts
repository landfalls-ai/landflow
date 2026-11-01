/**
 * The Code node through the sandboxed code runner (services/code-runner), started in-process on a random port:
 * JavaScript and Python in both modes, `$('Node')` / `_('Node')` from the engine, `$vars`, logs, errors with line
 * numbers, and where the node runs for each combination of Language, Run In and host settings.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startCodeRunner, type CodeRunner } from '@landflow/code-runner';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-code-node-'));
const previousDir = process.env.LANDFLOW_DATA_DIR;
process.env.LANDFLOW_DATA_DIR = dataDir;

const { variables } = await import('@/lib/server/variables');
const { codeNode } = await import('@/lib/server/nodes/code');
const { codeRunnerSettings, nodesReferenced, placeCode } = await import('@/lib/server/code-runner');
const { outputsOf, run, runFlow, runOk } = await import('./helpers');

const SECRET = 'web-test-secret';
const ENV = ['LANDFLOW_CODE_RUNNER_URL', 'LANDFLOW_CODE_RUNNER_SECRET', 'LANDFLOW_CODE_IN_PROCESS'] as const;
const hasPython = (() => {
  try {
    execFileSync('python3', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

let runner: CodeRunner;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  // The CPU limit sits far below the wall-clock timeout so a busy loop hits it first even on a loaded machine.
  runner = await startCodeRunner({ secret: SECRET, port: 0, limits: { timeoutMs: 10_000, cpuSeconds: 1, memoryMb: 128, maxOutputBytes: 1024 * 1024, fileSizeMb: 1 } }, {});
  for (const key of ENV) saved[key] = process.env[key];
  if (!variables.get('REGION')) variables.create({ key: 'REGION', value: 'eu-west-1' });
});

afterAll(async () => {
  await runner?.close();
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  process.env.LANDFLOW_DATA_DIR = previousDir;
});

beforeEach(() => {
  process.env.LANDFLOW_CODE_RUNNER_URL = runner.url;
  process.env.LANDFLOW_CODE_RUNNER_SECRET = SECRET;
  delete process.env.LANDFLOW_CODE_IN_PROCESS;
});

afterEach(() => {
  for (const key of ENV) delete process.env[key];
});

/** Start → Customers (Edit Fields) → Code, so `$('Customers')` resolves through the engine. */
async function flow(parameters: Record<string, unknown>, input = [{ name: 'Ada' }, { name: 'Linus' }]) {
  return runFlow(
    [
      { name: 'Customers', type: 'core.set', parameters: { mode: 'manual', fields: { values: [{ name: 'customer', type: 'string', value: 'C-{{ $json.name }}' }] } } },
      { name: 'Code', type: 'core.code', parameters },
    ],
    [
      ['Start', 'Customers'],
      ['Customers', 'Code'],
    ],
    { input },
  );
}

describe('Code node in the sandbox', () => {
  it('runs JavaScript for all items with $input, $(), $vars and Luxon (the default once a runner is configured)', async () => {
    const result = await flow({
      mode: 'all',
      code: "return $input.all().map((item, i) => ({ customer: item.json.customer, first: $('Customers').first().json.customer, region: $vars.REGION, year: DateTime.fromISO('2026-05-01').year, i }));",
    });
    expect(outputsOf(result, 'Code')[0]).toEqual([
      { customer: 'C-Ada', first: 'C-Ada', region: 'eu-west-1', year: 2026, i: 0 },
      { customer: 'C-Linus', first: 'C-Ada', region: 'eu-west-1', year: 2026, i: 1 },
    ]);
  });

  it('runs JavaScript for each item with $json and the paired $().item', async () => {
    const result = await flow({ mode: 'each', codeEach: "return { name: $json.name, customer: $('Customers').item.json.customer, index: $itemIndex };" }, [{ name: 'Ada' }, { name: 'Grace' }]);
    expect(outputsOf(result, 'Code')[0]).toEqual([
      { name: 'Ada', customer: 'C-Ada', index: 0 },
      { name: 'Grace', customer: 'C-Grace', index: 1 },
    ]);
  });

  it.skipIf(!hasPython)('runs Python for all items and for each item with _input, _json and _()', async () => {
    const all = await flow({
      language: 'python',
      mode: 'all',
      pythonCode: "return [{'customer': item.json.customer, 'first': _('Customers').first().json.customer, 'region': _vars.REGION} for item in _input.all()]",
    });
    expect(outputsOf(all, 'Code')[0]).toEqual([
      { customer: 'C-Ada', first: 'C-Ada', region: 'eu-west-1' },
      { customer: 'C-Linus', first: 'C-Ada', region: 'eu-west-1' },
    ]);
    const each = await flow({ language: 'python', mode: 'each', pythonCodeEach: "return {'upper': _json['name'].upper(), 'customer': _('Customers').item.json.customer}" });
    expect(outputsOf(each, 'Code')[0]).toEqual([
      { upper: 'ADA', customer: 'C-Ada' },
      { upper: 'LINUS', customer: 'C-Linus' },
    ]);
  });

  it('turns console output into node logs and keeps paired items', async () => {
    const result = await runOk(codeNode, { mode: 'each', codeEach: "console.log('item', $itemIndex);\nconsole.warn({ name: $json.name });\nreturn $json;" }, [{ name: 'Ada' }, { name: 'Linus' }]);
    expect(result.outputs[0].map((item) => item.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
    expect(result.logs?.map(({ level, message }) => ({ level, message }))).toEqual([
      { level: 'info', message: 'item 0' },
      { level: 'warn', message: "{ name: 'Ada' }" },
      { level: 'info', message: 'item 1' },
      { level: 'warn', message: "{ name: 'Linus' }" },
    ]);
  });

  it('reports errors n8n-style, with the line and the item', async () => {
    const js = await run(codeNode, { mode: 'all', code: 'const a = 1;\nreturn a.b.c;' });
    expect(js.error?.message).toBe("TypeError: Cannot read properties of undefined (reading 'c') [line 2]");
    expect(js.error?.description).toContain('code.js:2');
    const each = await run(codeNode, { mode: 'each', codeEach: "if ($itemIndex === 1) throw new Error('no');\nreturn $json;" }, [{}, {}]);
    expect(each.error?.message).toBe('Error: no [line 1, for item 1]');
    const syntax = await run(codeNode, { mode: 'all', code: 'return {' });
    expect(syntax.error?.message).toBe('SyntaxError: Unexpected end of input [line 1]');
    if (hasPython) {
      const py = await run(codeNode, { language: 'python', mode: 'all', pythonCode: "x = {}\nreturn x['missing']" });
      expect(py.error?.message).toBe("KeyError: 'missing' [line 2]");
    }
    const flowResult = await flow({ mode: 'all', code: "return $('Nowhere').all();" });
    expect(flowResult.error?.message).toContain('Node "Nowhere" has not run yet');
  });

  it('passes the runner’s limits through as errors', async () => {
    const result = await run(codeNode, { mode: 'all', code: 'for (;;) {}' });
    expect(result.error?.message).toBe('Code used more than 1 s of CPU time');
  }, 20_000);

  it('explains a wrong secret and an unreachable runner', async () => {
    process.env.LANDFLOW_CODE_RUNNER_SECRET = 'wrong';
    expect((await run(codeNode, { mode: 'all', code: 'return 1' })).error?.message).toBe('The code runner rejected this host’s secret');
    process.env.LANDFLOW_CODE_RUNNER_SECRET = SECRET;
    process.env.LANDFLOW_CODE_RUNNER_URL = 'http://127.0.0.1:9';
    const unreachable = await run(codeNode, { mode: 'all', code: 'return 1' });
    expect(unreachable.error?.message).toBe("Can't reach the code runner at http://127.0.0.1:9");
  });
});

describe('where the Code node runs', () => {
  // Only the sandbox has Luxon, so `typeof DateTime` tells the two apart.
  const where = { mode: 'all', code: "return { where: typeof DateTime === 'function' ? 'sandbox' : 'in-process' };" };

  it('uses the sandbox by default when a runner is configured, in-process when asked', async () => {
    expect((await runOk(codeNode, where)).json()).toEqual([{ where: 'sandbox' }]);
    expect((await runOk(codeNode, { ...where, runIn: 'sandbox' })).json()).toEqual([{ where: 'sandbox' }]);
    expect((await runOk(codeNode, { ...where, runIn: 'inProcess' })).json()).toEqual([{ where: 'in-process' }]);
  });

  it('keeps existing workflows in-process when no runner is configured', async () => {
    delete process.env.LANDFLOW_CODE_RUNNER_URL;
    expect((await runOk(codeNode, where)).json()).toEqual([{ where: 'in-process' }]);
    expect((await runOk(codeNode, { mode: 'each', codeEach: 'return { doubled: $json.n * 2 };' }, [{ n: 2 }])).json()).toEqual([{ doubled: 4 }]);
  });

  it('refuses in-process code when LANDFLOW_CODE_IN_PROCESS=false', async () => {
    process.env.LANDFLOW_CODE_IN_PROCESS = 'false';
    expect((await runOk(codeNode, where)).json()).toEqual([{ where: 'sandbox' }]);
    expect((await run(codeNode, { ...where, runIn: 'inProcess' })).error?.message).toBe('In-process code is disabled on this host (LANDFLOW_CODE_IN_PROCESS=false)');
    delete process.env.LANDFLOW_CODE_RUNNER_URL;
    expect((await run(codeNode, where)).error?.message).toBe('In-process code is disabled on this host (LANDFLOW_CODE_IN_PROCESS=false)');
  });

  it('needs the runner for Python and for Run In: Sandbox', async () => {
    delete process.env.LANDFLOW_CODE_RUNNER_URL;
    const python = await run(codeNode, { language: 'python', mode: 'all', pythonCode: 'return 1' });
    expect(python.error?.message).toBe('Python code needs the code runner, and this host has none');
    expect(python.error?.description).toContain('LANDFLOW_CODE_RUNNER_URL');
    expect((await run(codeNode, { ...where, runIn: 'sandbox' })).error?.message).toBe('Run In: Sandbox needs the code runner, and this host has none');
    // Python never runs in-process, whatever Run In says.
    expect(() => placeCode('python', 'inProcess', { url: 'http://runner', inProcess: true, timeoutMs: 1000, binaryMaxBytes: 1000 })).not.toThrow();
    expect(placeCode('python', 'inProcess', { url: 'http://runner', inProcess: true, timeoutMs: 1000, binaryMaxBytes: 1000 })).toBe('sandbox');
  });

  it('reads its settings from the environment', () => {
    expect(codeRunnerSettings({ LANDFLOW_CODE_RUNNER_URL: 'http://runner:7300/', LANDFLOW_CODE_RUNNER_SECRET: 's', LANDFLOW_CODE_IN_PROCESS: 'false' })).toEqual({
      url: 'http://runner:7300',
      secret: 's',
      inProcess: false,
      timeoutMs: 120_000,
      binaryMaxBytes: 6 * 1024 * 1024,
    });
    expect(codeRunnerSettings({})).toEqual({ inProcess: true, timeoutMs: 120_000, binaryMaxBytes: 6 * 1024 * 1024 });
    expect(codeRunnerSettings({ LANDFLOW_CODE_BINARY_MAX_BYTES: '1000' }).binaryMaxBytes).toBe(1000);
  });
});

describe('nodesReferenced', () => {
  const names = ['Customers', 'Orders', "It's", 'Other'];

  it('sends only the outputs the code looks up by a literal name', () => {
    expect(nodesReferenced("$('Customers').all(); $(\"Orders\").first(); $node['Other'].json", 'javascript', names)).toEqual(['Customers', 'Orders', 'Other']);
    expect(nodesReferenced("$('It\\'s').all(); $node.Orders.json", 'javascript', names)).toEqual(["It's", 'Orders']);
    expect(nodesReferenced("_('Orders').all()\nmy_('Customers')", 'python', names)).toEqual(['Orders']);
    expect(nodesReferenced('return $input.all();', 'javascript', names)).toEqual([]);
  });

  it('sends everything for a computed name', () => {
    expect(nodesReferenced('const n = "Orders"; return $(n).all();', 'javascript', names)).toEqual(names);
    expect(nodesReferenced('return $(`Ord${"ers"}`).all();', 'javascript', names)).toEqual(names);
    expect(nodesReferenced('name = "Orders"\nreturn _(name).all()', 'python', names)).toEqual(names);
  });
});
