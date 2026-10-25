/**
 * Promotion between environments, end to end with two instances in one process — development and staging, each
 * with its own data directory, module graph and singletons — and a local bare Git repository with a branch per
 * environment (nothing leaves the machine). Development builds a workflow that calls an API with `$vars.API_BASE`
 * and a credential, pushes and promotes it (selected, then all, with a diff preview); staging (protected, its own
 * credential under another name, mapped, that reads an external secret from its own fake Vault, and its own
 * per-environment variable value) pulls with publish-on-pull and runs it there. A hotfix made directly on the
 * staging branch is a conflict for the next promotion, which stops (409) unless forced; prune removes a workflow
 * development no longer has.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { EnvironmentView, PromotionResult } from '@/lib/shared/secrets';
import type { SourceControlPullResult } from '@/lib/shared/sync';
import { echoServer, fakeVault } from './fake-secret-stores';

vi.setConfig({ testTimeout: 60_000 });

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const sh = (args: string[], cwd?: string) => execFileSync('git', ['-c', 'user.name=Hotfixer', '-c', 'user.email=hotfix@example.test', '-c', 'commit.gpgSign=false', ...args], { cwd, encoding: 'utf8', env: gitEnv }).trim();

const bare = temp('landflow-promote-bare-');
sh(['init', '-q', '--bare', bare]);

Object.assign(process.env, { LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
delete process.env.LANDFLOW_GIT_TOKEN;

type Env = Record<string, string | undefined>;

/** One instance: its environment variables, its singletons and its own copy of the modules. */
async function boot(env: Env) {
  const map = new Map<string, unknown>();
  (globalThis as { __landflow?: Map<string, unknown> }).__landflow = map;
  applyEnv(env);
  vi.resetModules();
  const m = {
    store: (await import('@/lib/server/store')).store,
    credentials: (await import('@/lib/server/credentials/vault')).credentials,
    variables: (await import('@/lib/server/variables')).variables,
    environments: await import('@/lib/server/environments'),
    secrets: await import('@/lib/server/secrets'),
    runWorkflow: (await import('@/lib/server/runner')).runWorkflow,
    productionWorkflowById: (await import('@/lib/server/publish')).productionWorkflowById,
    sourceControl: await import('@/app/api/source-control/route'),
    push: await import('@/app/api/source-control/push/route'),
    environment: await import('@/app/api/environment/route'),
    promote: await import('@/app/api/environment/promote/route'),
    pull: await import('@/app/api/environment/pull/route'),
    workflow: await import('@/app/api/workflows/[id]/route'),
  };
  (await import('@/lib/server/auth/test-bypass')).enableTestAuth();
  await (await import('@/lib/server/bootstrap')).ensureBootstrapped();
  // Without the sample workflows a fresh instance gets.
  for (const workflow of m.store.listWorkflows()) m.store.deleteWorkflow(workflow.id);
  return { env, map, m };
}
type Instance = Awaited<ReturnType<typeof boot>>;

function applyEnv(env: Env) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Switch the process to an instance (its singletons and environment variables). */
function use(instance: Instance) {
  (globalThis as { __landflow?: Map<string, unknown> }).__landflow = instance.map;
  applyEnv(instance.env);
  return instance.m;
}

