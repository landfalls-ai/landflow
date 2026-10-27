/**
 * The Code node's `$('Node')` helpers and its files, in the sandbox and in-process: the same snippets give the same
 * answers in both (isExecuted, itemMatching, first/last/all, $node), input files arrive as metadata and bytes, files the
 * snippet creates land in the binary store, and the size caps hold on both paths.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startCodeRunner, type CodeRunner } from '@landflow/code-runner';
import { runNode, type ExecuteRequest, type JsonObject, type NodeItem } from '@landflow/sdk';
import type { BinaryRef } from '@landflow/protocol';

const root = mkdtempSync(join(tmpdir(), 'landflow-code-binary-'));
const previousDir = process.env.LANDFLOW_DATA_DIR;
process.env.LANDFLOW_DATA_DIR = root;

const { hostBinaryClient, setBinaryStore } = await import('@/lib/server/binary/access');
const { FilesystemBinaryStore, readAll } = await import('@/lib/server/binary/store');
const { codeNode } = await import('@/lib/server/nodes/code');
const { outputsOf, runFlow } = await import('./helpers');

const SECRET = 'binary-test-secret';
const ENV = ['LANDFLOW_CODE_RUNNER_URL', 'LANDFLOW_CODE_RUNNER_SECRET', 'LANDFLOW_CODE_BINARY_MAX_BYTES'] as const;
const hasPython = (() => {
  try {
    execFileSync('python3', ['--version']);
    return true;
  } catch {
    return false;
  }
})();
const store = new FilesystemBinaryStore(join(root, 'binary'));
setBinaryStore(store);
let runner: CodeRunner;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  runner = await startCodeRunner({ secret: SECRET, port: 0, limits: { timeoutMs: 10_000, cpuSeconds: 5, memoryMb: 128, maxOutputBytes: 4 * 1024 * 1024, fileSizeMb: 4 } }, {});
  for (const key of ENV) saved[key] = process.env[key];
});

afterAll(async () => {
  await runner?.close();
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  process.env.LANDFLOW_DATA_DIR = previousDir;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.LANDFLOW_CODE_RUNNER_URL = runner.url;
  process.env.LANDFLOW_CODE_RUNNER_SECRET = SECRET;
  delete process.env.LANDFLOW_CODE_BINARY_MAX_BYTES;
});

const put = (content: string | Uint8Array, fileName: string, mimeType = 'text/plain') => store.put('ex_code_binary', content, { fileName, mimeType });
const text = async (ref: BinaryRef) => Buffer.from(await readAll((await store.open(ref.id!))!.stream)).toString();

/** The Code node with the host's binary client, as the registry runs it. */
async function exec(parameters: Record<string, unknown>, input: NodeItem[]) {
  const request: ExecuteRequest = {
    protocol: 'landflow.plugin/v1',
    executionId: 'ex_code_binary',
    workflowId: 'wf_code_binary',
    mode: 'manual',
    node: { id: 'n1', name: 'Code', type: 'core.code', typeVersion: 1 },
    parameters: parameters as JsonObject,
    itemParameters: input.map(() => parameters as JsonObject),
    inputs: [input],
  };
  return runNode(codeNode, request, { binary: hostBinaryClient('ex_code_binary') });
}

const where = ['sandbox', 'inProcess'] as const;

