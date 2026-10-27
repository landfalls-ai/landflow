/**
 * The code runner end to end: a real server on a random port, real child processes. JavaScript and Python in both
 * modes, the n8n globals, errors with line numbers, every limit, the network and file-system blocks, and the secret.
 * Python cases are skipped when no python3 is installed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_JS_BUILTINS, SECRET_HEADER, startCodeRunner, type CodeRunner, type RunRequest, type RunResponse } from '../src';

const SECRET = 'test-secret';
const hasPython = (() => {
  try {
    execFileSync('python3', ['--version']);
    return true;
  } catch {
    return false;
  }
})();
const LIMITS = { timeoutMs: 10_000, cpuSeconds: 2, memoryMb: 64, maxOutputBytes: 256 * 1024, fileSizeMb: 1 };

let runner: CodeRunner;
let target: Server;
let targetPort = 0;
let connections = 0;

beforeAll(async () => {
  // `net`, `http` and `fs` are allowed here on purpose: the sandbox must hold even when a snippet can load them.
  runner = await startCodeRunner({ secret: SECRET, port: 0, limits: LIMITS, jsAllowBuiltins: [...DEFAULT_JS_BUILTINS, 'net', 'http', 'fs'] }, {});
  // A local server the snippets try to reach: it must never see a connection.
  target = createServer((socket) => {
    connections++;
    socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok');
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  targetPort = (target.address() as { port: number }).port;
});

afterAll(async () => {
  await runner?.close();
  await new Promise((resolve) => target?.close(resolve));
});

async function call(body: unknown, headers: Record<string, string> = { [SECRET_HEADER]: SECRET }, on = runner) {
  const response = await fetch(`${on.url}/v1/run`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as RunResponse & { error?: unknown } };
}

async function run(request: Partial<RunRequest> & Pick<RunRequest, 'code'>, on = runner): Promise<RunResponse> {
  const { status, body } = await call({ language: 'javascript', mode: 'all', items: [], ...request }, undefined, on);
  expect(status).toBe(200);
  return body;
}

async function ok(request: Partial<RunRequest> & Pick<RunRequest, 'code'>, on = runner) {
  const result = await run(request, on);
  if (!result.ok) throw new Error(`${result.error.kind}: ${result.error.message}\n${result.error.stack ?? ''}`);
  return result;
}

async function failed(request: Partial<RunRequest> & Pick<RunRequest, 'code'>, on = runner) {
  const result = await run(request, on);
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result.items)}`);
  return result;
}

const items = [{ json: { name: 'Ada', n: 1 } }, { json: { name: 'Linus', n: 2 } }, { json: { name: 'Grace', n: 3 } }];
const nodeOutputs = { Customers: [{ json: { id: 'c1' } }, { json: { id: 'c2' } }, { json: { id: 'c3' } }] };
const context = { items, nodeOutputs, variables: { REGION: 'eu' }, execution: { id: 'ex_1', mode: 'manual' }, workflow: { id: 'wf_1', name: 'Flow' } };

describe('authentication', () => {
  it('answers /health without the secret and everything else only with it', async () => {
    expect((await fetch(`${runner.url}/health`)).status).toBe(200);
    expect((await call({ language: 'javascript', mode: 'all', code: 'return 1', items: [] }, {})).status).toBe(401);
    expect((await call({ language: 'javascript', mode: 'all', code: 'return 1', items: [] }, { [SECRET_HEADER]: 'wrong' })).status).toBe(401);
    expect((await fetch(`${runner.url}/v1/info`)).status).toBe(401);
    const info = await (await fetch(`${runner.url}/v1/info`, { headers: { [SECRET_HEADER]: SECRET } })).json();
    expect(info.languages.javascript.version).toMatch(/^v\d+/);
    expect(info.limits).toEqual({ ...LIMITS, maxBinaryBytes: 6 * 1024 * 1024 });
    expect(info.isolation.guards).toBe(true);
  });

  it('rejects malformed requests', async () => {
    expect((await call({ language: 'ruby', mode: 'all', code: '', items: [] })).status).toBe(400);
    expect((await call({ language: 'javascript', mode: 'some', code: '', items: [] })).status).toBe(400);
    expect((await call({ language: 'javascript', mode: 'all', code: '', items: [{ name: 'no json key' }] })).status).toBe(400);
  });

  it('refuses to start without a secret', async () => {
    await expect(startCodeRunner({ port: 0 }, {})).rejects.toThrow(/CODE_RUNNER_SECRET/);
  });
});

describe('JavaScript', () => {
  it('runs once for all items with $input, items and console output as logs', async () => {
    const result = await ok({
      ...context,
      code: `console.log('items:', $input.all().length, { first: $input.first().json.name });
console.warn('careful');
return items.map((item) => ({ ...item.json, upper: item.json.name.toUpperCase(), last: $input.last().json.name }));`,
    });
    expect(result.items.map((item) => item.json)).toEqual([
      { name: 'Ada', n: 1, upper: 'ADA', last: 'Grace' },
      { name: 'Linus', n: 2, upper: 'LINUS', last: 'Grace' },
      { name: 'Grace', n: 3, upper: 'GRACE', last: 'Grace' },
    ]);
    expect(result.logs).toEqual([
      { level: 'info', message: "items: 3 { first: 'Ada' }" },
      { level: 'warn', message: 'careful' },
    ]);
  });

  it('runs once for each item with $json, $input.item, $itemIndex and paired items', async () => {
    const result = await ok({ ...context, mode: 'each', code: 'return { name: $json.name, same: $input.item.json.name === $json.name, index: $itemIndex };' });
    expect(result.items).toEqual([
      { json: { name: 'Ada', same: true, index: 0 }, pairedItem: { item: 0 } },
      { json: { name: 'Linus', same: true, index: 1 }, pairedItem: { item: 1 } },
      { json: { name: 'Grace', same: true, index: 2 }, pairedItem: { item: 2 } },
    ]);
  });

  it('reads other nodes with $(), and $vars, $execution, $workflow and Luxon', async () => {
    const all = await ok({
      ...context,
      timezone: 'Asia/Tokyo',
      code: `return {
  ids: $('Customers').all().map((i) => i.json.id),
  first: $('Customers').first().json.id,
  last: $('Customers').last().json.id,
  legacy: $node['Customers'].json.id,
  region: $vars.REGION,
  execution: $execution.id,
  workflow: $workflow.name,
  zone: $now.zoneName,
  date: DateTime.fromISO('2026-03-01T00:00:00Z').plus({ days: 1 }).toUTC().toISODate(),
  isDateTime: DateTime.isDateTime($today),
};`,
    });
    expect(all.items[0].json).toEqual({ ids: ['c1', 'c2', 'c3'], first: 'c1', last: 'c3', legacy: 'c1', region: 'eu', execution: 'ex_1', workflow: 'Flow', zone: 'Asia/Tokyo', date: '2026-03-02', isDateTime: true });
    // `.item` follows the current item in per-item mode (n8n's paired lookup by index).
    const each = await ok({ ...context, mode: 'each', code: "return { mine: $('Customers').item.json.id };" });
    expect(each.items.map((item) => item.json.mine)).toEqual(['c1', 'c2', 'c3']);
    const missing = await failed({ ...context, code: "return $('Nope').all();" });
    expect(missing.error.message).toBe('Node "Nope" has not run yet (or produced no output)');
  });

  it('supports await, item objects, primitives and empty results', async () => {
    expect((await ok({ code: 'await new Promise((r) => setTimeout(r, 10));\nreturn [{ json: { a: 1 }, pairedItem: { item: 0 } }, { b: 2 }, 3];' })).items).toEqual([
      { json: { a: 1 }, pairedItem: { item: 0 } },
      { json: { b: 2 } },
      { json: { value: 3 } },
    ]);
    expect((await ok({ code: 'return;' })).items).toEqual([]);
    expect((await ok({ code: 'return { big: 10n };' })).items[0].json).toEqual({ big: '10' });
  });

  it('requires only allowlisted modules and Luxon', async () => {
    const result = await ok({ code: "return { hash: require('crypto').createHash('sha256').update('x').digest('hex').slice(0, 8), luxon: typeof require('luxon').DateTime };" });
    expect(result.items[0].json).toEqual({ hash: '2d711642', luxon: 'function' });
    const denied = await failed({ code: "require('child_process').execSync('id');" });
    expect(denied.error.message).toMatch(/Cannot find module 'child_process'/);
  });

  it('reports runtime errors with the snippet’s line and column', async () => {
    const result = await failed({ ...context, code: 'const a = 1;\nconst b = 2;\nnull.boom;\nreturn [];' });
    expect(result.error).toMatchObject({ kind: 'error', name: 'TypeError', line: 3, column: 6 });
    expect(result.error.stack).toContain('code.js:3:6');
    const each = await failed({ ...context, mode: 'each', code: "if ($itemIndex === 1) {\n  throw new Error('bad item');\n}\nreturn $json;" });
    expect(each.error).toMatchObject({ kind: 'error', message: 'bad item', line: 2, itemIndex: 1 });
  });

  it('reports syntax errors with their line', async () => {
    const result = await failed({ code: 'const ok = 1;\nconst broken = ;\nreturn ok;' });
    expect(result.error).toMatchObject({ kind: 'syntax', name: 'SyntaxError', line: 2 });
  });

  it('blocks the way out of the vm context (no code generation from strings)', async () => {
    const result = await ok({ code: "try { return { escaped: console.log.constructor('return process')().pid } } catch (e) { return { blocked: e.name } }" });
    expect(result.items[0].json).toEqual({ blocked: 'EvalError' });
  });
});

describe.skipIf(!hasPython)('Python', () => {
  it('runs once for all items with _input, _items and print() as logs', async () => {
    const result = await ok({
      ...context,
      language: 'python',
      code: `import sys
print('items:', len(_input.all()), _input.first().json.name)
print('careful', file=sys.stderr)
return [{**item.json, 'upper': item['json']['name'].upper(), 'last': _input.last().json.name, 'count': len(_items)} for item in _input.all()]`,
    });
    expect(result.items.map((item) => item.json)).toEqual([
      { name: 'Ada', n: 1, upper: 'ADA', last: 'Grace', count: 3 },
      { name: 'Linus', n: 2, upper: 'LINUS', last: 'Grace', count: 3 },
      { name: 'Grace', n: 3, upper: 'GRACE', last: 'Grace', count: 3 },
    ]);
    expect(result.logs).toEqual([
      { level: 'info', message: 'items: 3 Ada' },
      { level: 'warn', message: 'careful' },
    ]);
  });

  it('runs once for each item with _json, _item, _input.item and _itemIndex', async () => {
    const result = await ok({ ...context, language: 'python', mode: 'each', code: "_json['index'] = _itemIndex\n_json['same'] = _input.item.json.name == _item.json.name\nreturn _json" });
    expect(result.items).toEqual([
      { json: { name: 'Ada', n: 1, index: 0, same: true }, pairedItem: { item: 0 } },
      { json: { name: 'Linus', n: 2, index: 1, same: true }, pairedItem: { item: 1 } },
      { json: { name: 'Grace', n: 3, index: 2, same: true }, pairedItem: { item: 2 } },
    ]);
  });

  it("reads other nodes with _(), and _vars, _execution, _workflow and _now", async () => {
    const result = await ok({
      ...context,
      language: 'python',
      timezone: 'Asia/Tokyo',
      code: `import datetime
return {
    'ids': [i.json.id for i in _('Customers').all()],
    'first': _('Customers').first().json.id,
    'region': _vars.REGION,
    'execution': _execution.id,
    'workflow': _workflow['name'],
    'offset': _now.utcoffset().total_seconds() / 3600,
    'today': _today.isoformat()[11:19],
    'when': datetime.date(2026, 3, 1),
    'nan': float('nan'),
}`,
    });
    expect(result.items[0].json).toEqual({ ids: ['c1', 'c2', 'c3'], first: 'c1', region: 'eu', execution: 'ex_1', workflow: 'Flow', offset: 9, today: '00:00:00', when: '2026-03-01', nan: null });
    const each = await ok({ ...context, language: 'python', mode: 'each', code: "return {'mine': _('Customers').item.json.id}" });
    expect(each.items.map((item) => item.json.mine)).toEqual(['c1', 'c2', 'c3']);
    const missing = await failed({ ...context, language: 'python', code: "return _('Nope').all()" });
    expect(missing.error).toMatchObject({ name: 'KeyError', line: 1 });
    expect(missing.error.message).toContain('Node "Nope" has not run yet');
  });

  it('accepts generators, primitives and nothing', async () => {
    expect((await ok({ language: 'python', code: "for i in range(2):\n    yield {'i': i}" })).items).toEqual([{ json: { i: 0 } }, { json: { i: 1 } }]);
    expect((await ok({ language: 'python', code: 'return 3' })).items).toEqual([{ json: { value: 3 } }]);
    expect((await ok({ language: 'python', code: 'x = 1' })).items).toEqual([]);
  });

  it('reports runtime errors with the snippet’s line, and the item in per-item mode', async () => {
    const result = await failed({ ...context, language: 'python', code: "a = 1\nb = {}\nreturn b['missing']" });
    expect(result.error).toMatchObject({ kind: 'error', name: 'KeyError', line: 3 });
    expect(result.error.stack).toContain('File "<code>", line 3');
    const each = await failed({ ...context, language: 'python', mode: 'each', code: "if _itemIndex == 2:\n    raise ValueError('bad item')\nreturn _json" });
    expect(each.error).toMatchObject({ name: 'ValueError', message: 'bad item', line: 2, itemIndex: 2 });
  });

  it('reports syntax errors with their line and column', async () => {
    const result = await failed({ language: 'python', code: 'x = 1\ndef broken(:\n    pass' });
    expect(result.error).toMatchObject({ kind: 'syntax', name: 'SyntaxError', line: 2 });
  });

  it('keeps to the standard library and blocks starting processes', async () => {
    const result = await ok({
      language: 'python',
      code: `import json, re, statistics, subprocess
out = {'mean': statistics.mean([1, 2, 3])}
try:
    subprocess.run(['id'])
except PermissionError as error:
    out['subprocess'] = str(error)
try:
    import requests
except ImportError:
    out['requests'] = 'missing'
return out`,
    });
    expect(result.items[0].json).toEqual({ mean: 2, subprocess: 'Starting processes is disabled in the code sandbox', requests: 'missing' });
  });
});

describe('limits', () => {
  it('stops a snippet at the wall-clock timeout', async () => {
    const started = Date.now();
    const result = await failed({ timeoutMs: 800, code: 'await new Promise((resolve) => setTimeout(resolve, 60_000));' });
    expect(result.error).toMatchObject({ kind: 'timeout', message: 'Code timed out after 0.8 s' });
    expect(Date.now() - started).toBeLessThan(5_000);
    if (hasPython) expect((await failed({ language: 'python', timeoutMs: 800, code: 'import time\ntime.sleep(60)' })).error.kind).toBe('timeout');
  });

  it('stops a busy loop at the CPU-time limit', async () => {
    expect((await failed({ code: 'for (;;) {}' })).error).toMatchObject({ kind: 'cpu', message: 'Code used more than 2 s of CPU time' });
    if (hasPython) expect((await failed({ language: 'python', code: 'while True:\n    pass' })).error.kind).toBe('cpu');
  });

  it('stops a snippet that allocates past the memory limit', async () => {
    const js = await failed({ code: 'const keep = [];\nfor (;;) keep.push(new Array(100_000).fill(Math.random()));' });
    expect(js.error).toMatchObject({ kind: 'memory', message: expect.stringContaining('Code ran out of memory (limit 64 MB)') });
    if (hasPython) {
      const py = await failed({ language: 'python', code: "import time\nkeep = []\nwhile True:\n    keep.append(b'x' * (4 * 1024 * 1024))\n    time.sleep(0.005)" });
      expect(py.error.kind).toBe('memory');
    }
  });

  it('caps the output: a huge result and a flood of logs', async () => {
    const big = await failed({ code: "return Array.from({ length: 10_000 }, (_, i) => ({ i, text: 'x'.repeat(100) }));" });
    expect(big.error).toMatchObject({ kind: 'output', message: 'Code output exceeded the 0.3 MB limit' });
    expect((await failed({ code: "for (;;) console.log('x'.repeat(1000));" })).error.kind).toBe('output');
    if (hasPython) expect((await failed({ language: 'python', code: "while True:\n    print('x' * 1000)" })).error.kind).toBe('output');
  });

  it('caps the size of files a snippet writes', async () => {
    // Node gets EFBIG (it ignores SIGXFSZ); Python too. A process that doesn't is killed, which reads the same.
    const js = await failed({ code: "const fs = require('fs');\nfs.writeFileSync('small.bin', Buffer.alloc(512 * 1024));\nfs.writeFileSync('big.bin', Buffer.alloc(4 * 1024 * 1024));" });
    expect(js.error).toMatchObject({ line: 3, message: expect.stringMatching(/EFBIG|file too large|larger than the 1 MB limit/i) });
    if (hasPython) {
      const py = await failed({ language: 'python', code: "open('small.bin', 'wb').write(bytes(512 * 1024))\nopen('big.bin', 'wb').write(bytes(4 * 1024 * 1024))" });
      expect(py.error).toMatchObject({ name: 'OSError', line: 2, message: expect.stringMatching(/File too large/i) });
    }
  });

  it('answers 503 when every slot and the queue are taken', async () => {
    const busy = await startCodeRunner({ secret: SECRET, port: 0, concurrency: 1, maxQueue: 0, limits: LIMITS }, {});
    try {
      const slow = call({ language: 'javascript', mode: 'all', items: [], code: 'await new Promise((r) => setTimeout(r, 1500)); return 1;' }, undefined, busy);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await call({ language: 'javascript', mode: 'all', items: [], code: 'return 2' }, undefined, busy)).status).toBe(503);
      expect((await slow).body.ok).toBe(true);
    } finally {
      await busy.close();
    }
  });
});

describe('network and file system', () => {
  it('JavaScript: no fetch, and net/http connections fail even when the modules are allowed', async () => {
    const result = await ok({
      code: `const out = { fetch: typeof fetch };
try {
  await new Promise((resolve, reject) => { const s = require('net').connect(${targetPort}, '127.0.0.1'); s.on('connect', () => resolve()); s.on('error', reject); });
  out.net = 'connected';
} catch (error) { out.net = error.message; }
try {
  await new Promise((resolve, reject) => require('http').get('http://127.0.0.1:${targetPort}/', resolve).on('error', reject));
  out.http = 'connected';
} catch (error) { out.http = error.message; }
return out;`,
    });
    const out = result.items[0].json as Record<string, string>;
    expect(out.fetch).toBe('undefined');
    expect(out.net).toMatch(/disabled in the code sandbox|denied|not permitted/i);
    expect(out.http).toMatch(/disabled in the code sandbox|denied|not permitted/i);
    expect(connections).toBe(0);
  });

  it.skipIf(!hasPython)('Python: sockets, urllib and DNS fail', async () => {
    const result = await ok({
      language: 'python',
      code: `import socket, urllib.request
out = {}
try:
    socket.create_connection(('127.0.0.1', ${targetPort}), timeout=2)
    out['socket'] = 'connected'
except OSError as error:
    out['socket'] = str(error)
try:
    urllib.request.urlopen('http://127.0.0.1:${targetPort}/', timeout=2)
    out['urllib'] = 'connected'
except Exception as error:
    out['urllib'] = str(error)
try:
    socket.getaddrinfo('example.com', 443)
    out['dns'] = 'resolved'
except OSError as error:
    out['dns'] = str(error)
return out`,
    });
    for (const value of Object.values(result.items[0].json)) expect(value).toMatch(/disabled in the code sandbox|not permitted/i);
    expect(connections).toBe(0);
  });

  it('writes only inside the snippet’s own work directory, which is gone afterwards', async () => {
    const outside = join(tmpdir(), `code-runner-outside-${process.pid}.txt`);
    rmSync(outside, { force: true });
    const js = await ok({
      code: `const fs = require('fs');
fs.writeFileSync('inside.txt', 'ok');
let outside;
try { fs.writeFileSync(${JSON.stringify(outside)}, 'x'); outside = 'written'; } catch (error) { outside = error.code; }
return { inside: fs.readFileSync('inside.txt', 'utf8'), outside, process: typeof process };`,
    });
    expect(js.items[0].json).toEqual({ inside: 'ok', outside: 'ERR_ACCESS_DENIED', process: 'undefined' });
    if (hasPython) {
      const py = await ok({
        language: 'python',
        code: `import os
open('inside.txt', 'w').write('ok')
try:
    open(${JSON.stringify(outside)}, 'w').write('x')
    outside = 'written'
except PermissionError as error:
    outside = 'denied'
return {'inside': open('inside.txt').read(), 'outside': outside, 'cwd': os.getcwd()}`,
      });
      expect(py.items[0].json).toMatchObject({ inside: 'ok', outside: 'denied' });
      expect(existsSync(String(py.items[0].json.cwd))).toBe(false);
    }
    expect(existsSync(outside)).toBe(false);
  });

  // The OS layer alone (no in-process guards): macOS's sandbox-exec, or unshare on Linux, still keeps snippets offline.
  it('stays offline with the in-process guards off when an OS sandbox is available', async (test) => {
    const bare = await startCodeRunner({ secret: SECRET, port: 0, limits: LIMITS, guards: false, jsAllowBuiltins: ['net'] }, {});
    try {
      if (!bare.isolation.osSandbox && !bare.isolation.node.netPermission) test.skip();
      const js = await ok(
        {
          code: `try {
  await new Promise((resolve, reject) => { const s = require('net').connect(${targetPort}, '127.0.0.1'); s.on('connect', resolve); s.on('error', reject); });
  return { net: 'connected' };
} catch (error) { return { net: error.code ?? error.message }; }`,
        },
        bare,
      );
      expect(js.items[0].json.net).toMatch(/EPERM|EACCES|ENETUNREACH|ERR_ACCESS_DENIED/);
      if (hasPython && bare.isolation.osSandbox) {
        const py = await ok(
          { language: 'python', code: `import socket\ntry:\n    socket.create_connection(('127.0.0.1', ${targetPort}), timeout=2)\n    return {'net': 'connected'}\nexcept OSError as error:\n    return {'net': error.errno}` },
          bare,
        );
        expect(py.items[0].json.net).not.toBe('connected');
      }
      expect(connections).toBe(0);
    } finally {
      await bare.close();
    }
  });
});

describe('availability', () => {
  it('says so when Python is not installed', async () => {
    const noPython = await startCodeRunner({ secret: SECRET, port: 0, limits: LIMITS, pythonPath: '/nonexistent/python3' }, {});
    try {
      const result = await failed({ language: 'python', code: 'return 1' }, noPython);
      expect(result.error).toMatchObject({ kind: 'unavailable', message: expect.stringContaining("Python isn't available") });
    } finally {
      await noPython.close();
    }
  });
});

describe('node references and files', () => {
  const b64 = (text: string) => Buffer.from(text).toString('base64');
  const fileItems = [
    { json: { n: 0 }, binary: { data: { mimeType: 'text/plain', fileName: 'a.txt', fileSize: 5, id: 'x' } } },
    { json: { n: 1 }, binary: { data: { mimeType: 'text/plain', fileName: 'b.txt', fileSize: 3, id: 'y' }, other: { mimeType: 'text/plain', fileName: 'c.txt', fileSize: 1, id: 'z' } } },
  ];
  const files = { '0:data': b64('hello'), '1:data': b64('abc'), '1:other': b64('!') };

  it('has isExecuted, itemMatching, last, .binary and $node[...].json in JavaScript', async () => {
    const result = await ok({
      ...context,
      code: `return {
  executed: $('Customers').isExecuted,
  notExecuted: $('Nowhere').isExecuted,
  matching: $('Customers').itemMatching(1).json.id,
  last: $('Customers').last().json.id,
  legacy: $node['Customers'].json.id,
  legacyItems: $node.Customers.items.length,
  inputExecuted: $input.isExecuted,
};`,
    });
    expect(result.items[0].json).toEqual({ executed: true, notExecuted: false, matching: 'c2', last: 'c3', legacy: 'c1', legacyItems: 3, inputExecuted: true });
    const noMatch = await failed({ ...context, code: "return $('Customers').itemMatching(9);" });
    expect(noMatch.error.message).toBe('Node "Customers" has no item matching input item 9');
    const missing = await failed({ ...context, code: "return $('Nowhere').first();" });
    expect(missing.error.message).toBe('Node "Nowhere" has not run yet (or produced no output)');
  });

  it.skipIf(!hasPython)('has is_executed, item_matching, last and .binary in Python', async () => {
    const result = await ok({
      ...context,
      language: 'python',
      code: `return {
    'executed': _('Customers').is_executed,
    'notExecuted': _('Nowhere').isExecuted,
    'matching': _('Customers').item_matching(1).json.id,
    'last': _('Customers').last().json.id,
    'inputExecuted': _input.is_executed,
}`,
    });
    expect(result.items[0].json).toEqual({ executed: true, notExecuted: false, matching: 'c2', last: 'c3', inputExecuted: true });
  });

  it('reads input files and creates files in JavaScript', async () => {
    const result = await ok({
      items: fileItems,
      binary: files,
      mode: 'each',
      code: `const meta = $input.item.binary.data;
const buffer = await this.helpers.getBinaryDataBuffer($itemIndex, 'data');
const out = await this.helpers.prepareBinaryData(Buffer.from(buffer.toString().toUpperCase()), 'up-' + meta.fileName, 'text/plain');
return { json: { name: meta.fileName, text: buffer.toString(), isBuffer: Buffer.isBuffer(buffer) }, binary: { data: out } };`,
    });
    expect(result.items.map((item) => item.json)).toEqual([
      { name: 'a.txt', text: 'hello', isBuffer: true },
      { name: 'b.txt', text: 'abc', isBuffer: true },
    ]);
    expect(result.items[0].binary).toEqual({ data: { data: b64('HELLO'), mimeType: 'text/plain', fileName: 'up-a.txt', fileExtension: 'txt', fileSize: 5 } });
    const other = await ok({ items: fileItems, binary: files, code: "return [{ json: { t: (await this.helpers.getBinaryDataBuffer(1, 'other')).toString() } }];" });
    expect(other.items[0].json).toEqual({ t: '!' });
  });

  it('explains a missing, skipped or unsent file and enforces the creation cap in JavaScript', async () => {
    expect((await failed({ items: fileItems, binary: files, code: "return await this.helpers.getBinaryDataBuffer(0, 'nope');" })).error.message).toBe(
      'Item 0 has no binary file "nope" (its files: data)',
    );
    expect((await failed({ items: fileItems, binary: {}, code: "return await this.helpers.getBinaryDataBuffer(0, 'data');" })).error.message).toContain('were not sent');
    expect(
      (await failed({ items: fileItems, binary: {}, binarySkipped: { '0:data': 'too big for the cap' }, code: "return await this.helpers.getBinaryDataBuffer(0, 'data');" })).error.message,
    ).toBe('too big for the cap');
    const capped = await failed({ maxBinaryBytes: 10, code: "await this.helpers.prepareBinaryData(Buffer.alloc(6), 'a.bin');\nawait this.helpers.prepareBinaryData(Buffer.alloc(6), 'b.bin');\nreturn 1;" });
    expect(capped.error.message).toBe('Files created by the code are over the 0 MB limit (12 bytes so far)');
    // The runner's own cap wins over a larger request.
    const huge = await failed({ maxBinaryBytes: 1e12, code: "return await this.helpers.prepareBinaryData(Buffer.alloc(7 * 1024 * 1024), 'big.bin');" });
    expect(huge.error.message).toContain('over the 6 MB limit');
  });

  it.skipIf(!hasPython)('reads input files and creates files in Python', async () => {
    const result = await ok({
      language: 'python',
      mode: 'each',
      items: fileItems,
      binary: files,
      code: `meta = _input.item.binary['data']
data = _helpers.get_binary_data_buffer(_itemIndex, 'data')
out = _helpers.prepare_binary_data(data.upper(), 'up-' + meta['fileName'], 'text/plain')
return {'json': {'name': meta.fileName, 'text': data.decode(), 'type': type(data).__name__}, 'binary': {'data': out}}`,
    });
    expect(result.items.map((item) => item.json)).toEqual([
      { name: 'a.txt', text: 'hello', type: 'bytes' },
      { name: 'b.txt', text: 'abc', type: 'bytes' },
    ]);
    expect(result.items[1].binary).toEqual({ data: { data: b64('ABC'), mimeType: 'text/plain', fileName: 'up-b.txt', fileExtension: 'txt', fileSize: 3 } });
    const missing = await failed({ language: 'python', items: fileItems, binary: files, code: "return _helpers.get_binary_data_buffer(0, 'nope')" });
    expect(missing.error).toMatchObject({ name: 'KeyError', line: 1 });
    const capped = await failed({ language: 'python', maxBinaryBytes: 10, code: "_helpers.prepare_binary_data(b'x' * 6)\n_helpers.prepare_binary_data(b'x' * 6)" });
    expect(capped.error.message).toContain('limit');
    expect(capped.error.line).toBe(2);
  });
});
