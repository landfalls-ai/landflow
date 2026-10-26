/**
 * The MCP gateway sync (lib/server/mcp/gateway-sync.ts, docs/transports.md "Automatic registration") against a fake
 * adapter and a fake clock: targets for online, exposed plugins with tools (plus core) are added, a changed render is
 * updated, a plugin offline for 60 s is removed (and kept before that), "Expose to agents" off removes it, drift is
 * repaired, only Landflow's own targets are touched, per-plugin routes come and go with the target, the core endpoint
 * is told after each change, the file adapter re-renders the whole Landflow part of a YAML config, the owned names
 * survive in `mcp_gateway_resources`, and old token rows are purged. Then the real agentgateway admin API with
 * `tmp-` names when LANDFLOW_TEST_MCP_GATEWAY_ADMIN (e.g. http://127.0.0.1:55000) is set.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-mcp-gateway-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_ENCRYPTION_KEY: 'mcp-gateway-test-key', LANDFLOW_PUBLIC_URL: 'http://mcp.test' });

import type { GatewayRoute, GatewayTarget, McpGatewayAdapter, SyncPlugin } from '@/lib/server/mcp/gateway-sync';

const { McpGatewaySync, MemoryOwnedStore, dbOwnedStore, gatewayTargetName, renderTarget, renderRoutes, routePoliciesFor, inlineHostJwks, sameJson, OFFLINE_GRACE_MS } = await import('@/lib/server/mcp/gateway-sync');
const { AgentgatewayAdapter, FileGatewayAdapter } = await import('@/lib/server/mcp/gateway-adapters');
const { createUser } = await import('@/lib/server/auth/users');
const { issueMcpToken, listMcpTokens, mcpJwks, purgeMcpTokens, revokeMcpToken } = await import('@/lib/server/mcp/tokens');

const SECRET = 'test-gateway-secret-0123456789';
const HOST = 'http://127.0.0.1:3000';

/** An adapter that remembers what it was told, and whose stored values the test can corrupt. */
class FakeAdapter implements McpGatewayAdapter {
  readonly kind = 'fake';
  readonly location = 'memory';
  readonly targets = new Map<string, GatewayTarget['value']>();
  readonly routes = new Map<string, GatewayRoute['value']>();
  readonly log: string[] = [];
  async health() {
    return { ok: true, version: '1.6.0-fake' };
  }
  async list() {
    return [...this.targets.values()];
  }
  async upsert(target: GatewayTarget) {
    this.log.push(`upsert ${target.name}`);
    this.targets.set(target.name, structuredClone(target.value));
  }
  async remove(name: string) {
    this.log.push(`remove ${name}`);
    this.targets.delete(name);
  }
  async listRoutes() {
    return [...this.routes.values()];
  }
  async upsertRoute(route: GatewayRoute) {
    this.log.push(`route ${route.name}`);
    this.routes.set(route.name, structuredClone(route.value));
  }
  async removeRoute(name: string) {
    this.log.push(`unroute ${name}`);
    this.routes.delete(name);
  }
}

function harness(initial: SyncPlugin[], options: { routes?: boolean; store?: InstanceType<typeof MemoryOwnedStore> } = {}) {
  const plugins = [...initial];
  const clock = { now: 1_000_000 };
  const adapter = new FakeAdapter();
  const changes: number[] = [];
  const store = options.store ?? new MemoryOwnedStore();
  const sync = new McpGatewaySync({
    mode: 'bundled',
    adapter,
    plugins: () => plugins,
    now: () => clock.now,
    hostUrl: () => HOST,
    secret: () => SECRET,
    store,
    routes: options.routes ?? false,
    routePolicies: () => undefined,
    onChanged: () => changes.push(clock.now),
    purge: null,
  });
  const set = (id: string, patch: Partial<SyncPlugin>) => {
    const i = plugins.findIndex((p) => p.id === id);
    if (i >= 0) Object.assign(plugins[i], patch);
    else plugins.push({ id, online: true, exposed: true, tools: 1, ...patch });
  };
  const drop = (id: string) => plugins.splice(plugins.findIndex((p) => p.id === id), 1);
  return { plugins, clock, adapter, changes, store, sync, set, drop };
}

