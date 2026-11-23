/**
 * Announce and plugin restarts (lib/server/plugins/registry.ts, docs/protocol.md §2): an announce from an online endpoint
 * with the same version is a heartbeat that only renews the lease, unless it carries another `instanceId` (the plugin
 * process restarted, maybe with new nodes but the same version): then the manifest is pulled again and the usual
 * `plugin.updated` event goes out, with the registry proof for endpoints that need one (§13). Announces without an id
 * (older plugins) behave as before. The HTTP route and the gRPC registry pass the id through from the SDK's announcer.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { HTTP_PATHS, PROTOCOL_VERSION, type AnnounceRequest } from '@landflow/protocol';
import { defineNode, definePlugin, REGISTRY_CHALLENGE_HEADER, REGISTRY_PROOF_HEADER, type IPlugin } from '@landflow/sdk';
import type { RegistryEvent } from '@/lib/shared/types';

vi.setConfig({ testTimeout: 20_000 });
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-announce-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { registry } = await import('@/lib/server/plugins/registry');
const { bus } = await import('@/lib/server/bus');
const { createFetchHandler } = await import('@landflow/sdk/http');

const nodeNamed = (name: string) =>
  defineNode({
    description: { name, displayName: name, description: '', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
    execute: (ctx) => ctx.getInputData().map((item) => ({ json: item.json })),
  });
const pluginWith = (id: string, nodes: string[], version = '1.0.0') => definePlugin({ info: { id, name: `Announce ${id}`, version }, nodes: nodes.map(nodeNamed) });

interface FakeProcess {
  url: string;
  /** Every GetManifest, with the registry challenge it carried (null: none). */
  pulls: Array<string | null>;
  /** "Restart" the plugin with another build (other nodes, the same version or not). */
  restart(plugin: IPlugin): void;
  /** Answer challenges without a proof (an older SDK, or the secret was taken away). */
  dropProof: boolean;
}

const servers: Server[] = [];
/** An HTTP plugin endpoint whose process we can restart with other nodes; it counts manifest pulls. */
async function pluginProcess(initial: IPlugin): Promise<FakeProcess> {
  let handle = createFetchHandler(initial);
  const fake: FakeProcess = { url: '', pulls: [], restart: (plugin) => (handle = createFetchHandler(plugin)), dropProof: false };
  const server = createServer(async (req, res) => {
    const headers = new Headers(Object.entries(req.headers).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v] as [string, string]] : [])));
    if (req.url?.startsWith(HTTP_PATHS.manifest)) fake.pulls.push(headers.get(REGISTRY_CHALLENGE_HEADER));
    const response = await handle(new Request(`http://plugin${req.url}`, { headers }));
    const out = Object.fromEntries(response.headers);
    if (fake.dropProof) delete out[REGISTRY_PROOF_HEADER];
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

const announce = (endpoint: string, pluginId: string, instanceId?: string, version = '1.0.0'): AnnounceRequest => ({
  protocol: PROTOCOL_VERSION,
  endpoint,
  pluginId,
  version,
  ttlSeconds: 30,
  ...(instanceId && { instanceId }),
});
const nodeNames = (pluginId: string) => registry.list().find((p) => p.id === pluginId)?.nodes.map((n) => n.name);
const leaseOf = (pluginId: string) => Date.parse(registry.list().find((p) => p.id === pluginId)!.endpoints[0].leaseExpiresAt!);

/** Registry events from now on (heartbeats included), as `type` strings. */
function recordEvents() {
  const seen: RegistryEvent[] = [];
  const stop = bus.subscribe((message) => message.channel === 'registry' && seen.push(message.event));
  stoppers.push(stop);
  return () => seen.map((event) => event.type);
}
const stoppers: Array<() => void> = [];

afterEach(() => {
  delete process.env.LANDFLOW_REGISTRY_SECRET;
  for (const stop of stoppers.splice(0)) stop();
});
afterAll(() => {
  for (const server of servers) server.close();
});