const json = (path: string, method: string, body?: unknown) =>
  new Request(`http://promotion.test${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) });
const read = async <T>(response: Response) => ({ status: response.status, body: (await response.json()) as T & { error?: string } });

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ id, name: id, type, typeVersion: 1, position: [0, 0] as [number, number], parameters, ...extra });

let echo: Awaited<ReturnType<typeof echoServer>>;
let vault: Awaited<ReturnType<typeof fakeVault>>;
let dev: Instance;
let staging: Instance;

async function promote(body: Record<string, unknown>) {
  const m = use(dev);
  return read<PromotionResult>(await m.promote.POST(json('/api/environment/promote', 'POST', body)));
}
async function pull(body: Record<string, unknown> = {}) {
  const m = use(staging);
  return read<SourceControlPullResult>(await m.pull.POST(json('/api/environment/pull', 'POST', body)));
}
async function devPush(message: string) {
  const m = use(dev);
  const pushed = await read<{ committed: boolean }>(await m.push.POST(json('/api/source-control/push', 'POST', { message })));
  expect(pushed.status).toBe(200);
  return pushed.body;
}

beforeAll(async () => {
  echo = await echoServer();
  vault = await fakeVault({ rootToken: 'staging-vault-token' });
  vault.kv.secret = { apikey: { value: 'staging-key-222222' } };

  dev = await boot({ LANDFLOW_DATA_DIR: temp('landflow-dev-'), LANDFLOW_ENVIRONMENT: 'development', LANDFLOW_ENVIRONMENT_PROTECTED: undefined });
  staging = await boot({ LANDFLOW_DATA_DIR: temp('landflow-staging-'), LANDFLOW_ENVIRONMENT: 'staging', LANDFLOW_ENVIRONMENT_PROTECTED: 'true' });
});

afterAll(async () => {
  use(staging).secrets.externalSecrets.closeAll();
  await echo.close();
  await vault.close();
});

describe('two environments', () => {
  it('development builds and pushes its branch', async () => {
    const m = use(dev);
    expect((await m.sourceControl.PUT(json('/api/source-control', 'PUT', { repository: bare, branch: 'development', includeVariableValues: true }))).status).toBe(200);
    const key = m.credentials.create({ name: 'API key', type: 'core.httpHeaderAuth', data: { name: 'X-Api-Key', value: 'dev-key-111111' } });
    m.variables.create({ key: 'API_BASE', value: `${echo.url}/dev` });
    m.environments.environmentValues.set('API_BASE', { staging: `${echo.url}/staging` });
    m.store.saveWorkflow({
      id: 'wf_call',
      name: 'Call API',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Call', 'core.httpRequest', { method: 'GET', url: '{{ $vars.API_BASE }}/hello', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' }, { credentials: { httpHeaderAuth: { id: key.id, name: key.name } } }),
      ],
      connections: [{ id: 'e1', type: 'main', source: 'Start', sourceIndex: 0, target: 'Call', targetIndex: 0 }],
    } as Workflow);
    m.store.saveWorkflow({ id: 'wf_other', name: 'Other', nodes: [node('Start', 'core.manualTrigger')], connections: [] } as Workflow);
    // It runs in development against the development API with the development key.
    const run = await m.runWorkflow({ workflow: m.store.getWorkflow('wf_call')!, mode: 'manual', startNodeId: 'Start' });
    expect(run.status).toBe('success');
    expect(echo.requests.at(-1)).toMatchObject({ path: '/dev/hello', headers: { 'x-api-key': 'dev-key-111111' } });
    expect((await devPush('Initial')).committed).toBe(true);

    const view = await read<EnvironmentView>(await m.environment.GET(json('/api/environment', 'GET')));
    expect(view.body).toMatchObject({ name: 'development', branch: 'development', protected: false, sourceControl: true });
  });

  it('previews and promotes one workflow to staging', async () => {
    const preview = await promote({ target: 'staging', workflows: ['Call API'], dryRun: true });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ dryRun: true, promoted: false, conflicts: 0, from: { environment: 'development', branch: 'development' }, to: { environment: 'staging', branch: 'staging' } });
    expect(preview.body.to.commit).toBeUndefined();
    expect(preview.body.entries).toEqual([expect.objectContaining({ id: 'wf_call', name: 'Call API', status: 'added', path: 'workflows/call-api.workflow.json' })]);
    expect(preview.body.entries[0].diff).toMatch(/^--- \/dev\/null\n\+\+\+ b\/workflows\/call-api\.workflow\.json\n@@ -0,0 \+1,/);
    expect(preview.body.files.map((f) => `${f.status} ${f.path}`)).toEqual(['A credentials.json', 'A landflow-sync.json', 'A variables.json']);
    // Nothing pushed by a preview.
    expect(() => sh(['rev-parse', '--verify', '-q', 'refs/heads/staging'], bare)).toThrow();

    const promoted = await promote({ target: 'staging', workflows: ['wf_call'] });
    expect(promoted.body).toMatchObject({ promoted: true, conflicts: 0 });
    expect(promoted.body.commit).toBe(sh(['rev-parse', 'refs/heads/staging'], bare));
    const message = sh(['log', '-1', '--format=%B', 'refs/heads/staging'], bare);
    expect(message).toMatch(/^Promote 1 workflow from development to staging/);
    expect(message).toContain('Landflow-Promoted-From: development');
    expect(message).toContain(`Landflow-Promoted-Commit: ${promoted.body.from.commit}`);
    const variablesFile = JSON.parse(sh(['show', 'refs/heads/staging:variables.json'], bare)) as { variables: unknown[] };
    // The new variable comes without development's value, with every environment's value.
    expect(variablesFile.variables).toEqual([{ key: 'API_BASE', environments: { staging: `${echo.url}/staging` } }]);
    expect(sh(['ls-tree', '-r', '--name-only', 'refs/heads/staging'], bare).split('\n')).toEqual(['credentials.json', 'landflow-sync.json', 'variables.json', 'workflows/call-api.workflow.json']);
  });

  it('staging pulls it with its own credential, secret and variable value, publishes and runs it', async () => {
    const m = use(staging);
    expect((await m.sourceControl.PUT(json('/api/source-control', 'PUT', { repository: bare, branch: 'staging' }))).status).toBe(200);
    m.secrets.externalSecrets.create({ name: 'vault', kind: 'vault', settings: { url: vault.url, auth: 'token', token: 'staging-vault-token' } });
    const key = m.credentials.create({ name: 'Staging API key', type: 'core.httpHeaderAuth', data: { name: 'X-Api-Key', value: '{{ $secrets.vault.apikey.value }}' } });
    const saved = await read<EnvironmentView>(
      await m.environment.PUT(json('/api/environment', 'PUT', { publishOnPull: 'all', credentialMap: [{ type: 'core.httpHeaderAuth', name: 'API key', credentialId: key.id }] })),
    );
    expect(saved.body).toMatchObject({ name: 'staging', protected: true, protectedSource: 'env', publishOnPull: 'all', branch: 'staging' });

    const preview = await pull({ dryRun: true });
    expect(preview.body.changes.map((c) => `${c.action} ${c.kind} ${c.name}`)).toEqual(expect.arrayContaining(['create workflow Call API', 'create variable API_BASE']));
    const pulled = await pull();
    expect(pulled.status).toBe(200);
    expect(pulled.body.applied).toBe(true);
    expect(m.store.getWorkflow('wf_other')).toBeUndefined();
    const workflow = m.store.getWorkflow('wf_call')!;
    expect(workflow.nodes.find((n) => n.id === 'Call')!.credentials!.httpHeaderAuth.id).toBe(key.id);
    // Publish on pull: live in staging right away.
    const live = m.productionWorkflowById('wf_call');
    expect(live).toBeDefined();
    expect(m.variables.record().API_BASE).toBe(`${echo.url}/staging`);

    const run = await m.runWorkflow({ workflow: live!, mode: 'manual', startNodeId: 'Start' });
    expect(run.status).toBe('success');
    expect(echo.requests.at(-1)).toMatchObject({ path: '/staging/hello', headers: { 'x-api-key': 'staging-key-222222' } });
    expect(JSON.stringify(m.store.getExecution(run.executionId))).not.toContain('staging-key-222222');

    // Protected: the workflow is read-only here.
    const edit = await read(await m.workflow.PUT(json('/api/workflows/wf_call', 'PUT', { ...workflow, name: 'Edited in staging' }), { params: Promise.resolve({ id: 'wf_call' }) }));
    expect(edit.status).toBe(403);
    expect(edit.body.error).toMatch(/staging is a protected environment/);
  });

  it('a hotfix on the staging branch conflicts with the next promotion until forced', async () => {
    // Development changes the workflow and pushes.
    let m = use(dev);
    const current = m.store.getWorkflow('wf_call')!;
    m.store.saveWorkflow({ ...current, nodes: current.nodes.map((n) => (n.id === 'Call' ? { ...n, parameters: { ...n.parameters, url: '{{ $vars.API_BASE }}/v2/hello' } } : n)) });
    await devPush('Use v2');

    // Someone commits straight to the staging branch.
    const clone = join(temp('landflow-hotfix-'), 'clone');
    sh(['clone', '-q', '--branch', 'staging', bare, clone]);
    const file = join(clone, 'workflows', 'call-api.workflow.json');
    const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, `${JSON.stringify({ ...doc, description: 'Hotfix made on staging' }, null, 2)}\n`);
    sh(['commit', '-q', '-am', 'Hotfix'], clone);
    sh(['push', '-q', 'origin', 'HEAD:staging'], clone);

    const preview = await promote({ target: 'staging', workflows: ['wf_call'], dryRun: true });
    expect(preview.body.conflicts).toBe(1);
    expect(preview.body.entries[0]).toMatchObject({ id: 'wf_call', status: 'modified', conflict: 'staging changed this workflow since the last promotion from development' });
    expect(preview.body.entries[0].fields).toEqual(['description', 'nodes']);
    expect(preview.body.entries[0].diff).toContain('-  "description": "Hotfix made on staging"');
    expect(preview.body.entries[0].diff).toContain('+        "url": "{{ $vars.API_BASE }}/v2/hello",');

    const refused = await promote({ target: 'staging', workflows: ['wf_call'] });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/1 workflow changed on staging since the last promotion from development/);
    expect(refused.body.promoted).toBe(false);
    const forced = await promote({ target: 'staging', workflows: ['wf_call'], force: true });
    expect(forced.body.promoted).toBe(true);
    expect(sh(['log', '-1', '--format=%B', 'refs/heads/staging'], bare)).toContain('(over a conflict)');

    // From then on the forced promotion is the base: the next change promotes without a conflict.
    m = use(dev);
    const again = m.store.getWorkflow('wf_call')!;
    m.store.saveWorkflow({ ...again, description: 'Calls v2' });
    await devPush('Describe');
    const clean = await promote({ target: 'staging', workflows: ['wf_call'] });
    expect(clean.body).toMatchObject({ promoted: true, conflicts: 0 });
    expect(clean.body.entries[0]).toMatchObject({ status: 'modified', fields: ['description'] });

    // Staging pulls and publishes the new version.
    const pulled = await pull();
    expect(pulled.body.applied).toBe(true);
    const live = use(staging).productionWorkflowById('wf_call')!;
    expect(live.description).toBe('Calls v2');
    expect(live.nodes.find((n) => n.id === 'Call')!.parameters.url).toBe('{{ $vars.API_BASE }}/v2/hello');
  });

  it('promotes all workflows, and prunes what development removed', async () => {
    const all = await promote({ target: 'staging', dryRun: true });
    expect(all.body.entries.map((e) => `${e.status} ${e.name}${e.fields ? ` ${e.fields.join(',')}` : ''}`)).toEqual(['unchanged Call API', 'added Other']);
    expect((await promote({ target: 'staging' })).body.promoted).toBe(true);
    expect((await pull()).body.applied).toBe(true);
    expect(use(staging).store.getWorkflow('wf_other')).toBeDefined();

    const m = use(dev);
    m.store.deleteWorkflow('wf_other');
    await devPush('Remove Other');
    const pruned = await promote({ target: 'staging', prune: true });
    expect(pruned.body.entries.filter((e) => e.status !== 'unchanged').map((e) => `${e.status} ${e.name}`)).toEqual(['deleted Other']);
    expect(sh(['ls-tree', '-r', '--name-only', 'refs/heads/staging'], bare)).not.toContain('other.workflow.json');
    expect((await pull({ prune: true })).body.applied).toBe(true);
    expect(use(staging).store.getWorkflow('wf_other')).toBeUndefined();

    // Nothing left to promote.
    const nothing = await promote({ target: 'staging' });
    expect(nothing.body).toMatchObject({ promoted: false });
    expect(nothing.body.warnings.join(' ')).toMatch(/nothing to promote/);
  });

  it('refuses what it can’t do', async () => {
    expect((await promote({ target: 'development' })).status).toBe(400);
    expect((await promote({ target: 'staging', workflows: ['No such workflow'] })).status).toBe(404);
    expect((await promote({ target: 'production', source: 'qa' })).status).toBe(404);
    const repo = readdirSync(bare);
    expect(repo).toContain('refs');
  });
});
