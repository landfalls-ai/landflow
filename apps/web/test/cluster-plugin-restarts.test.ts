/**
 * Queue mode: a plugin restarted with the same version reaches the workers (lib/server/cluster/plugins.ts). Two
 * registries share one `plugin_registrations` table, as a main and a worker do: the main hears the plugin announce a
 * new instanceId, pulls its manifest again and writes the new instance and manifest hash; the worker's sync sees the
 * row change and pulls the manifest again too, so new nodes show without a version bump. Unchanged rows pull nothing,
 * endpoints marked `local` (marketplace node plugins, one copy per process) are never written, and a removed plugin
 * leaves the worker.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { HTTP_PATHS, PROTOCOL_VERSION } from '@landflow/protocol';
import { defineNode, definePlugin, type IPlugin } from '@landflow/sdk';

vi.setConfig({ testTimeout: 20_000 });
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-plugin-restarts-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_DB: 'sqlite', LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { PluginRegistry } = await import('@/lib/server/plugins/registry');
const { persistRegistrations, syncRegistrations, syncedEndpoints } = await import('@/lib/server/cluster/plugins');
const { database } = await import('@/lib/server/db');
const { createFetchHandler } = await import('@landflow/sdk/http');

const nodeNamed = (name: string) =>
  defineNode({
    description: { name, displayName: name, description: '', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
    execute: (ctx) => ctx.getInputData().map((item) => ({ json: item.json })),
  });
const pluginWith = (id: string, nodes: string[], version = '1.0.0') => definePlugin({ info: { id, name: `Restart ${id}`, version }, nodes: nodes.map(nodeNamed) });

const servers: Server[] = [];
afterAll(() => {
  for (const server of servers) server.close();
});

/** An HTTP plugin we can "restart" with another build; it counts manifest pulls. */
async function pluginProcess(initial: IPlugin) {
  let handle = createFetchHandler(initial);
  const fake = { url: '', pulls: 0, restart: (plugin: IPlugin) => (handle = createFetchHandler(plugin)) };
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith(HTTP_PATHS.manifest)) fake.pulls++;
    const response = await handle(new Request(`http://plugin${req.url}`));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

const announce = (endpoint: string, pluginId: string, instanceId: string) => ({ protocol: PROTOCOL_VERSION, endpoint, pluginId, version: '1.0.0', ttlSeconds: 30, instanceId });
const nodesOf = (registry: InstanceType<typeof PluginRegistry>, id: string) => registry.list().find((p) => p.id === id)?.nodes.map((n) => n.name);
const row = (endpoint: string) => database().get<{ manifest: string; registered_by: string }>('SELECT manifest, registered_by FROM plugin_registrations WHERE endpoint = ?', endpoint);

describe('a plugin restarted with the same version', () => {
  it('reaches the worker: the main writes the new instance and manifest hash, the worker pulls the manifest again', async () => {
    const main = new PluginRegistry();
    const worker = new PluginRegistry();
    const plugin = await pluginProcess(pluginWith('restart-me', ['one']));

    await main.announce(announce(plugin.url, 'restart-me', 'run-1'));
    persistRegistrations('main-1', undefined, { registry: main });
    const first = JSON.parse(row(plugin.url)!.manifest) as { instance: string; hash: string; nodes: string[] };
    expect(first).toMatchObject({ instance: 'run-1', nodes: ['one'] });
    expect(first.hash).toMatch(/^[0-9a-f]{16}$/);

    expect(await syncRegistrations({ registry: worker })).toBe(1);
    expect(nodesOf(worker, 'restart-me')).toEqual(['one']);
    expect(syncedEndpoints(worker)).toEqual([plugin.url]);
    expect(worker.endpointInfo(plugin.url)).toMatchObject({ source: 'static', manifestHash: first.hash });

    // Nothing changed: neither side pulls again.
    let pulls = plugin.pulls;
    persistRegistrations('main-1', undefined, { registry: main });
    await syncRegistrations({ registry: worker });
    expect(plugin.pulls).toBe(pulls);

    // Restarted with a new node, the same version: the main re-pulls on the new instanceId…
    plugin.restart(pluginWith('restart-me', ['one', 'two']));
    await main.announce(announce(plugin.url, 'restart-me', 'run-2'));
    expect(nodesOf(main, 'restart-me')).toEqual(['one', 'two']);
    persistRegistrations('main-1', undefined, { registry: main });
    const second = JSON.parse(row(plugin.url)!.manifest) as { instance: string; hash: string; nodes: string[] };
    expect(second).toMatchObject({ instance: 'run-2', nodes: ['one', 'two'] });
    expect(second.hash).not.toBe(first.hash);

    // …and so does the worker, once.
    pulls = plugin.pulls;
    await syncRegistrations({ registry: worker });
    expect(nodesOf(worker, 'restart-me')).toEqual(['one', 'two']);
    expect(worker.endpointInfo(plugin.url)).toMatchObject({ instanceId: 'run-2', manifestHash: second.hash });
    expect(plugin.pulls).toBe(pulls + 1);
    await syncRegistrations({ registry: worker });
    expect(plugin.pulls).toBe(pulls + 1);

    // A restart with the very same build still counts (a new process): one pull each.
    pulls = plugin.pulls;
    await main.announce(announce(plugin.url, 'restart-me', 'run-3'));
    persistRegistrations('main-1', undefined, { registry: main });
    await syncRegistrations({ registry: worker });
    expect(JSON.parse(row(plugin.url)!.manifest)).toMatchObject({ instance: 'run-3', hash: second.hash });
    expect(plugin.pulls).toBe(pulls + 2);

    // Removed on the main: it leaves the table, then the worker.
    main.remove('restart-me');
    persistRegistrations('main-1', 'restart-me', { registry: main });
    expect(row(plugin.url)).toBeUndefined();
    await syncRegistrations({ registry: worker });
    expect(nodesOf(worker, 'restart-me')).toBeUndefined();
    expect(syncedEndpoints(worker)).toEqual([]);
  });

  it('a worker that could not reach the plugin tries the re-pull again at its next sync', async () => {
    const main = new PluginRegistry();
    const worker = new PluginRegistry();
    const plugin = await pluginProcess(pluginWith('restart-later', ['one']));
    await main.announce(announce(plugin.url, 'restart-later', 'a'));
    persistRegistrations('main-1', undefined, { registry: main });
    await syncRegistrations({ registry: worker });

    plugin.restart(pluginWith('restart-later', ['one', 'two']));
    await main.announce(announce(plugin.url, 'restart-later', 'b'));
    persistRegistrations('main-1', undefined, { registry: main });
    // The worker's pull fails this time (the plugin went away for a moment).
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as typeof fetch;
    try {
      await syncRegistrations({ registry: worker });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(nodesOf(worker, 'restart-later')).toEqual(['one']);
    await syncRegistrations({ registry: worker });
    expect(nodesOf(worker, 'restart-later')).toEqual(['one', 'two']);
    main.remove('restart-later');
    persistRegistrations('main-1', 'restart-later', { registry: main });
  });

  it('never writes a process-local endpoint (a marketplace node plugin each process runs itself)', async () => {
    const main = new PluginRegistry();
    const plugin = await pluginProcess(pluginWith('local-copy', ['one']));
    await main.addEndpoint(plugin.url, 'static', undefined, { local: true });
    persistRegistrations('main-1', undefined, { registry: main });
    expect(row(plugin.url)).toBeUndefined();
    expect(main.endpointInfo(plugin.url)).toMatchObject({ local: true });
    main.remove('local-copy');
  });
});