describe('announce with an instanceId', () => {
  it('pulls the manifest again when an online endpoint announces another instanceId with the same version', async () => {
    const plugin = await pluginProcess(pluginWith('ann-restart', ['one']));
    await registry.announce(announce(plugin.url, 'ann-restart', 'process-a'));
    expect(plugin.pulls).toHaveLength(1);
    expect(nodeNames('ann-restart')).toEqual(['one']);

    // Restarted within its lease with a new node and the same version (development): the new process announces.
    plugin.restart(pluginWith('ann-restart', ['one', 'two']));
    const events = recordEvents();
    await registry.announce(announce(plugin.url, 'ann-restart', 'process-b'));
    expect(plugin.pulls).toHaveLength(2);
    expect(nodeNames('ann-restart')).toEqual(['one', 'two']);
    expect(registry.nodeTypes().find((t) => t.type === 'ann-restart.two')).toMatchObject({ available: true });
    expect(events()).toEqual(['plugin.updated']);

    // The new process's heartbeats renew the lease without another pull.
    await registry.announce(announce(plugin.url, 'ann-restart', 'process-b'));
    expect(plugin.pulls).toHaveLength(2);
    expect(events()).toEqual(['plugin.updated', 'plugin.heartbeat']);
    registry.remove('ann-restart');
  });

  it('only heartbeats while the instanceId stays the same', async () => {
    const plugin = await pluginProcess(pluginWith('ann-same', ['one']));
    await registry.announce(announce(plugin.url, 'ann-same', 'process-a'));
    const lease = leaseOf('ann-same');
    // Even if what it serves changed: the same process announcing again is not a restart.
    plugin.restart(pluginWith('ann-same', ['one', 'two']));
    const events = recordEvents();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await registry.announce(announce(plugin.url, 'ann-same', 'process-a'));
    await registry.announce(announce(plugin.url, 'ann-same', 'process-a'));
    expect(plugin.pulls).toHaveLength(1);
    expect(nodeNames('ann-same')).toEqual(['one']);
    expect(events()).toEqual(['plugin.heartbeat', 'plugin.heartbeat']);
    expect(leaseOf('ann-same')).toBeGreaterThan(lease);

    // A Refresh keeps the instance: its next heartbeat is still just a heartbeat.
    await registry.refresh('ann-same');
    expect(plugin.pulls).toHaveLength(2);
    await registry.announce(announce(plugin.url, 'ann-same', 'process-a'));
    expect(plugin.pulls).toHaveLength(2);
    registry.remove('ann-same');
  });

  it('keeps today’s behaviour for announces without an instanceId', async () => {
    const plugin = await pluginProcess(pluginWith('ann-old', ['one']));
    await registry.announce(announce(plugin.url, 'ann-old'));
    // Restarted with new nodes, same version, no id: a heartbeat, the old manifest stays until a Refresh.
    plugin.restart(pluginWith('ann-old', ['one', 'two']));
    const events = recordEvents();
    await registry.announce(announce(plugin.url, 'ann-old'));
    expect(plugin.pulls).toHaveLength(1);
    expect(nodeNames('ann-old')).toEqual(['one']);
    expect(events()).toEqual(['plugin.heartbeat']);
    // A new version, or coming back after a withdraw, pulls it as before.
    plugin.restart(pluginWith('ann-old', ['one', 'two'], '1.1.0'));
    await registry.announce(announce(plugin.url, 'ann-old', undefined, '1.1.0'));
    expect(plugin.pulls).toHaveLength(2);
    expect(nodeNames('ann-old')).toEqual(['one', 'two']);
    plugin.restart(pluginWith('ann-old', ['three'], '1.1.0'));
    registry.withdraw(plugin.url);
    await registry.announce(announce(plugin.url, 'ann-old', undefined, '1.1.0'));
    expect(plugin.pulls).toHaveLength(3);
    expect(nodeNames('ann-old')).toEqual(['three']);

    // The same endpoint upgraded to an SDK that sends an id: pulled once on its first announce with one, then heartbeats.
    plugin.restart(pluginWith('ann-old', ['three', 'four'], '1.1.0'));
    await registry.announce(announce(plugin.url, 'ann-old', 'process-new', '1.1.0'));
    expect(plugin.pulls).toHaveLength(4);
    expect(nodeNames('ann-old')).toEqual(['three', 'four']);
    await registry.announce(announce(plugin.url, 'ann-old', 'process-new', '1.1.0'));
    expect(plugin.pulls).toHaveLength(4);
    registry.remove('ann-old');
  });

  it('re-pulls with the registry proof an endpoint needs (§13), and refuses the restart without one', async () => {
    process.env.LANDFLOW_REGISTRY_SECRET = 'announce-s3cret';

    // Announced endpoints prove the secret too (the announce's header alone is not enough): every pull carries a challenge.
    const announced = await pluginProcess(pluginWith('ann-secret', ['one']));
    await registry.announce(announce(announced.url, 'ann-secret', 'process-a'));
    announced.restart(pluginWith('ann-secret', ['one', 'two']));
    await registry.announce(announce(announced.url, 'ann-secret', 'process-b'));
    expect(announced.pulls).toHaveLength(2);
    expect(announced.pulls.every((challenge) => typeof challenge === 'string' && challenge.length === 43)).toBe(true);
    expect(nodeNames('ann-secret')).toEqual(['one', 'two']);

    // A discovered endpoint must prove the secret on every GetManifest, the re-pull after a restart included.
    const discovered = await pluginProcess(pluginWith('ann-proof', ['one']));
    await registry.addEndpoint(discovered.url, 'kubernetes', undefined, { origin: { namespace: 'landflow-dev', service: 'ann-proof' }, requireProof: true });
    await registry.announce(announce(discovered.url, 'ann-proof', 'process-a'));
    expect(discovered.pulls).toHaveLength(2);
    expect(discovered.pulls.every((challenge) => typeof challenge === 'string' && challenge.length === 43)).toBe(true);
    expect(registry.list().find((p) => p.id === 'ann-proof')?.endpoints[0].origin).toEqual({ namespace: 'landflow-dev', service: 'ann-proof' });

    // Restarted without the secret: no proof, so the new manifest is refused and the old one stays.
    discovered.restart(pluginWith('ann-proof', ['one', 'two']));
    discovered.dropProof = true;
    await expect(registry.announce(announce(discovered.url, 'ann-proof', 'process-b'))).rejects.toThrow('did not prove the registry secret');
    expect(nodeNames('ann-proof')).toEqual(['one']);
    // It is asked again on its next announce (the new instance was not taken), and accepted once it proves the secret.
    discovered.dropProof = false;
    await registry.announce(announce(discovered.url, 'ann-proof', 'process-b'));
    expect(discovered.pulls).toHaveLength(4);
    expect(typeof discovered.pulls[3]).toBe('string');
    expect(nodeNames('ann-proof')).toEqual(['one', 'two']);
    registry.remove('ann-secret');
    registry.remove('ann-proof');
  });
});

