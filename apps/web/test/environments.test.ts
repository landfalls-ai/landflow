/**
 * Environments on one instance: nothing changes without LANDFLOW_ENVIRONMENT; with it, Settings → Environments
 * (GET/PUT /api/environment), protected mode (workflow and folder writes refused by the API guard and the MCP tools,
 * runs and publishing still open), per-environment variable values (`$vars` and the sync format), and pulls that
 * map credentials by name or explicit mapping and publish per the environment's choice (file, all, none).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { EnvironmentView } from '@/lib/shared/secrets';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-environments-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
for (const key of ['LANDFLOW_ENVIRONMENT', 'LANDFLOW_ENVIRONMENT_PROTECTED', 'LANDFLOW_ENVIRONMENTS']) delete process.env[key];

const { ensureBootstrapped } = await import('@/lib/server/bootstrap');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { variables } = await import('@/lib/server/variables');
const { productionWorkflowById } = await import('@/lib/server/publish');
const sync = await import('@/lib/server/sync');
const environments = await import('@/lib/server/environments');
const environmentRoute = await import('@/app/api/environment/route');
const environmentVariablesRoute = await import('@/app/api/environment/variables/route');
const variableEnvironmentsRoute = await import('@/app/api/variables/[key]/environments/route');
const workflowsRoute = await import('@/app/api/workflows/route');
const workflowRoute = await import('@/app/api/workflows/[id]/route');
const runRoute = await import('@/app/api/workflows/[id]/run/route');
const foldersRoute = await import('@/app/api/folders/route');

const request = (path: string, method = 'GET', body?: unknown) =>
  new Request(`http://environments.test${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) });
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });
const read = async <T>(response: Response) => ({ status: response.status, body: (await response.json()) as T & { error?: string; protected?: boolean } });

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ id, name: id, type, typeVersion: 1, position: [0, 0] as [number, number], parameters, ...extra });
const simple = (id: string, extra: Partial<Workflow> = {}): Workflow =>
  ({
    id,
    name: id,
    nodes: [node('Start', 'core.manualTrigger'), node('Set', 'core.set', { mode: 'json', json: '={{ JSON.stringify({ base: $vars.API_BASE }) }}' })],
    connections: [{ id: 'e1', type: 'main', source: 'Start', sourceIndex: 0, target: 'Set', targetIndex: 0 }],
    ...extra,
  }) as Workflow;

beforeAll(async () => {
  await ensureBootstrapped();
});
afterEach(() => {
  for (const key of ['LANDFLOW_ENVIRONMENT', 'LANDFLOW_ENVIRONMENT_PROTECTED', 'LANDFLOW_ENVIRONMENTS']) delete process.env[key];
  environments.writeEnvironmentSettings({});
});

describe('without LANDFLOW_ENVIRONMENT', () => {
  it('is no environment, never protected, and $vars are the variables’ own values', async () => {
    const view = await read<EnvironmentView>(await environmentRoute.GET(request('/api/environment')));
    expect(view.body).toMatchObject({ protected: false, protectedSource: 'none', publishOnPull: 'file', environments: [{ name: 'development' }, { name: 'staging' }, { name: 'production' }] });
    expect(view.body.name).toBeUndefined();
    // A protected setting means nothing without an environment.
    environments.writeEnvironmentSettings({ protected: true, publishOnPull: 'none' });
    expect(environments.isProtectedEnvironment()).toBe(false);
    expect(environments.defaultPublishMode()).toBe('file');
    variables.create({ key: 'PLAIN', value: 'own' });
    environments.environmentValues.set('PLAIN', { development: 'dev-value' });
    expect(variables.record().PLAIN).toBe('own');
    expect((await workflowsRoute.POST(request('/api/workflows', 'POST', { name: 'Free to edit', nodes: [], connections: [] }))).status).toBe(201);
  });
});

describe('Settings → Environments', () => {
  it('shows the environment and saves branches, the list, publish on pull and credential mappings', async () => {
    process.env.LANDFLOW_ENVIRONMENT = 'staging';
    const target = credentials.create({ name: 'Staging key', type: 'core.httpHeaderAuth', data: { name: 'X-Key', value: 'staging-key' } });
    const saved = await read<EnvironmentView>(
      await environmentRoute.PUT(
        request('/api/environment', 'PUT', {
          environments: ['dev', 'staging', 'prod'],
          branches: { dev: 'main', prod: 'release' },
          publishOnPull: 'all',
          credentialMap: [{ type: 'core.httpHeaderAuth', name: 'Dev key', credentialId: target.id }],
        }),
      ),
    );
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      name: 'staging',
      protected: false,
      publishOnPull: 'all',
      environments: [
        { name: 'dev', branch: 'main', current: false },
        { name: 'staging', branch: 'staging', current: true },
        { name: 'prod', branch: 'release', current: false },
      ],
      credentialMap: [{ type: 'core.httpHeaderAuth', name: 'Dev key', credentialId: target.id, credentialName: 'Staging key' }],
    });
    expect(environments.mappedCredential('core.httpHeaderAuth', 'Dev key')).toBe(target.id);
    // A mapping to a credential of another type, or one that doesn't exist, is refused.
    expect((await environmentRoute.PUT(request('/api/environment', 'PUT', { credentialMap: [{ type: 'core.httpBearerAuth', name: 'x', credentialId: target.id }] }))).status).toBe(400);
    expect((await environmentRoute.PUT(request('/api/environment', 'PUT', { credentialMap: [{ type: 'core.httpHeaderAuth', name: 'x', credentialId: 'cred_nope' }] }))).status).toBe(404);
    expect((await environmentRoute.PUT(request('/api/environment', 'PUT', { environments: ['1bad'] }))).status).toBe(400);
    expect((await environmentRoute.PUT(request('/api/environment', 'PUT', { surprise: true }))).status).toBe(400);
  });
});

describe('protected environment', () => {
  it('refuses workflow and folder changes with a clear message, and still runs and publishes', async () => {
    const workflow = store.saveWorkflow(simple('wf_protected'));
    process.env.LANDFLOW_ENVIRONMENT = 'production';
    environments.writeEnvironmentSettings({ protected: true });
    const view = await read<EnvironmentView>(await environmentRoute.GET(request('/api/environment')));
    expect(view.body).toMatchObject({ name: 'production', protected: true, protectedSource: 'settings' });

    const update = await read(await workflowRoute.PUT(request(`/api/workflows/${workflow.id}`, 'PUT', { ...workflow, name: 'Changed' }), ctx({ id: workflow.id })));
    expect(update.status).toBe(403);
    expect(update.body.protected).toBe(true);
    expect(update.body.error).toBe('production is a protected environment: workflows are read-only here and change only by pull or promotion');
    expect((await workflowsRoute.POST(request('/api/workflows', 'POST', { name: 'New', nodes: [], connections: [] }))).status).toBe(403);
    expect((await workflowRoute.DELETE(request(`/api/workflows/${workflow.id}`, 'DELETE'), ctx({ id: workflow.id }))).status).toBe(403);
    expect((await foldersRoute.POST(request('/api/folders', 'POST', { name: 'Folder' }))).status).toBe(403);
    expect(store.getWorkflow(workflow.id)?.name).toBe('wf_protected');

    // Reading and running are open.
    expect((await workflowRoute.GET(request(`/api/workflows/${workflow.id}`), ctx({ id: workflow.id }))).status).toBe(200);
    const run = await runRoute.POST(request(`/api/workflows/${workflow.id}/run`, 'POST', {}), ctx({ id: workflow.id }));
    expect(run.status).toBeLessThan(300);

    // The variable stays the instance's own: variables, credentials and secrets aren't workflows.
    expect(environments.protectedWriteRefusal('POST', '/api/variables')).toBeUndefined();
    expect(environments.protectedWriteRefusal('POST', `/api/workflows/${workflow.id}/publish`)).toBeUndefined();
    expect(environments.protectedWriteRefusal('PATCH', `/api/workflows/${workflow.id}`)).toMatch(/protected/);
    expect(() => environments.assertWorkflowsWritable()).toThrow(environments.ProtectedEnvironmentError);
  });

  it('LANDFLOW_ENVIRONMENT_PROTECTED wins over the setting, both ways', async () => {
    process.env.LANDFLOW_ENVIRONMENT = 'production';
    process.env.LANDFLOW_ENVIRONMENT_PROTECTED = 'true';
    expect(environments.protection()).toEqual({ protected: true, source: 'env' });
    environments.writeEnvironmentSettings({ protected: true });
    process.env.LANDFLOW_ENVIRONMENT_PROTECTED = 'false';
    expect(environments.protection()).toEqual({ protected: false, source: 'env' });
    expect((await workflowsRoute.POST(request('/api/workflows', 'POST', { name: 'Allowed', nodes: [], connections: [] }))).status).toBe(201);
  });

  it('applies a pull anyway (sync writes the store directly)', async () => {
    process.env.LANDFLOW_ENVIRONMENT = 'production';
    process.env.LANDFLOW_ENVIRONMENT_PROTECTED = 'true';
    const exported = sync.exportState({ workflowIds: ['wf_protected'] });
    const file = exported.files.find((f) => f.path.endsWith('.workflow.json'))!;
    const doc = JSON.parse(file.content) as Record<string, unknown>;
    const files = exported.files.map((f) => (f === file ? { path: f.path, content: sync.stringify({ ...doc, name: 'Pulled name' }) } : f));
    const result = await sync.applySync(files);
    expect(result.applied).toBe(true);
    expect(store.getWorkflow('wf_protected')?.name).toBe('Pulled name');
  });
});

describe('per-environment variable values', () => {
  it('overlays $vars with this environment’s value and leaves others', async () => {
    variables.create({ key: 'API_BASE', value: 'http://own.example' });
    const put = await read<{ values: Record<string, string> }>(
      await variableEnvironmentsRoute.PUT(request('/api/variables/API_BASE/environments', 'PUT', { values: { staging: 'http://staging.example', production: 'http://prod.example' } }), ctx({ key: 'API_BASE' })),
    );
    expect(put.body.values).toEqual({ production: 'http://prod.example', staging: 'http://staging.example' });
    expect(variables.record().API_BASE).toBe('http://own.example');
    process.env.LANDFLOW_ENVIRONMENT = 'staging';
    expect(variables.record().API_BASE).toBe('http://staging.example');
    process.env.LANDFLOW_ENVIRONMENT = 'development';
    expect(variables.record().API_BASE).toBe('http://own.example');
    // null removes one value.
    await variableEnvironmentsRoute.PUT(request('/api/variables/API_BASE/environments', 'PUT', { values: { production: null } }), ctx({ key: 'API_BASE' }));
    const all = await read<{ environment: string; values: Record<string, Record<string, string>> }>(await environmentVariablesRoute.GET(request('/api/environment/variables')));
    expect(all.body).toMatchObject({ environment: 'development', values: { API_BASE: { staging: 'http://staging.example' } } });
    expect((await variableEnvironmentsRoute.PUT(request('/api/variables/API_BASE/environments', 'PUT', { values: { 'not ok': 'x' } }), ctx({ key: 'API_BASE' }))).status).toBe(400);
    expect((await variableEnvironmentsRoute.PUT(request('/api/variables/NOPE/environments', 'PUT', { values: {} }), ctx({ key: 'NOPE' }))).status).toBe(404);
  });

  it('follows renames and deletes, and round-trips through the sync format (with values only)', async () => {
    variables.update('API_BASE', { key: 'API_URL' });
    expect(environments.environmentValues.of('API_URL')).toEqual({ staging: 'http://staging.example' });
    expect(environments.environmentValues.of('API_BASE')).toEqual({});

    const withValues = sync.exportState({ values: true }).files.find((f) => f.path === 'variables.json')!;
    expect(JSON.parse(withValues.content).variables).toContainEqual({ key: 'API_URL', value: 'http://own.example', environments: { staging: 'http://staging.example' } });
    // Names only by default: no values, no environments (backward compatible).
    const namesOnly = sync.exportState().files.find((f) => f.path === 'variables.json')!;
    expect(JSON.parse(namesOnly.content).variables).toContainEqual({ key: 'API_URL' });

    // A file sets them exactly (an environment not listed goes).
    const content = sync.stringify({ variables: [...JSON.parse(withValues.content).variables.filter((v: { key: string }) => v.key !== 'API_URL'), { key: 'API_URL', value: 'http://own.example', environments: { production: 'http://p2.example' } }] });
    const files = sync.exportState({ values: true }).files.map((f) => (f.path === 'variables.json' ? { path: f.path, content } : f));
    const plan = sync.planSync(files);
    expect(plan.changes).toContainEqual(expect.objectContaining({ kind: 'variable', action: 'update', id: 'API_URL', fields: ['environments'] }));
    await sync.applySync(files);
    expect(environments.environmentValues.of('API_URL')).toEqual({ production: 'http://p2.example' });
    // An older file without `environments` leaves them alone.
    await sync.applySync(sync.exportState().files);
    expect(environments.environmentValues.of('API_URL')).toEqual({ production: 'http://p2.example' });

    variables.delete('API_URL');
    expect(environments.environmentValues.of('API_URL')).toEqual({});
  });
});

describe('pulls: credential mapping and publication', () => {
  it('maps credentials by name, else by the explicit mapping, and publishes per the environment', async () => {
    // As exported elsewhere: a workflow that uses "Dev API key" and "Shared key".
    const devKey = credentials.create({ name: 'Dev API key', type: 'core.httpHeaderAuth', data: { name: 'X-Key', value: 'dev' } });
    const shared = credentials.create({ name: 'Shared key', type: 'core.httpBearerAuth', data: { token: 'shared-token' } });
    store.saveWorkflow({
      ...simple('wf_mapped'),
      active: true,
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('A', 'core.httpRequest', { url: 'http://a.example', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' }, { credentials: { httpHeaderAuth: { id: devKey.id, name: devKey.name } } }),
        node('B', 'core.httpRequest', { url: 'http://b.example', authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth' }, { credentials: { httpBearerAuth: { id: shared.id, name: shared.name } } }),
      ],
      connections: [],
    } as Workflow);
    const files = sync.exportState({ workflowIds: ['wf_mapped'] }).files;
    store.deleteWorkflow('wf_mapped');
    credentials.delete(devKey.id);

    // This environment calls its credential differently.
    process.env.LANDFLOW_ENVIRONMENT = 'staging';
    const stagingKey = credentials.create({ name: 'Staging API key', type: 'core.httpHeaderAuth', data: { name: 'X-Key', value: 'staging' } });
    const warned = sync.planSync(files);
    expect(warned.warnings.join(' ')).toMatch(/Dev API key/);
    environments.writeEnvironmentSettings({ credentialMap: [{ type: 'core.httpHeaderAuth', name: 'Dev API key', credentialId: stagingKey.id }], publishOnPull: 'none' });
    expect(sync.planSync(files).warnings.join(' ')).not.toMatch(/Dev API key/);

    // publishOnPull "none": a draft, although the file says active.
    await sync.applySync(files, { publish: environments.defaultPublishMode() });
    const pulled = store.getWorkflow('wf_mapped')!;
    expect(pulled.nodes.find((n) => n.id === 'A')!.credentials!.httpHeaderAuth.id).toBe(stagingKey.id);
    expect(pulled.nodes.find((n) => n.id === 'B')!.credentials!.httpBearerAuth.id).toBe(shared.id);
    expect(productionWorkflowById('wf_mapped')).toBeUndefined();

    // "all": every pulled workflow is published; "file" (the default) follows `active`.
    environments.writeEnvironmentSettings({ publishOnPull: 'all' });
    const changed = files.map((f) => (f.path.endsWith('.workflow.json') ? { ...f, content: sync.stringify({ ...JSON.parse(f.content), description: 'v2', active: false }) } : f));
    await sync.applySync(changed, { publish: environments.defaultPublishMode(), force: true });
    expect(productionWorkflowById('wf_mapped')?.description).toBe('v2');
  });
});

describe('the instance MCP tools', () => {
  it('refuse to create or change workflows in a protected environment', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { instanceServer } = await import('@/lib/server/mcp/instance-tools');
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = instanceServer();
    await server.connect(serverSide);
    const client = new Client({ name: 'environments-test', version: '1.0.0' });
    await client.connect(clientSide);
    try {
      process.env.LANDFLOW_ENVIRONMENT = 'production';
      process.env.LANDFLOW_ENVIRONMENT_PROTECTED = 'yes';
      const created = (await client.callTool({ name: 'create_workflow', arguments: { name: 'From an agent', nodes: [] } })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(created.isError).toBe(true);
      expect(created.content[0].text).toMatch(/^production is a protected environment/);
      const updated = (await client.callTool({ name: 'update_workflow', arguments: { id: 'wf_protected', name: 'Agent rename' } })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(updated.isError).toBe(true);
      expect(store.getWorkflow('wf_protected')?.name).not.toBe('Agent rename');
      delete process.env.LANDFLOW_ENVIRONMENT_PROTECTED;
      const allowed = (await client.callTool({ name: 'create_workflow', arguments: { name: 'From an agent', nodes: [] } })) as { isError?: boolean };
      expect(allowed.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });
});
