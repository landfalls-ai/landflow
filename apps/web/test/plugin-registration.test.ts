/**
 * Who may register or join a plugin (docs/plugins.md "Registration rules"): in the production profile an announce
 * without LANDFLOW_REGISTRY_SECRET is refused (401 on the route, UNAUTHENTICATED on gRPC) unless LANDFLOW_REGISTRY_OPEN=true;
 * development stays open; with the secret every announced endpoint must prove it holds it; an endpoint on a new host
 * may not join an existing plugin without the secret (409); joins and version changes reach the audit log; the route
 * answers a generic 422 and metadata addresses are refused in production.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type AnnounceRequest } from '@landflow/protocol';
import { defineNode, definePlugin, REGISTRY_PROOF_HEADER, type IPlugin } from '@landflow/sdk';

vi.setConfig({ testTimeout: 20_000 });
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-registration-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });

const { registry } = await import('@/lib/server/plugins/registry');
const { guardRequest } = await import('@/lib/server/auth/guard');
const { registryJoinAllowed, registryRefusesAddress } = await import('@/lib/server/plugins/registry-policy');
const { createFetchHandler } = await import('@landflow/sdk/http');
const announceRoute = await import('@/app/api/plugins/announce/route');
const { ensureListeners } = await import('@/lib/server/audit');
const { queryEvents } = await import('@/lib/server/audit/store');

const BASE = 'http://localhost:3000';
const node = (name: string) =>
  defineNode({
    description: { name, displayName: name, description: '', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
    execute: (ctx) => ctx.getInputData().map((item) => ({ json: item.json })),
  });
const pluginWith = (id: string, version = '1.0.0'): IPlugin => definePlugin({ info: { id, name: `Reg ${id}`, version }, nodes: [node('echo')] });

const servers: Server[] = [];
/** An HTTP plugin endpoint; `dropProof` answers challenges without a proof (an SDK without the secret). */
async function plugin(initial: IPlugin, options: { host?: string; dropProof?: boolean } = {}) {
  let handle = createFetchHandler(initial);
  const server = createServer(async (req, res) => {
    const headers = new Headers(Object.entries(req.headers).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v] as [string, string]] : [])));
    const response = await handle(new Request(`http://plugin${req.url}`, { headers }));
    const out = Object.fromEntries(response.headers);
    if (options.dropProof) delete out[REGISTRY_PROOF_HEADER];
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, options.host ?? '127.0.0.1', resolve));
  servers.push(server);
  return { url: `http://${options.host ?? '127.0.0.1'}:${(server.address() as AddressInfo).port}`, restart: (next: IPlugin) => (handle = createFetchHandler(next)) };
}

