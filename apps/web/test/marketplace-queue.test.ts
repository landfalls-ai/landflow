/**
 * Marketplace node plugins in queue mode (lib/server/marketplace/service.ts): every main and worker runs its own copy.
 *
 * - Installing records a revision and a hash of the downloaded files, starts the plugin without announcing (it would
 *   announce to the load balancer, so another process would call this one's 127.0.0.1), registers it in this
 *   process's registry as a local endpoint (never written to `plugin_registrations`), and tells the other processes on
 *   the control channel.
 * - A process that can't see the installed files (another host's disk) downloads the same source into its own
 *   directory, checks the hash and runs that copy; an update elsewhere (a new revision) restarts it.
 * - A source that changed since the install (another hash) is refused; uninstalled elsewhere, the copy stops and its
 *   directory goes.
 *
 * The plugin is plain JavaScript (`node main.mjs`) serving the HTTP protocol, so nothing needs installing.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HTTP_PATHS } from '@landflow/protocol';
import { defineNode, definePlugin } from '@landflow/sdk';
import type { InstallResult } from '@/lib/shared/marketplace';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// Real paths: the plugin reports its working directory (macOS's /var is /private/var).
const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'landflow-mkt-queue-')));
const ENV: Record<string, string | undefined> = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_DB: 'sqlite',
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_EXECUTIONS_MODE: 'queue',
  LANDFLOW_QUEUE_ALLOW_SQLITE: 'true',
  LANDFLOW_INSTANCE_ID: 'main-mkt',
  LANDFLOW_WORKER_PORT: '0',
  LANDFLOW_MARKETPLACE_ALLOW_LOCAL: '1',
  LANDFLOW_MARKETPLACE_REGISTRY_URL: 'off',
  // Its own ports: test/marketplace.test.ts may install a plugin at the same moment in another worker.
  LANDFLOW_MARKETPLACE_PORTS: '7290-7299',
  LANDFLOW_ROLE: undefined,
  LANDFLOW_CONFIG_STORE: undefined,
};
const previousEnv = { ...process.env };
for (const [key, value] of Object.entries(ENV)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const { marketplace } = await import('@/lib/server/marketplace/service');
const { marketplaceStore } = await import('@/lib/server/marketplace/store');
const { registry } = await import('@/lib/server/plugins/registry');
const { database } = await import('@/lib/server/db');
const { startCluster, stopCluster } = await import('@/lib/server/cluster');
const { MemoryCoordinator, MemoryHub } = await import('@/lib/server/cluster/memory');
const { Relay } = await import('@/lib/server/cluster/relay');
const { createFetchHandler } = await import('@landflow/sdk/http');

// ---------------------------------------------------------------------------
// A local marketplace with a plain-JavaScript node plugin
// ---------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'landflow-mkt-queue-src-'));
const write = (path: string, content: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};

/** main.mjs: the HTTP protocol by hand (health, manifest, execute), answering with the manifest the SDK would send. */
async function pluginSource(): Promise<string> {
  const plugin = definePlugin({
    info: { id: 'echo-js', name: 'Echo JS', version: '0.0.1' },
    nodes: [
      defineNode({
        description: { name: 'echo', displayName: 'Echo', description: 'Returns its input', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
        execute: (ctx) => [ctx.getInputData()],
      }),
    ],
  });
  const manifest = await (await createFetchHandler(plugin)(new Request(`http://plugin${HTTP_PATHS.manifest}`))).json();
  return `import { createServer } from 'node:http';
const manifest = ${JSON.stringify(manifest)};
const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.url === '${HTTP_PATHS.health}') return send(res, 200, { status: 'ok', pluginId: 'echo-js', version: '0.0.1' });
    if (req.url === '${HTTP_PATHS.manifest}') return send(res, 200, manifest);
    if (req.url === '${HTTP_PATHS.execute}') {
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return send(res, 200, { outputs: [(request.inputs[0] ?? []).map((item) => ({ json: { ...item.json, pid: process.pid, cwd: process.cwd() } }))], logs: [] });
    }
    send(res, 404, { error: 'not found' });
  });
}).listen(Number(process.env.LANDFLOW_HTTP_PORT), '127.0.0.1');
`;
}

const hub = new MemoryHub();
const other = new Relay(new MemoryCoordinator(hub), 'main-other');
const heard: unknown[] = [];
let marketplaceId = '';
const KEY = 'echo-js@local-queue';
const instanceCopy = join(dataDir, 'marketplace', 'instances', 'main-mkt', 'echo-js');

const health = (port: number) =>
  fetch(`http://127.0.0.1:${port}${HTTP_PATHS.health}`, { signal: AbortSignal.timeout(1_000) }).then(
    (r) => r.ok,
    () => false,
  );
const until = (check: () => void | Promise<void>, timeout = 20_000) => vi.waitFor(check, { timeout, interval: 100 });
const record = () => marketplaceStore.installedOne(KEY)!;
const echo = async (n: number) => {
  const resolved = (registry as unknown as { resolveType(type: string): { execute(request: object): Promise<{ outputs: Array<Array<{ json: Record<string, unknown> }>> }> } | { error: string } }).resolveType('echo-js.echo');
  if ('error' in resolved) throw new Error(resolved.error);
  const response = await resolved.execute({ protocol: 'landflow.plugin/v1', executionId: `e${n}`, mode: 'manual', node: { id: 'n', name: 'Echo', type: 'echo-js.echo', typeVersion: 1 }, parameters: {}, itemParameters: [{}], inputs: [[{ json: { n } }]] });
  return response.outputs[0]![0]!.json;
};

beforeAll(async () => {
  write('.claude-plugin/marketplace.json', JSON.stringify({ name: 'local-queue', plugins: [{ name: 'echo-js', source: './echo' }] }));
  write('echo/landflow.plugin.json', JSON.stringify({ id: 'echo-js', runtime: 'node', start: ['node', 'main.mjs'] }));
  write('echo/main.mjs', await pluginSource());
  expect(await startCluster({ coordinator: new MemoryCoordinator(hub) })).toBe(true);
  await other.listen('control', (message) => heard.push(message));
  marketplaceId = (await marketplace.add(root)).id;
});

afterAll(async () => {
  if (marketplaceStore.installedOne(KEY)) marketplaceStore.removeInstalled(KEY);
  await marketplace.syncNodePlugins();
  await stopCluster();
  await other.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe('marketplace node plugins in queue mode', () => {
  it('installs: records revision and hash, runs without announcing, registers locally and tells the other processes', async () => {
    const result = (await marketplace.install(marketplaceId, 'echo-js', { confirm: true })) as InstallResult;
    const node = result.installed.nodePlugin!;
    expect(node.revision).toMatch(/^rev_/);
    expect(node.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.parse(readFileSync(join(node.dir, '.landflow-install.json'), 'utf8'))).toEqual({ key: KEY, revision: node.revision, contentHash: node.contentHash });
    expect(node.port).toBeGreaterThanOrEqual(7290);
    const endpoint = `http://127.0.0.1:${node.port}`;
    await until(() => expect(registry.endpointInfo(endpoint)).toMatchObject({ local: true, status: 'online' }));
    expect(await echo(1)).toMatchObject({ n: 1, cwd: realpathSync(node.dir) });
    // A local endpoint: never in the shared table.
    expect(database().get('SELECT endpoint FROM plugin_registrations WHERE endpoint = ?', endpoint)).toBeUndefined();
    await until(() => expect(heard).toContainEqual({ t: 'marketplace' }));
  });

  it('downloads its own copy when it can’t see the installed files, and restarts it on an update elsewhere', async () => {
    const installed = record();
    const before = installed.nodePlugin!;
    const firstPid = (await echo(2)).pid;
    // As another main on another host would record it: its own directory, a new revision (an update).
    marketplaceStore.saveInstalled({ ...installed, nodePlugin: { ...before, dir: join(tmpdir(), 'landflow-not-on-this-host', 'echo-js'), revision: 'rev_elsewhere' } });
    await marketplace.syncNodePlugins();
    expect(existsSync(join(instanceCopy, 'main.mjs'))).toBe(true);
    expect(JSON.parse(readFileSync(join(instanceCopy, '.landflow-install.json'), 'utf8'))).toMatchObject({ revision: 'rev_elsewhere', contentHash: before.contentHash });
    await until(async () => expect(await echo(3)).toMatchObject({ n: 3, cwd: instanceCopy }));
    expect((await echo(4)).pid).not.toBe(firstPid);
    expect(marketplace.installed()[0]!.nodePlugin!.status?.state).toBe('running');
  });

  it('refuses a source that changed since the install, and stops a plugin uninstalled elsewhere', async () => {
    const installed = record();
    const port = marketplace.installed()[0]!.nodePlugin!.status!.port!;
    // The source changed after the install: its hash no longer matches.
    write('echo/main.mjs', `${await pluginSource()}\n// changed\n`);
    marketplaceStore.saveInstalled({ ...installed, nodePlugin: { ...installed.nodePlugin!, revision: 'rev_changed' } });
    await marketplace.syncNodePlugins();
    expect(existsSync(instanceCopy)).toBe(false);
    await until(async () => expect(await health(port)).toBe(false));
    expect('error' in (registry as unknown as { resolveType(type: string): object }).resolveType('echo-js.echo')).toBe(true);

    // Back to the installed source: it runs again.
    write('echo/main.mjs', await pluginSource());
    marketplaceStore.saveInstalled({ ...installed, nodePlugin: { ...installed.nodePlugin!, revision: 'rev_again' } });
    await marketplace.syncNodePlugins();
    await until(async () => expect(await echo(5)).toMatchObject({ n: 5, cwd: instanceCopy }));

    // Uninstalled elsewhere: stopped here, its copy removed.
    const running = marketplace.installed()[0]!.nodePlugin!.status!.port!;
    marketplaceStore.removeInstalled(KEY);
    await marketplace.syncNodePlugins();
    await until(async () => expect(await health(running)).toBe(false));
    expect(existsSync(instanceCopy)).toBe(false);
    expect(registry.endpointInfo(`http://127.0.0.1:${running}`)).toBeUndefined();
  });
});