const base = (): SyncPlugin[] => [
  { id: 'core', online: true, exposed: true, tools: 8 },
  { id: 'text-toolkit', online: true, exposed: true, tools: 2 },
  { id: 'empty', online: true, exposed: true, tools: 0 },
  { id: 'hidden', online: true, exposed: false, tools: 3 },
  { id: 'down', online: false, exposed: true, tools: 3 },
];

describe('target names and rendering', () => {
  it('keeps ids that already fit, and maps the rest deterministically', () => {
    expect(gatewayTargetName('text-toolkit')).toBe('text-toolkit');
    expect(gatewayTargetName('core')).toBe('core');
    expect(gatewayTargetName('a.b-c9')).toBe('a.b-c9');
    const mapped = gatewayTargetName('My_Plugin');
    expect(mapped).toMatch(/^my-plugin-[0-9a-f]{6}$/);
    expect(gatewayTargetName('My_Plugin')).toBe(mapped);
    expect(gatewayTargetName('my_plugin')).not.toBe(mapped);
    expect(gatewayTargetName('__')).toMatch(/^plugin-[0-9a-f]{6}$/);
    for (const id of ['My_Plugin', 'x'.repeat(80), 'ünïcode', '-lead']) expect(gatewayTargetName(id)).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
  });

  it('renders the verified target shape with the secret, the caller headers and the authorization removal', () => {
    const target = renderTarget('text-toolkit', { hostUrl: HOST, secret: SECRET });
    expect(target.value).toEqual({
      name: 'text-toolkit',
      mcp: { host: 'http://127.0.0.1:3000/api/mcp/plugins/text-toolkit' },
      policies: {
        backendAuth: { key: { value: SECRET, location: { header: { name: 'x-landflow-gateway' } } } },
        transformations: { request: { set: { 'x-landflow-caller-iss': 'jwt.iss', 'x-landflow-caller-sub': 'jwt.sub', 'x-landflow-caller-jti': 'jwt.jti' }, remove: ['authorization'] } },
      },
    });
    const routes = renderRoutes('text-toolkit', { hostUrl: HOST, secret: SECRET, routePolicies: { mcpAuthentication: { issuer: 'x' } } });
    expect(routes.map((r) => r.name)).toEqual(['landflow-mcp-text-toolkit', 'landflow-card-text-toolkit']);
    expect(routes[0].value.matches[0]).toEqual({ path: { exact: '/mcp/plugins/text-toolkit' } });
    expect(routes[0].value.policies).toEqual({ mcpAuthentication: { issuer: 'x' } });
    expect((routes[0].value.backends[0] as { mcp: { targets: unknown[] } }).mcp.targets).toEqual([target.value]);
    expect(routes[1].value.matches[0]).toEqual({ path: { exact: '/mcp/plugins/text-toolkit/server-card' }, method: 'GET' });
    expect(routes[1].value.backends[0]).toEqual({ host: '127.0.0.1:3000' });
    expect(routes[1].value.policies).toEqual({ urlRewrite: { authority: 'auto', path: { full: '/api/mcp/plugins/text-toolkit/server-card' } } });
  });

  it('completes a route policy’s mcpAuthentication with the route’s own resource metadata', () => {
    const auth = { mode: 'optional', issuer: 'http://landflow.test', audiences: ['http://gw.test/mcp'], jwks: { url: 'http://landflow.test/api/mcp/jwks' } };
    const [route] = renderRoutes('text-toolkit', { hostUrl: HOST, secret: SECRET, routePolicies: { mcpAuthentication: auth }, publicUrl: 'http://gw.test/' });
    expect(route.value.policies).toEqual({
      mcpAuthentication: { ...auth, resourceMetadata: { resource: 'http://gw.test/mcp/plugins/text-toolkit', authorization_servers: ['http://landflow.test'], bearer_methods_supported: ['header'] } },
    });
    // Given metadata, no public URL, or no sign-in: left as configured.
    const own = { mcpAuthentication: { ...auth, resourceMetadata: { resource: 'x' } } };
    expect(routePoliciesFor(own, '/mcp/plugins/a', 'http://gw.test')).toBe(own);
    expect(routePoliciesFor({ mcpAuthentication: auth }, '/mcp/plugins/a', undefined)).toEqual({ mcpAuthentication: auth });
    expect(routePoliciesFor({ cors: {} }, '/mcp/plugins/a', 'http://gw.test')).toEqual({ cors: {} });
  });

  it('inlines the host’s own JWKS in route policies, so a stored route does not need the host to be up', async () => {
    const keys = await mcpJwks();
    const auth = { mode: 'optional', issuer: 'http://landflow.test', jwks: { url: 'http://host.docker.internal:3000/api/mcp/jwks' } };
    const inlined = await inlineHostJwks({ mcpAuthentication: auth, cors: {} }, mcpJwks);
    expect(inlined).toEqual({ mcpAuthentication: { ...auth, jwks: JSON.stringify(keys) }, cors: {} });
    expect(JSON.parse((inlined!.mcpAuthentication as { jwks: string }).jwks).keys[0]).not.toHaveProperty('d');
    // Behind a base path too; an identity provider's keys, a file, no sign-in or no policies stay as configured (and are not read).
    const behind = await inlineHostJwks({ mcpAuthentication: { jwks: { url: 'https://example.test/landflow/api/mcp/jwks/' } } }, mcpJwks);
    expect(typeof (behind!.mcpAuthentication as { jwks: unknown }).jwks).toBe('string');
    const never = () => Promise.reject(new Error('read'));
    const idp = { mcpAuthentication: { jwks: { url: 'http://keycloak:8080/realms/x/protocol/openid-connect/certs' } } };
    expect(await inlineHostJwks(idp, never)).toBe(idp);
    const file = { mcpAuthentication: { jwks: { file: '/c/jwks.json' } } };
    expect(await inlineHostJwks(file, never)).toBe(file);
    expect(await inlineHostJwks({ cors: {} }, never)).toEqual({ cors: {} });
    expect(await inlineHostJwks(undefined, never)).toBeUndefined();
  });

  it('compares JSON structurally', () => {
    expect(sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: '1' })).toBe(false);
  });
});