describe('the registry transports pass the instanceId through', () => {
  it('HTTP: POST /api/plugins/announce', async () => {
    const route = await import('@/app/api/plugins/announce/route');
    const post = (body: object) => route.POST(new Request('http://host.test/api/plugins/announce', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
    const plugin = await pluginProcess(pluginWith('ann-http', ['one']));
    expect((await post(announce(plugin.url, 'ann-http', 'process-a'))).status).toBe(200);
    expect((await post(announce(plugin.url, 'ann-http', 'process-a'))).status).toBe(200);
    expect(plugin.pulls).toHaveLength(1);
    expect((await post(announce(plugin.url, 'ann-http', 'process-b'))).status).toBe(200);
    expect(plugin.pulls).toHaveLength(2);
    // Opaque but bounded.
    expect((await post(announce(plugin.url, 'ann-http', 'x'.repeat(129)))).status).toBe(400);
    expect((await post({ ...announce(plugin.url, 'ann-http'), instanceId: '' })).status).toBe(400);
    registry.remove('ann-http');
  });

  it('gRPC: RegistryService.Announce, from the TypeScript SDK’s announcer', async () => {
    const { startRegistryGrpcServer } = await import('@/lib/server/plugins/registry-grpc');
    const { INSTANCE_ID, startAnnouncer } = await import('@landflow/sdk/announce');
    const port = 47393;
    process.env.LANDFLOW_REGISTRY_GRPC_PORT = String(port);
    const server = await startRegistryGrpcServer();
    process.env.LANDFLOW_REGISTRY_GRPC_PORT = 'off';
    expect(server).toBeDefined();
    const plugin = await pluginProcess(pluginWith('ann-grpc', ['one']));
    const announcer = await startAnnouncer({ registryUrl: `grpc://127.0.0.1:${port}`, endpoints: [plugin.url], pluginId: 'ann-grpc', version: '1.0.0', log: () => {} });
    try {
      expect(plugin.pulls).toHaveLength(1);
      // The registry stored the SDK's id: the same one is a heartbeat, another one a restart.
      await registry.announce(announce(plugin.url, 'ann-grpc', INSTANCE_ID));
      expect(plugin.pulls).toHaveLength(1);
      await registry.announce(announce(plugin.url, 'ann-grpc', `${INSTANCE_ID}-restarted`));
      expect(plugin.pulls).toHaveLength(2);
    } finally {
      await announcer.stop();
      server!.forceShutdown();
      registry.remove('ann-grpc');
    }
  });
});
