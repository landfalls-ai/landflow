/**
 * The CLI against a real host (test/host.ts): every command's `--json` shape is the contract (README: JSON output),
 * so these tests pin the keys; exit codes too — 0 ok, 1 error, 2 usage, 3 not found, 4 auth, 5 conflict, 6 network.
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliFor, startHost, web, type Host } from './host';

let host: Host;
let cli: ReturnType<typeof cliFor>;
const work = mkdtempSync(join(tmpdir(), 'landflow-cli-work-'));

const node = (id: string, name: string, type: string, parameters: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ id, name, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
const edge = (source: string, target: string) => ({ id: `e_${source}_${target}`, type: 'main', source, sourceIndex: 0, target, targetIndex: 0 });

const greeting = {
  name: 'Greeting',
  tags: ['cli'],
  nodes: [node('start', 'Start', 'core.manualTrigger'), node('set', 'Set', 'core.set', { mode: 'json', json: '{"greeting": "hello {{ $json.who }}"}' })],
  connections: [edge('start', 'set')],
};
const failing = {
  name: 'Always fails',
  nodes: [node('start', 'Start', 'core.manualTrigger'), node('boom', 'Boom', 'core.stopAndError', { message: 'it broke' })],
  connections: [edge('start', 'boom')],
};

const file = (name: string, value: unknown) => {
  const path = join(work, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return path;
};

beforeAll(async () => {
  host = await startHost();
  cli = cliFor(host);
});

afterAll(async () => {
  await host?.close();
});

describe('the basics', () => {
  it('prints its version and help', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect((await cli(['--version'])).stdout.trim()).toBe(pkg.version);
    expect((await cli(['--version', '--json'])).json).toEqual({ ok: true, version: pkg.version });
    const help = await cli(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('sync pull');
    const sub = await cli(['workflows', 'list', '--help']);
    expect(sub.stdout).toContain('Usage: landflow workflows list');
    expect((await cli(['help', 'run'])).stdout).toContain('Usage: landflow run <workflow>');
  });

  it('fails with a usage error (exit 2) and one JSON error document', async () => {
    const unknown = await cli(['frobnicate', '--json']);
    expect(unknown.code).toBe(2);
    expect(unknown.json).toEqual({ ok: false, error: { code: 'usage', message: expect.stringContaining('frobnicate') } });
    const flag = await cli(['workflows', 'list', '--nope', '--json']);
    expect(flag.code).toBe(2);
    expect(flag.json.error.message).toContain('--nope');
    const missing = await cli(['workflows', 'get', '--json']);
    expect(missing.code).toBe(2);
    expect((await cli(['workflows', 'get'])).stderr).toMatch(/^error: Missing arguments/);
  });

  it('reports an unreachable host as a network error (exit 6)', async () => {
    const result = await cli(['workflows', 'list', '--json', '--url', 'http://127.0.0.1:9']);
    expect(result.code).toBe(6);
    expect(result.json.error.code).toBe('network');
  });

  it('reports a route the host lacks as not_supported', async () => {
    const html404: typeof fetch = async () => new Response('<!DOCTYPE html>', { status: 404, headers: { 'content-type': 'text/html' } });
    const result = await cli(['whoami', '--json'], { fetch: html404 });
    expect(result.code).toBe(1);
    expect(result.json.error).toMatchObject({ code: 'not_supported', status: 404 });
  });
});

describe('login and whoami', () => {
  it('saves the URL and key 0600 and reports where settings come from', async () => {
    const env = { LANDFLOW_URL: undefined };
    const login = await cli(['login', '--url', host.url, '--api-key', 'lf_notarealkey1234', '--no-verify', '--json'], { env });
    expect(login.code).toBe(0);
    expect(login.json).toEqual({ ok: true, url: host.url, apiKey: 'lf_…1234', configPath: expect.any(String), verified: false, user: null });
    expect(statSync(login.json.configPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(login.json.configPath, 'utf8'))).toEqual({ url: host.url, apiKey: 'lf_notarealkey1234' });
    const logout = await cli(['logout', '--json'], { env });
    expect(logout.json).toEqual({ ok: true, configPath: login.json.configPath, removed: true });

    const whoami = await cli(['whoami', '--json']);
    expect(whoami.code).toBe(0);
    expect(Object.keys(whoami.json).sort()).toEqual(['apiKey', 'host', 'keySource', 'ok', 'scopes', 'url', 'urlSource', 'user', 'via']);
    expect(whoami.json).toMatchObject({ url: host.url, urlSource: 'env', apiKey: null, keySource: 'none', user: { role: 'owner' }, via: 'test' });
    expect(whoami.json.host).toEqual({ status: expect.any(String), workflows: expect.any(Number), nodeTypes: expect.any(Number), plugins: expect.any(Number) });
  });

  it('sends the API key as a Bearer token: 401 and 403 exit 4', async () => {
    const bypass = await web('lib/server/auth/test-bypass');
    const { createOwner } = await web('lib/server/auth/users');
    const { createApiKey } = await web('lib/server/auth/api-keys');
    const owner = await createOwner({ email: 'cli-owner@landflow.test', name: 'CLI Owner', password: 'correct horse battery staple' });
    const reader = await createApiKey(owner, { label: 'cli read', scopes: ['workflows:read'] });
    bypass.disableTestAuth();
    try {
      const anonymous = await cli(['workflows', 'list', '--json']);
      expect(anonymous.code).toBe(4);
      expect(anonymous.json.error).toMatchObject({ code: 'unauthorized', status: 401 });
      const key = (reader as { token: string }).token;
      expect(key).toMatch(/^lf_/);
      const env = { LANDFLOW_API_KEY: key };
      const me = await cli(['whoami', '--json'], { env });
      expect(me.code).toBe(0);
      expect(me.json).toMatchObject({ keySource: 'env', user: { email: 'cli-owner@landflow.test' }, via: 'api-key', scopes: ['workflows:read'] });
      expect((await cli(['workflows', 'list', '--json'], { env })).code).toBe(0);
      const denied = await cli(['workflows', 'create', '--file', file('denied.json', greeting), '--json'], { env });
      expect(denied.code).toBe(4);
      expect(denied.json.error).toMatchObject({ code: 'forbidden', status: 403 });
      const bad = await cli(['workflows', 'list', '--json', '--api-key', 'lf_wrong']);
      expect(bad.code).toBe(4);

      // A key that may only run: the workflow is named by id, and the run starts.
      const runner = createApiKey(owner, { label: 'cli run', scopes: ['run'] });
      const { store } = await web('lib/server/store');
      store.saveWorkflow({ id: 'wf_run_only', ...greeting });
      const started = await cli(['run', 'wf_run_only', '--json'], { env: { LANDFLOW_API_KEY: runner.token } });
      expect(started.code).toBe(0);
      expect(started.json).toMatchObject({ executionId: expect.any(String), workflowId: 'wf_run_only', status: 'running' });
      store.deleteWorkflow('wf_run_only');
    } finally {
      bypass.enableTestAuth();
    }
  });
});

describe('workflows', () => {
  let id: string;

  it('creates, lists, gets, renames and deletes', async () => {
    const created = await cli(['workflows', 'create', '--file', file('greeting.json', greeting), '--json']);
    expect(created.code).toBe(0);
    expect(created.json).toMatchObject({ ok: true, workflow: { id: expect.stringMatching(/^wf_/), name: 'Greeting' }, warnings: [] });
    id = created.json.workflow.id;

    const list = await cli(['workflows', 'list', '--json']);
    expect(list.json.workflows).toEqual([{ id, name: 'Greeting', active: false, folderId: null, tags: ['cli'], nodeCount: 2, updatedAt: expect.any(String) }]);
    expect((await cli(['workflows', 'list', '--tag', 'nope', '--json'])).json.workflows).toEqual([]);
    expect((await cli(['workflows', 'list'])).stdout).toMatch(/^ID\s+NAME\s+ACTIVE/);

    const byName = await cli(['workflows', 'get', 'greeting', '--json']);
    expect(byName.json.workflow).toMatchObject({ id, name: 'Greeting', nodes: [{ id: 'start' }, { id: 'set' }] });
    const missing = await cli(['workflows', 'get', 'no-such-flow', '--json']);
    expect(missing.code).toBe(3);
    expect(missing.json.error).toMatchObject({ code: 'not_found', status: 404 });

    const renamed = await cli(['workflows', 'update', id, '--name', 'Greeter', '--json']);
    expect(renamed.json.workflow).toMatchObject({ id, name: 'Greeter', nodes: [{ id: 'start' }, { id: 'set' }] });

    const scratch = (await cli(['workflows', 'create', '--file', file('scratch.json', { ...greeting, name: 'Scratch' }), '--json'])).json.workflow.id;
    const refused = await cli(['workflows', 'delete', scratch, '--json']);
    expect(refused.code).toBe(2);
    const deleted = await cli(['workflows', 'delete', scratch, '--yes', '--json']);
    expect(deleted.json).toEqual({ ok: true, deleted: { id: scratch, name: 'Scratch' } });
    expect((await cli(['workflows', 'get', scratch, '--json'])).code).toBe(3);
  });

  it('activates by publishing, and deactivates', async () => {
    const activated = await cli(['workflows', 'activate', id, '--json']);
    expect(activated.code).toBe(0);
    expect(activated.json.workflow).toMatchObject({ id, active: true });
    const published = await cli(['workflows', 'publish', id, '--note', 'from the CLI', '--json']);
    expect(published.json).toEqual({
      ok: true,
      workflowId: id,
      published: { versionId: expect.any(String), versionNumber: expect.any(Number), publishedAt: expect.any(String) },
      unpublishedChanges: false,
      triggerErrors: [],
    });
    const unpublished = await cli(['workflows', 'unpublish', id, '--json']);
    expect(unpublished.json).toMatchObject({ workflowId: id, published: null });
    const deactivated = await cli(['workflows', 'deactivate', id, '--json']);
    expect(deactivated.json.workflow).toMatchObject({ id, active: false });
  });
});

describe('runs and executions', () => {
  let ok: string;
  let bad: string;

  beforeAll(async () => {
    ok = (await cli(['workflows', 'create', '--file', file('run-ok.json', { ...greeting, name: 'Run ok' }), '--json'])).json.workflow.id;
    bad = (await cli(['workflows', 'create', '--file', file('run-bad.json', failing), '--json'])).json.workflow.id;
  });

  it('runs and waits for the result', async () => {
    const result = await cli(['run', 'Run ok', '--input', '-', '--wait', '--json'], { stdin: '{"who": "cli"}' });
    expect(result.code).toBe(0);
    expect(Object.keys(result.json).sort()).toEqual(['execution', 'ok', 'workflowId']);
    expect(result.json.execution).toEqual({
      id: expect.any(String),
      workflowId: ok,
      workflowName: 'Run ok',
      status: 'success',
      mode: 'manual',
      startedAt: expect.any(String),
      durationMs: expect.any(Number),
      error: null,
      finishedAt: expect.any(String),
      retryOf: null,
      waitingFor: null,
      nodes: [
        { id: 'start', name: 'Start', status: 'success', runs: 1, items: 1, error: null },
        { id: 'set', name: 'Set', status: 'success', runs: 1, items: 1, error: null },
      ],
      output: [expect.objectContaining({ greeting: 'hello cli' })],
    });
  });

  it('exits 1 with the execution when it fails', async () => {
    const result = await cli(['run', bad, '--wait', '--json']);
    expect(result.code).toBe(1);
    expect(result.json.error).toMatchObject({ code: 'execution_failed', message: expect.stringContaining('it broke'), details: { execution: { status: 'error', workflowId: bad } } });
  });

  it('starts in the background, lists, gets, retries and refuses to stop a finished run', async () => {
    const started = await cli(['run', ok, '--json']);
    expect(started.json).toEqual({ ok: true, executionId: expect.any(String), workflowId: ok, status: 'running' });
    const id = started.json.executionId;
    let got;
    for (let i = 0; i < 100; i++) {
      got = await cli(['executions', 'get', id, '--json']);
      if (got.code === 0 && got.json.execution.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(got!.json.execution).toMatchObject({ id, status: 'success' });
    expect(got!.json.execution.runData).toBeUndefined();
    expect((await cli(['executions', 'get', id, '--data', '--json'])).json.execution.runData).toHaveProperty('set');

    const list = await cli(['executions', 'list', '--workflow', ok, '--json']);
    expect(list.json.executions.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(list.json.executions[0]).sort()).toEqual(['durationMs', 'error', 'id', 'mode', 'startedAt', 'status', 'workflowId', 'workflowName']);
    expect((await cli(['executions', 'list', '--status', 'error', '--json'])).json.executions.every((e: { status: string }) => e.status === 'error')).toBe(true);

    const failed = (await cli(['executions', 'list', '--workflow', bad, '--json'])).json.executions[0].id;
    const retry = await cli(['executions', 'retry', failed, '--from', 'start', '--wait', '--json']);
    expect(retry.code).toBe(1);
    expect(retry.json.error.details.execution).toMatchObject({ retryOf: failed, status: 'error' });

    const stop = await cli(['executions', 'stop', id, '--json']);
    expect(stop.code).toBe(5);
    expect(stop.json.error.code).toBe('conflict');
    expect((await cli(['executions', 'get', 'nope', '--json'])).code).toBe(3);
    const all = await cli(['executions', 'stop', '--all', '--json']);
    expect(all.json).toEqual({ ok: true, all: true, stopped: { running: expect.any(Number), waiting: expect.any(Number), queued: expect.any(Number), retries: expect.any(Number) } });
  });
});

describe('import and export', () => {
  it('imports n8n JSON, with a report', async () => {
    const n8n = {
      name: 'From n8n',
      nodes: [
        { id: 'a1', name: 'When clicking', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'a2', name: 'Mystery', type: 'n8n-nodes-base.someNodeLandflowLacks', typeVersion: 1, position: [200, 0], parameters: {} },
      ],
      connections: { 'When clicking': { main: [[{ node: 'Mystery', type: 'main', index: 0 }]] } },
    };
    const result = await cli(['import', file('n8n.json', n8n), '--json']);
    expect(result.code).toBe(0);
    expect(result.json.imported).toEqual([
      {
        file: expect.stringContaining('n8n.json'),
        workflow: expect.objectContaining({ id: expect.any(String), name: 'From n8n', nodeCount: 2 }),
        report: { format: 'n8n', placeholders: [{ name: 'Mystery', type: 'n8n-nodes-base.someNodeLandflowLacks' }], warnings: expect.any(Array) },
      },
    ]);
  });

  it('exports a workflow with credentials by name and type, and imports it back on the host', async () => {
    const { credentials } = await web('lib/server/credentials/vault');
    const saved = credentials.create({ name: 'Team mail', type: 'core.httpBearerAuth', data: { token: 'hunter2' } });
    const withCredential = {
      name: 'Mailer',
      nodes: [node('start', 'Start', 'core.manualTrigger'), node('mail', 'Mail', 'core.httpRequest', {}, { credentials: { httpBearerAuth: { id: saved.id, name: 'Team mail' } } })],
      connections: [edge('start', 'mail')],
    };
    const id = (await cli(['workflows', 'create', '--file', file('mailer.json', withCredential), '--json'])).json.workflow.id;
    const printed = await cli(['export', id]);
    expect(printed.code).toBe(0);
    const document = JSON.parse(printed.stdout);
    expect(Object.keys(document).slice(0, 2)).toEqual(['id', 'name']);
    expect(document.nodes[1].credentials).toEqual({ httpBearerAuth: { name: 'Team mail', type: 'core.httpBearerAuth' } });
    expect(printed.stdout).not.toContain('hunter2');
    expect(printed.stdout).not.toContain(saved.id);

    const json = await cli(['export', 'Mailer', '--json']);
    expect(json.json.workflows).toEqual([{ id, name: 'Mailer', path: 'workflows/mailer.workflow.json', document }]);

    const copy = await cli(['import', file('mailer-export.json', printed.stdout), '--name', 'Mailer copy', '--json']);
    expect(copy.code).toBe(0);
    const imported = (await cli(['workflows', 'get', copy.json.imported[0].workflow.id, '--json'])).json.workflow;
    expect(imported.nodes[1].credentials).toEqual({ httpBearerAuth: { id: saved.id, name: 'Team mail' } });
  });

  it('exports everything into a directory in the sync layout', async () => {
    const dir = join(work, 'export-all');
    const result = await cli(['export', '--all', '--dir', dir, '--json']);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ ok: true, dir, written: expect.arrayContaining(['landflow-sync.json', 'variables.json', 'credentials.json', 'workflows/mailer.workflow.json']), removed: [] });
    expect(result.json.workflows[0]).toEqual({ id: expect.any(String), name: expect.any(String), path: expect.stringMatching(/^workflows\/.+\.workflow\.json$/) });
    expect(JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8')).credentials).toContainEqual({ name: 'Team mail', type: 'core.httpBearerAuth' });
    expect((await cli(['export', '--json'])).code).toBe(2);
  });
});

describe('data tables and variables', () => {
  it('lists tables and their rows, by id or name', async () => {
    const { dataTables } = await web('lib/server/datatables');
    const table = dataTables().createTable({ name: 'Leads', columns: [{ name: 'email', type: 'string' }, { name: 'score', type: 'number' }] });
    dataTables().insertRows(table.id, [{ email: 'a@x.test', score: 3 }, { email: 'b@x.test', score: 9 }]);
    const list = await cli(['data-tables', 'list', '--json']);
    expect(list.json.tables).toContainEqual({ id: table.id, name: 'Leads', columns: [{ name: 'email', type: 'string' }, { name: 'score', type: 'number' }], rowCount: 2, updatedAt: expect.any(String) });
    const rows = await cli(['data-tables', 'rows', 'leads', '--sort', 'score', '--desc', '--json']);
    expect(rows.json).toMatchObject({ table: { id: table.id, name: 'Leads' }, total: 2, offset: 0, limit: 50 });
    expect(rows.json.rows.map((r: { email: string }) => r.email)).toEqual(['b@x.test', 'a@x.test']);
    expect((await cli(['data-tables', 'rows', 'nope', '--json'])).code).toBe(3);
  });

  it('sets, lists and deletes variables', async () => {
    expect((await cli(['variables', 'set', 'API_BASE', 'https://api.example.com', '--json'])).json).toEqual({ ok: true, variable: { key: 'API_BASE', value: 'https://api.example.com' }, created: true });
    expect((await cli(['variables', 'set', 'API_BASE', '--value-file', '-', '--json'], { stdin: 'https://v2.example.com\n' })).json).toEqual({
      ok: true,
      variable: { key: 'API_BASE', value: 'https://v2.example.com' },
      created: false,
    });
    expect((await cli(['variables', 'list', '--json'])).json.variables).toContainEqual({ key: 'API_BASE', value: 'https://v2.example.com' });
    expect((await cli(['variables', 'delete', 'API_BASE', '--json'])).json).toEqual({ ok: true, deleted: 'API_BASE' });
    expect((await cli(['variables', 'delete', 'API_BASE', '--json'])).code).toBe(3);
  });
});