describe('McpGatewaySync', () => {
  it('adds targets for online, exposed plugins with tools, plus core; nothing for empty, hidden or never-seen offline ones', async () => {
    const h = harness(base());
    const r = await h.sync.reconcile();
    expect(r.changed).toBe(true);
    expect([...h.adapter.targets.keys()].sort()).toEqual(['core', 'text-toolkit']);
    expect(h.store.list().map((o) => o.name).sort()).toEqual(['core', 'text-toolkit']);
    expect(h.changes).toHaveLength(1);
    // A second pass changes nothing and tells nobody.
    const again = await h.sync.reconcile();
    expect(again).toMatchObject({ changed: false, upserted: [], removed: [] });
    expect(h.changes).toHaveLength(1);
  });

  it('updates a target whose render changed (a new host URL) and reports it', async () => {
    let host = HOST;
    const h = harness(base());
    const sync = new McpGatewaySync({ mode: 'bundled', adapter: h.adapter, plugins: () => h.plugins, now: () => h.clock.now, hostUrl: () => host, secret: () => SECRET, store: h.store, routes: false, routePolicies: () => undefined, onChanged: () => h.changes.push(h.clock.now), purge: null });
    await sync.reconcile();
    host = 'http://10.0.0.5:3000';
    const r = await sync.reconcile();
    expect(r.upserted.sort()).toEqual(['core', 'text-toolkit']);
    expect(h.adapter.targets.get('core')?.mcp.host).toBe('http://10.0.0.5:3000/api/mcp/plugins/core');
  });

  it('keeps a target while the plugin is offline for less than 60 s, removes it after, and adds it back when it returns', async () => {
    const h = harness(base());
    await h.sync.reconcile();
    // The registry's plugin.offline event reconciles at once: that is when the 60 s start.
    h.set('text-toolkit', { online: false });
    expect((await h.sync.reconcile()).changed).toBe(false);
    h.clock.now += 10_000;
    expect((await h.sync.reconcile()).changed).toBe(false);
    expect(h.adapter.targets.has('text-toolkit')).toBe(true);
    h.clock.now += OFFLINE_GRACE_MS - 10_000 - 1;
    expect((await h.sync.reconcile()).changed).toBe(false);
    h.clock.now += 2;
    const r = await h.sync.reconcile();
    expect(r.removed).toEqual(['text-toolkit']);
    expect(h.adapter.targets.has('text-toolkit')).toBe(false);
    expect(h.store.list().map((o) => o.name)).toEqual(['core']);
    h.set('text-toolkit', { online: true });
    expect((await h.sync.reconcile()).upserted).toEqual(['text-toolkit']);
    expect(h.changes).toHaveLength(3);
  });

  it('removes a target at once when "Expose to agents" is turned off, or the plugin is uninstalled', async () => {
    const h = harness(base());
    await h.sync.reconcile();
    h.set('text-toolkit', { exposed: false });
    expect((await h.sync.reconcile()).removed).toEqual(['text-toolkit']);
    h.set('text-toolkit', { exposed: true });
    await h.sync.reconcile();
    h.drop('text-toolkit');
    expect((await h.sync.reconcile()).removed).toEqual(['text-toolkit']);
    expect([...h.adapter.targets.keys()]).toEqual(['core']);
  });

  it('repairs drift: a target someone edited, or one the gateway lost (a restart), comes back as rendered', async () => {
    const h = harness(base());
    await h.sync.reconcile();
    h.adapter.targets.get('core')!.policies = {};
    h.adapter.targets.delete('text-toolkit');
    const before = await h.sync.status();
    expect(before.targets.map((t) => [t.name, t.state])).toEqual([
      ['core', 'drift'],
      ['text-toolkit', 'missing'],
    ]);
    expect(before.drift).toBe(2);
    const r = await h.sync.reconcile();
    expect(r.upserted.sort()).toEqual(['core', 'text-toolkit']);
    expect(h.adapter.targets.get('core')).toEqual(renderTarget('core', { hostUrl: HOST, secret: SECRET }).value);
    const after = await h.sync.status();
    expect(after.inStep).toBe(2);
    expect(after.drift).toBe(0);
    expect(after.health).toEqual({ ok: true, version: '1.6.0-fake' });
  });

  it('touches only its own targets: an admin’s target stays, even when its plugin is unknown', async () => {
    const h = harness(base());
    h.adapter.targets.set('admin-added', { name: 'admin-added', mcp: { host: 'http://elsewhere/mcp' } });
    await h.sync.reconcile();
    h.drop('text-toolkit');
    await h.sync.reconcile();
    expect([...h.adapter.targets.keys()].sort()).toEqual(['admin-added', 'core']);
    expect(h.adapter.log.filter((l) => l.includes('admin-added'))).toEqual([]);
    const status = await h.sync.status();
    expect(status.targets.find((t) => t.name === 'admin-added')).toBeUndefined();
  });

  it('adopts a target that carries a plugin’s name (the name is the plugin’s by contract)', async () => {
    const h = harness(base());
    h.adapter.targets.set('core', { name: 'core', mcp: { host: 'http://stale/core' } });
    await h.sync.reconcile();
    expect(h.adapter.targets.get('core')?.mcp.host).toBe('http://127.0.0.1:3000/api/mcp/plugins/core');
  });

  it('writes per-plugin routes next to the targets and removes them with the target; routes alone never notify', async () => {
    const h = harness(base(), { routes: true });
    await h.sync.reconcile();
    expect([...h.adapter.routes.keys()].sort()).toEqual(['landflow-card-core', 'landflow-card-text-toolkit', 'landflow-mcp-core', 'landflow-mcp-text-toolkit']);
    expect(h.changes).toHaveLength(1);
    h.adapter.routes.delete('landflow-mcp-core');
    const r = await h.sync.reconcile();
    expect(r).toMatchObject({ changed: false, upserted: ['landflow-mcp-core'] });
    expect(h.changes).toHaveLength(1);
    h.set('text-toolkit', { exposed: false });
    const removed = await h.sync.reconcile();
    expect(removed.removed.sort()).toEqual(['landflow-card-text-toolkit', 'landflow-mcp-text-toolkit', 'text-toolkit']);
    expect(h.store.list().filter((o) => o.pluginId === 'text-toolkit')).toEqual([]);
  });

  it('refuses to write without the gateway secret and says why', async () => {
    const h = harness(base());
    const sync = new McpGatewaySync({ mode: 'bundled', adapter: h.adapter, plugins: () => h.plugins, now: () => h.clock.now, hostUrl: () => HOST, secret: () => undefined, store: h.store, routes: false, purge: null });
    const r = await sync.reconcile();
    expect(r.skipped).toMatch(/LANDFLOW_MCP_GATEWAY_SECRET/);
    expect(h.adapter.targets.size).toBe(0);
    expect((await sync.status()).lastError).toMatch(/SECRET/);
  });

  it('keeps the adapter’s failure as lastError and recovers on the next pass', async () => {
    const h = harness(base());
    const failing = { ...h.adapter, kind: 'fake', location: 'memory', health: () => h.adapter.health(), list: async () => h.adapter.list(), upsert: async () => { throw new Error('admin API down'); }, remove: async (n: string) => h.adapter.remove(n) } as McpGatewayAdapter;
    const sync = new McpGatewaySync({ mode: 'bundled', adapter: failing, plugins: () => h.plugins, now: () => h.clock.now, hostUrl: () => HOST, secret: () => SECRET, store: h.store, routes: false, purge: null });
    await expect(sync.reconcile()).rejects.toThrow('admin API down');
    expect((await sync.status()).lastError).toBe('admin API down');
  });

  it('coalesces concurrent reconciles', async () => {
    const h = harness(base());
    const [a, b] = await Promise.all([h.sync.reconcile(), h.sync.reconcile()]);
    expect(a).toBe(b);
  });

  it('persists the owned names in mcp_gateway_resources', async () => {
    const h = harness(base(), { store: undefined });
    const sync = new McpGatewaySync({ mode: 'bundled', adapter: h.adapter, plugins: () => h.plugins, now: () => h.clock.now, hostUrl: () => HOST, secret: () => SECRET, store: dbOwnedStore, routes: true, routePolicies: () => undefined, onChanged: () => {}, purge: null });
    await sync.reconcile();
    expect(dbOwnedStore.list().map((o) => `${o.kind}:${o.name}`).sort()).toEqual(['mcp.target:core', 'mcp.target:text-toolkit', 'traffic.route:landflow-card-core', 'traffic.route:landflow-card-text-toolkit', 'traffic.route:landflow-mcp-core', 'traffic.route:landflow-mcp-text-toolkit']);
    // A new process (a fresh sync on the same table) still knows what is its own.
    const adapter2 = h.adapter;
    adapter2.targets.set('admin-added', { name: 'admin-added', mcp: { host: 'http://elsewhere/mcp' } });
    const sync2 = new McpGatewaySync({ mode: 'bundled', adapter: adapter2, plugins: () => [{ id: 'core', online: true, exposed: true, tools: 8 }], now: () => h.clock.now, hostUrl: () => HOST, secret: () => SECRET, store: dbOwnedStore, routes: true, routePolicies: () => undefined, onChanged: () => {}, purge: null });
    const r = await sync2.reconcile();
    expect(r.removed.sort()).toEqual(['landflow-card-text-toolkit', 'landflow-mcp-text-toolkit', 'text-toolkit']);
    expect([...adapter2.targets.keys()].sort()).toEqual(['admin-added', 'core']);
    for (const o of dbOwnedStore.list()) dbOwnedStore.delete(o.kind, o.name);
  });
});