const announce = (endpoint: string, pluginId: string): AnnounceRequest => ({ protocol: PROTOCOL_VERSION, endpoint, pluginId, version: '1.0.0', ttlSeconds: 30 });
const post = (body: unknown, headers: Record<string, string> = {}) => new Request(`${BASE}/api/plugins/announce`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const lanAddress = Object.values(networkInterfaces()).flat().find((a) => a?.family === 'IPv4' && !a.internal)?.address;

afterEach(() => {
  for (const name of ['LANDFLOW_REGISTRY_SECRET', 'LANDFLOW_PROFILE', 'LANDFLOW_REGISTRY_OPEN', 'LANDFLOW_REGISTRY_ALLOW_JOIN']) delete process.env[name];
});
afterAll(() => {
  for (const server of servers) server.close();
});

describe('who may announce', () => {
  it('production without a secret: 401 on the route; LANDFLOW_REGISTRY_OPEN=true opens it again', () => {
    process.env.LANDFLOW_PROFILE = 'production';
    const status = () => {
      const result = guardRequest(post({}));
      return result.ok ? 200 : result.response.status;
    };
    expect(status()).toBe(401);
    process.env.LANDFLOW_REGISTRY_OPEN = 'true';
    expect(status()).toBe(200);
    delete process.env.LANDFLOW_REGISTRY_OPEN;
    process.env.LANDFLOW_REGISTRY_SECRET = 's3cret';
    expect(status()).toBe(401);
    expect(guardRequest(post({}, { 'x-landflow-registry-secret': 's3cret' })).ok).toBe(true);
  });

  it('development without a secret is accepted as before', async () => {
    expect(guardRequest(post({})).ok).toBe(true);
    const target = await plugin(pluginWith('reg-dev'));
    const response = await announceRoute.POST(post(announce(target.url, 'reg-dev')));
    expect(response.status).toBe(200);
    expect(registry.list().find((p) => p.id === 'reg-dev')?.status).toBe('online');
    registry.remove('reg-dev');
  });
});

describe('proof for announced endpoints', () => {
  it('with the secret set, an endpoint that cannot prove it is refused; one that can is accepted', async () => {
    process.env.LANDFLOW_REGISTRY_SECRET = 'reg-s3cret';
    const silent = await plugin(pluginWith('reg-silent'), { dropProof: true });
    await expect(registry.announce(announce(silent.url, 'reg-silent'))).rejects.toThrow(/did not prove/);
    expect(registry.list().find((p) => p.id === 'reg-silent')).toBeUndefined();

    const proving = await plugin(pluginWith('reg-proving'));
    await registry.announce(announce(proving.url, 'reg-proving'));
    expect(registry.list().find((p) => p.id === 'reg-proving')?.status).toBe('online');
    registry.remove('reg-proving');
  });

  it('the route answers a generic 422 that does not echo the error or the endpoint', async () => {
    process.env.LANDFLOW_REGISTRY_SECRET = 'reg-s3cret';
    const silent = await plugin(pluginWith('reg-generic'), { dropProof: true });
    const response = await announceRoute.POST(post(announce(silent.url, 'reg-generic'), { 'x-landflow-registry-secret': 'reg-s3cret' }));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toMatchObject({ error: 'Could not register the plugin: its endpoint did not answer with a valid manifest', accepted: false, heartbeatIntervalSeconds: 10 });
    expect(JSON.stringify(body)).not.toContain(silent.url);
  });

  it('production refuses metadata and link-local endpoints before connecting', async () => {
    process.env.LANDFLOW_PROFILE = 'production';
    process.env.LANDFLOW_REGISTRY_OPEN = 'true';
    expect(registryRefusesAddress('http://169.254.169.254/latest')).toBe(true);
    expect(registryRefusesAddress('http://[fd00:ec2::254]:80')).toBe(true);
    expect(registryRefusesAddress('http://10.0.0.5:8080')).toBe(false);
    const response = await announceRoute.POST(post(announce('http://169.254.169.254:80', 'reg-meta')));
    expect(response.status).toBe(422);
    delete process.env.LANDFLOW_PROFILE;
    expect(registryRefusesAddress('http://169.254.169.254/latest')).toBe(false);
  });
});

describe('joining an existing plugin', () => {
  it('the join policy: same host (loopback counts as one) joins; another host needs the allow flag', () => {
    expect(registryJoinAllowed('http://localhost:9002', ['http://127.0.0.1:9001'])).toBe(true);
    expect(registryJoinAllowed('http://10.1.2.3:9002', ['http://10.1.2.3:9001'])).toBe(true);
    expect(registryJoinAllowed('http://10.1.2.4:9002', ['http://10.1.2.3:9001'])).toBe(false);
    process.env.LANDFLOW_REGISTRY_ALLOW_JOIN = 'true';
    expect(registryJoinAllowed('http://10.1.2.4:9002', ['http://10.1.2.3:9001'])).toBe(true);
  });

  it.skipIf(!lanAddress)('without a secret a join from another host is 409 and audited when allowed; with the secret it is proven and audited', async () => {
    ensureListeners();
    const first = await plugin(pluginWith('reg-join'));
    await registry.announce(announce(first.url, 'reg-join'));
    const second = await plugin(pluginWith('reg-join'), { host: '0.0.0.0' });
    const lan = second.url.replace('0.0.0.0', lanAddress!);

    const refused = await announceRoute.POST(post(announce(lan, 'reg-join')));
    expect(refused.status).toBe(409);
    expect(registry.list().find((p) => p.id === 'reg-join')?.endpoints).toHaveLength(1);

    process.env.LANDFLOW_REGISTRY_ALLOW_JOIN = 'true';
    expect((await announceRoute.POST(post(announce(lan, 'reg-join')))).status).toBe(200);
    expect(registry.list().find((p) => p.id === 'reg-join')?.endpoints).toHaveLength(2);
    delete process.env.LANDFLOW_REGISTRY_ALLOW_JOIN;

    // Same-host joins are always fine, and the version change is audited too.
    const third = await plugin(pluginWith('reg-join', '1.1.0'));
    await registry.announce({ ...announce(third.url, 'reg-join'), version: '1.1.0' });

    const events = queryEvents({ action: ['plugin.endpoint_added'] }).events.filter((e) => e.target?.id === 'reg-join');
    expect(events.map((e) => e.details?.endpoint)).toEqual(expect.arrayContaining([lan, third.url]));
    expect(events[0].details).toMatchObject({ source: 'announce', transport: 'http' });
    expect(queryEvents({ action: ['plugin.updated'] }).events.some((e) => e.target?.id === 'reg-join' && e.details?.to === '1.1.0')).toBe(true);
    registry.remove('reg-join');
  });

  it('with the secret set, a join from any host is accepted when it proves itself', async () => {
    ensureListeners();
    process.env.LANDFLOW_REGISTRY_SECRET = 'reg-s3cret';
    const first = await plugin(pluginWith('reg-join-proven'));
    await registry.announce(announce(first.url, 'reg-join-proven'));
    const second = await plugin(pluginWith('reg-join-proven'));
    await registry.announce(announce(second.url, 'reg-join-proven'));
    expect(registry.list().find((p) => p.id === 'reg-join-proven')?.endpoints).toHaveLength(2);
    const added = queryEvents({ action: ['plugin.endpoint_added'] }).events.filter((e) => e.target?.id === 'reg-join-proven');
    expect(added).toHaveLength(1);
    expect(added[0].details?.endpoint).toBe(second.url);
    registry.remove('reg-join-proven');
  });
});