describe.each(where)("node references and files (Run In: %s)", (runIn) => {
  const flow = (parameters: Record<string, unknown>, input = [{ name: 'Ada' }, { name: 'Linus' }, { name: 'Grace' }]) =>
    runFlow(
      [
        { name: 'Customers', type: 'core.set', parameters: { mode: 'manual', fields: { values: [{ name: 'customer', type: 'string', value: 'C-{{ $json.name }}' }] } } },
        { name: 'Code', type: 'core.code', parameters: { runIn, ...parameters } },
      ],
      [
        ['Start', 'Customers'],
        ['Customers', 'Code'],
      ],
      { input },
    );

  it('answers $(), $node and isExecuted the same way', async () => {
    const result = await flow({
      mode: 'all',
      code: `return [{
  all: $('Customers').all().map((i) => i.json.customer),
  first: $('Customers').first().json.customer,
  last: $('Customers').last().json.customer,
  matching: $('Customers').itemMatching(1).json.customer,
  executed: $('Customers').isExecuted,
  notExecuted: $('Nowhere').isExecuted,
  legacy: $node['Customers'].json.customer,
  legacyDot: $node.Customers.items.length,
  input: $input.last().json.customer,
}];`,
    });
    expect(outputsOf(result, 'Code')[0]).toEqual([
      { all: ['C-Ada', 'C-Linus', 'C-Grace'], first: 'C-Ada', last: 'C-Grace', matching: 'C-Linus', executed: true, notExecuted: false, legacy: 'C-Ada', legacyDot: 3, input: 'C-Grace' },
    ]);
  });

  it('follows the current item in per-item mode and reports a missing node and a missing match', async () => {
    const each = await flow({ mode: 'each', codeEach: "return { mine: $('Customers').item.json.customer, matching: $('Customers').itemMatching($itemIndex).json.customer, input: $input.item.json.customer };" });
    expect(outputsOf(each, 'Code')[0]).toEqual([
      { mine: 'C-Ada', matching: 'C-Ada', input: 'C-Ada' },
      { mine: 'C-Linus', matching: 'C-Linus', input: 'C-Linus' },
      { mine: 'C-Grace', matching: 'C-Grace', input: 'C-Grace' },
    ]);
    const missing = await flow({ mode: 'all', code: "return $('Nowhere').first();" });
    expect(missing.error?.message).toContain('Node "Nowhere" has not run yet');
    const noMatch = await flow({ mode: 'all', code: "return $('Customers').itemMatching(7);" });
    expect(noMatch.error?.message).toContain('has no item matching input item 7');
  });

  it('reads input files (metadata and bytes) and stores the files it creates', async () => {
    const a = await put('hello', 'a.txt');
    const b = await put('abc', 'b.txt');
    const response = await exec(
      {
        runIn,
        mode: 'each',
        codeEach: `const meta = $input.item.binary.data;
const buffer = await this.helpers.getBinaryDataBuffer($itemIndex, 'data');
const out = await this.helpers.prepareBinaryData(Buffer.from(buffer.toString().toUpperCase()), 'up-' + meta.fileName, 'text/plain');
return { json: { name: meta.fileName, size: meta.fileSize, mime: meta.mimeType, text: buffer.toString() }, binary: { data: out } };`,
      },
      [{ json: {}, binary: { data: a } }, { json: {}, binary: { data: b } }],
    );
    expect(response.error).toBeUndefined();
    const [out] = response.outputs;
    expect(out.map((item) => item.json)).toEqual([
      { name: 'a.txt', size: 5, mime: 'text/plain', text: 'hello' },
      { name: 'b.txt', size: 3, mime: 'text/plain', text: 'abc' },
    ]);
    const stored = out[0].binary!.data;
    expect(stored).toMatchObject({ fileName: 'up-a.txt', mimeType: 'text/plain', fileSize: 5, fileExtension: 'txt' });
    expect(stored.id).toBeTruthy();
    expect(await text(stored)).toBe('HELLO');
  });

  it('infers the type of a created file from its name and stores big files in the binary store', async () => {
    const response = await exec(
      { runIn, mode: 'all', code: "const bytes = Buffer.alloc(100 * 1024, 'x');\nreturn [{ json: {}, binary: { report: await this.helpers.prepareBinaryData(bytes, 'report.csv') } }];" },
      [{ json: {} }],
    );
    expect(response.error).toBeUndefined();
    const file = response.outputs[0][0].binary!.report;
    expect(file).toMatchObject({ fileName: 'report.csv', mimeType: 'text/csv', fileSize: 100 * 1024 });
    expect(file.id).toBeTruthy();
    expect((await text(file)).length).toBe(100 * 1024);
  });

  it('says which input file is over the cap, and stops files created past it', async () => {
    process.env.LANDFLOW_CODE_BINARY_MAX_BYTES = '1000';
    const big = await put('x'.repeat(2000), 'big.txt');
    const read = await exec({ runIn, mode: 'all', code: "return [{ json: { n: (await this.helpers.getBinaryDataBuffer(0, 'data')).length } }];" }, [{ json: {}, binary: { data: big } }]);
    expect(read.error?.message).toContain('over the Code node');
    expect(read.error?.message).toContain('LANDFLOW_CODE_BINARY_MAX_BYTES');
    const create = await exec({ runIn, mode: 'all', code: "return [{ json: {}, binary: { data: await this.helpers.prepareBinaryData(Buffer.alloc(1500), 'a.bin') } }];" }, [{ json: {} }]);
    expect(create.error?.message).toContain('limit');
    // Small files still work with the same cap.
    const small = await exec({ runIn, mode: 'all', code: "return [{ json: { n: (await this.helpers.getBinaryDataBuffer(0, 'data')).length } }];" }, [{ json: {}, binary: { data: await put('tiny', 't.txt') } }]);
    expect(small.outputs[0][0].json).toEqual({ n: 4 });
  });

  it('has a clear error for an item without the file', async () => {
    const response = await exec({ runIn, mode: 'all', code: "return await this.helpers.getBinaryDataBuffer(0, 'nope');" }, [{ json: {}, binary: { data: await put('x', 'x.txt') } }]);
    expect(response.error?.message).toMatch(/Item 0 has no binary file .nope./);
  });
});

describe('files in Python (sandbox)', () => {
  it.skipIf(!hasPython)('reads _input.item.binary and _helpers, and stores what it creates', async () => {
    const a = await put('hello', 'a.txt');
    const response = await exec(
      {
        language: 'python',
        mode: 'each',
        pythonCodeEach: `meta = _input.item.binary['data']
data = _helpers.get_binary_data_buffer(_itemIndex)
out = _helpers.prepare_binary_data(data[::-1], 'rev-' + meta['fileName'], 'text/plain')
return {'json': {'name': meta.fileName, 'size': meta.fileSize, 'text': data.decode()}, 'binary': {'data': out}}`,
      },
      [{ json: {}, binary: { data: a } }],
    );
    expect(response.error).toBeUndefined();
    const item = response.outputs[0][0];
    expect(item.json).toEqual({ name: 'a.txt', size: 5, text: 'hello' });
    expect(item.binary!.data.id).toBeTruthy();
    expect(await text(item.binary!.data)).toBe('olleh');
  });

  it.skipIf(!hasPython)('reports the cap', async () => {
    process.env.LANDFLOW_CODE_BINARY_MAX_BYTES = '1000';
    const big = await put('x'.repeat(2000), 'big.txt');
    const response = await exec({ language: 'python', mode: 'all', pythonCode: "return {'n': len(_helpers.get_binary_data_buffer(0))}" }, [{ json: {}, binary: { data: big } }]);
    expect(response.error?.message).toContain('over the Code node');
  });
});

describe('the code is not read for files when it never asks', () => {
  it('leaves input files out of the request (no bytes sent for code that only reads metadata)', async () => {
    const big = await put('x'.repeat(5000), 'meta.txt');
    const response = await exec({ mode: 'all', code: "return [{ json: { name: $input.first().binary.data.fileName } }];" }, [{ json: {}, binary: { data: big } }]);
    expect(response.outputs[0][0].json).toEqual({ name: 'meta.txt' });
  });
});