describe('FileGatewayAdapter (LANDFLOW_MCP_GATEWAY=file)', () => {
  it('re-renders Landflow’s targets and routes into the file, keeping the rest of the config and foreign entries', async () => {
    const path = join(dataDir, 'gw', 'config.yaml');
    const h = harness(base(), { routes: true });
    const adapter = new FileGatewayAdapter({ path });
    const sync = new McpGatewaySync({ mode: 'file', adapter, plugins: () => h.plugins, now: () => h.clock.now, hostUrl: () => HOST, secret: () => SECRET, store: h.store, routes: true, routePolicies: () => undefined, onChanged: () => h.changes.push(h.clock.now), purge: null });
    const first = await sync.reconcile();
    expect(first.changed).toBe(true);
    let doc = parse(readFileSync(path, 'utf8'));
    expect(doc.gateways.default.port).toBe(4000);
    expect(doc.mcp.targets.map((t: { name: string }) => t.name).sort()).toEqual(['core', 'text-toolkit']);
    expect(doc.mcp.targets.find((t: { name: string }) => t.name === 'core')).toEqual(renderTarget('core', { hostUrl: HOST, secret: SECRET }).value);
    expect(doc.routes.map((r: { name: string }) => r.name).sort()).toEqual(['landflow-card-core', 'landflow-card-text-toolkit', 'landflow-mcp-core', 'landflow-mcp-text-toolkit']);

    // An operator edits the file: sign-in config, a target and a route of their own, a comment. Landflow's part is rewritten around them.
    doc.mcp.policies = { mcpAuthentication: { issuer: 'http://idp', resourceMetadata: { resource: 'http://gw/mcp' } } };
    doc.routes.push({ name: 'ops-route', matches: [{ path: { exact: '/ops' } }], backends: [{ host: 'ops:80' }] });
    doc.mcp.targets.push({ name: 'ops-target', mcp: { host: 'http://ops/mcp' } });
    const { stringify } = await import('yaml');
    writeFileSync(path, `# operator comment\n${stringify(doc)}`, 'utf8');

    h.set('text-toolkit', { exposed: false });
    const second = await sync.reconcile();
    expect(second.removed.sort()).toEqual(['landflow-card-text-toolkit', 'landflow-mcp-text-toolkit', 'text-toolkit']);
    const text = readFileSync(path, 'utf8');
    expect(text.startsWith('# operator comment')).toBe(true);
    doc = parse(text);
    expect(doc.mcp.policies.mcpAuthentication.issuer).toBe('http://idp');
    expect(doc.mcp.targets.map((t: { name: string }) => t.name)).toEqual(['ops-target', 'core']);
    expect(doc.routes.map((r: { name: string }) => r.name)).toEqual(['ops-route', 'landflow-mcp-core', 'landflow-card-core']);
    const status = await sync.status();
    expect(status.targets.every((t) => t.state === 'unknown')).toBe(true);
    expect(status.health?.ok).toBe(true);
  });
});

describe('token purge', () => {
  it('deletes rows revoked or expired more than 30 days ago, keeps the rest', async () => {
    const user = await createUser({ email: 'gw-purge@landflow.test', name: 'Purge', role: 'member', password: 'purge-password-1' });
    const now = Date.parse('2026-10-26T00:00:00Z');
    const day = 86_400_000;
    const live = await issueMcpToken(user, { label: 'live', expiresInDays: 30 }, now);
    const freshlyRevoked = await issueMcpToken(user, { label: 'revoked recently', expiresInDays: 30 }, now);
    revokeMcpToken(freshlyRevoked.record.id, new Date(now - 2 * day));
    const oldRevoked = await issueMcpToken(user, { label: 'revoked long ago', expiresInDays: 365 }, now);
    revokeMcpToken(oldRevoked.record.id, new Date(now - 31 * day));
    const longExpired = await issueMcpToken(user, { label: 'expired long ago', expiresInDays: 1 }, now - 40 * day);
    const justExpired = await issueMcpToken(user, { label: 'expired yesterday', expiresInDays: 1 }, now - 2 * day);
    expect(purgeMcpTokens({ olderThanDays: 30, now })).toBe(2);
    expect(listMcpTokens(user.id).map((t) => t.label).sort()).toEqual(['expired yesterday', 'live', 'revoked recently']);
    expect(listMcpTokens(user.id).find((t) => t.id === live.record.id)).toBeDefined();
    expect([longExpired.record.id, oldRevoked.record.id].some((id) => listMcpTokens(user.id).some((t) => t.id === id))).toBe(false);
    expect(justExpired.record.id).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// The real agentgateway (LANDFLOW_TEST_MCP_GATEWAY_ADMIN=http://127.0.0.1:55000)
// ---------------------------------------------------------------------------

const ADMIN = process.env.LANDFLOW_TEST_MCP_GATEWAY_ADMIN;

describe.skipIf(!ADMIN)('AgentgatewayAdapter against a running agentgateway', () => {
  const adapter = new AgentgatewayAdapter({ adminUrl: ADMIN });
  const names = ['tmp-t3a-one', 'tmp-t3a-two'];
  const routeNames = ['landflow-mcp-tmp-t3a-one', 'landflow-card-tmp-t3a-one'];
  const clean = async () => {
    for (const n of names) await adapter.remove(n).catch(() => {});
    for (const n of routeNames) await adapter.removeRoute(n).catch(() => {});
  };
  beforeAll(clean);
  afterAll(clean);

  it('upserts, lists, updates and deletes targets and routes with tmp- names', async () => {
    expect((await adapter.health()).ok).toBe(true);
    const one = renderTarget('tmp-t3a-one', { hostUrl: 'http://host.docker.internal:3000', secret: SECRET });
    const two = renderTarget('tmp-t3a-two', { hostUrl: 'http://host.docker.internal:3000', secret: SECRET });
    await adapter.upsert(one);
    await adapter.upsert(two);
    const listed = await adapter.list();
    expect(listed.find((t) => t.name === one.name)).toEqual(one.value);
    expect(listed.find((t) => t.name === two.name)).toEqual(two.value);
    const changed = renderTarget('tmp-t3a-one', { hostUrl: 'http://host.docker.internal:3001', secret: SECRET });
    await adapter.upsert(changed);
    expect((await adapter.list()).find((t) => t.name === one.name)?.mcp.host).toBe('http://host.docker.internal:3001/api/mcp/plugins/tmp-t3a-one');
    for (const route of renderRoutes('tmp-t3a-one', { hostUrl: 'http://host.docker.internal:3000', secret: SECRET })) await adapter.upsertRoute(route);
    const routes = await adapter.listRoutes();
    for (const name of routeNames) expect(routes.find((r) => r.name === name)).toBeDefined();
    await adapter.remove(two.name);
    await adapter.remove(two.name); // a repeat is fine (404 → already gone)
    expect((await adapter.list()).some((t) => t.name === two.name)).toBe(false);
    for (const name of routeNames) await adapter.removeRoute(name);
    expect((await adapter.listRoutes()).some((r) => routeNames.includes(r.name))).toBe(false);
  });
});
