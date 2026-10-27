/**
 * One gateway route, two issuers (docs/mcp-gateway.md "Two issuers on one route"; lib/server/mcp/gateway-sync.ts
 * `acceptIdentityProvider`, `inlineHostJwks`): with route policies that check Landflow's tokens and an identity provider
 * configured, the sync renders a `jwtAuth` with both providers and the keys inline. With LANDFLOW_TEST_AGENTGATEWAY_IMAGE
 * set (the pinned image in deploy/compose.infra.yml) the rendered policies are validated by the real agentgateway
 * (`--validate-only`, OrbStack's Docker) and the shape of a one-issuer route is checked to be refused by nothing it doesn't know.
 */
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-mcp-two-issuers-'));
const INSTANCE = 'http://localhost:3000';
const GATEWAY = 'http://127.0.0.1:54000';
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_ENCRYPTION_KEY: 'mcp-two-issuers-key', LANDFLOW_PUBLIC_URL: INSTANCE, LANDFLOW_MCP_GATEWAY_PUBLIC_URL: GATEWAY };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

import type { GatewayRoute, GatewayTarget, McpGatewayAdapter } from '@/lib/server/mcp/gateway-sync';

const { McpGatewaySync, MemoryOwnedStore, acceptIdentityProvider, inlineHostJwks } = await import('@/lib/server/mcp/gateway-sync');
const { resetIdentityCaches } = await import('@/lib/server/mcp/identity');
const { issueMcpToken, mcpJwks } = await import('@/lib/server/mcp/tokens');
const { createUser } = await import('@/lib/server/auth/users');

const SECRET = 'test-gateway-secret-0123456789';
const policy = (extra: Record<string, unknown> = {}) => ({ mcpAuthentication: { mode: 'optional', issuer: INSTANCE, audiences: [`${GATEWAY}/mcp`], jwks: { url: `${INSTANCE}/api/mcp/jwks` }, ...extra } });

// A fake identity provider: discovery and a key set on a local port.
let idp: Server;
let issuer = '';
let down = false;
let idpJwk: Record<string, unknown>;
beforeAll(async () => {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  idpJwk = { ...(await exportJWK(publicKey)), kid: 'idp-1', alg: 'ES256', use: 'sig' };
  idp = createServer((req, res) => {
    if (down) return res.writeHead(503).end('down');
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/.well-known/openid-configuration')) return res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/certs` }));
    if (req.url?.endsWith('/certs')) return res.end(JSON.stringify({ keys: [idpJwk] }));
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => idp.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}/realms/landflow`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => idp.close(() => resolve()));
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  for (const key of ['LANDFLOW_OIDC_ISSUER', 'LANDFLOW_MCP_GATEWAY_ACCEPT_IDP', 'LANDFLOW_MCP_IDP_AUDIENCE']) delete process.env[key];
});

describe('acceptIdentityProvider', () => {
  const options = (extra: Record<string, unknown> = {}) => ({ instance: INSTANCE, idp: 'http://idp.test/realms/x', idpJwks: async () => '{"keys":[]}', ...extra });

  it('turns a Landflow-token policy into a jwtAuth of two providers', async () => {
    const out = await acceptIdentityProvider(policy({ jwks: '{"keys":["landflow"]}' }), options({ extraAudiences: ['http://extra'] }));
    expect(out?.mcpAuthentication).toBeUndefined();
    expect(out?.jwtAuth).toEqual({
      mode: 'optional',
      providers: [
        { issuer: INSTANCE, audiences: [`${GATEWAY}/mcp`], jwks: '{"keys":["landflow"]}' },
        { issuer: 'http://idp.test/realms/x', audiences: [`${GATEWAY}/mcp`, 'http://extra'], jwks: '{"keys":[]}' },
      ],
    });
  });

  it('leaves other policies alone', async () => {
    const own = { jwtAuth: { providers: [] }, mcpAuthentication: policy().mcpAuthentication };
    expect(await acceptIdentityProvider(own, options())).toBe(own);
    const other = policy({ issuer: 'http://other.test' });
    expect(await acceptIdentityProvider(other, options())).toBe(other);
    const plain = policy();
    expect(await acceptIdentityProvider(plain, options({ idp: undefined }))).toBe(plain);
    expect(await acceptIdentityProvider(plain, options({ idp: `${INSTANCE}/` }))).toBe(plain);
    expect(await acceptIdentityProvider(plain, options({ idpJwks: async () => undefined }))).toBe(plain);
    expect(await acceptIdentityProvider(undefined, options())).toBeUndefined();
    const noAuth = { cors: {} };
    expect(await acceptIdentityProvider(noAuth, options())).toBe(noAuth);
  });

  it('inlines the host’s keys for a jwtAuth of the operator’s own', async () => {
    const keys = await mcpJwks();
    const out = await inlineHostJwks({ jwtAuth: { mode: 'optional', providers: [{ issuer: INSTANCE, jwks: { url: `${INSTANCE}/api/mcp/jwks` } }, { issuer: 'http://idp', jwks: { url: 'http://idp/certs' } }] } }, mcpJwks);
    const providers = (out?.jwtAuth as { providers: Array<{ jwks: unknown }> }).providers;
    expect(JSON.parse(providers[0].jwks as string)).toEqual(keys);
    expect(providers[1].jwks).toEqual({ url: 'http://idp/certs' });
  });
});

/** A fake adapter that keeps the routes it is given. */
class Routes implements McpGatewayAdapter {
  readonly kind = 'fake';
  readonly location = 'memory';
  readonly routes = new Map<string, GatewayRoute['value']>();
  async health() {
    return { ok: true };
  }
  async list() {
    return [];
  }
  async upsert(_target: GatewayTarget) {}
  async remove() {}
  async listRoutes() {
    return [...this.routes.values()];
  }
  async upsertRoute(route: GatewayRoute) {
    this.routes.set(route.name, structuredClone(route.value));
  }
  async removeRoute(name: string) {
    this.routes.delete(name);
  }
}

describe('the sync with an identity provider', () => {
  const sync = (adapter: Routes, routePolicies: Record<string, unknown> | undefined = policy()) =>
    new McpGatewaySync({ mode: 'bundled', adapter, plugins: () => [{ id: 'text-toolkit', online: true, exposed: true, tools: 2 }], now: () => 1_000_000, hostUrl: () => 'http://127.0.0.1:3000', secret: () => SECRET, store: new MemoryOwnedStore(), routes: true, routePolicies: () => routePolicies, onChanged: () => {}, purge: null });
  const policiesOf = (adapter: Routes) => (adapter.routes.get('landflow-mcp-text-toolkit') as { policies: Record<string, unknown> }).policies;

  it('puts Landflow’s and the provider’s keys, inline, on each route', async () => {
    process.env.LANDFLOW_OIDC_ISSUER = issuer;
    resetIdentityCaches();
    const adapter = new Routes();
    await sync(adapter).reconcile();
    const policies = policiesOf(adapter);
    expect(policies.mcpAuthentication).toBeUndefined();
    const jwt = policies.jwtAuth as { mode: string; providers: Array<{ issuer: string; audiences: string[]; jwks: string }> };
    expect(jwt.mode).toBe('optional');
    expect(jwt.providers.map((p) => p.issuer)).toEqual([INSTANCE, issuer]);
    expect(JSON.parse(jwt.providers[0].jwks).keys[0].kid).toMatch(/^mcp-/);
    expect(JSON.parse(jwt.providers[1].jwks).keys[0].kid).toBe('idp-1');
    expect(jwt.providers.every((p) => p.audiences.includes(`${GATEWAY}/mcp`))).toBe(true);
    // The same render twice is no change (the gateway's echo compares equal), and the status reports no drift.
    expect((await sync(adapter).reconcile()).upserted.filter((name) => name.startsWith('landflow-'))).toEqual([]);
  });

  it('keeps serving with the last keys when the provider is down, and renders one issuer when it never answered', async () => {
    process.env.LANDFLOW_OIDC_ISSUER = issuer;
    resetIdentityCaches();
    const warm = new Routes();
    await sync(warm).reconcile();
    down = true;
    // Past the one-minute cache, the provider is unreachable: the last key set stays.
    const realNow = Date.now;
    Date.now = () => realNow() + 120_000;
    try {
      const again = new Routes();
      await sync(again).reconcile();
      expect((policiesOf(again).jwtAuth as { providers: unknown[] }).providers).toHaveLength(2);
      resetIdentityCaches();
      const cold = new Routes();
      await sync(cold).reconcile();
      expect(policiesOf(cold).mcpAuthentication).toBeDefined();
      expect(policiesOf(cold).jwtAuth).toBeUndefined();
    } finally {
      Date.now = realNow;
      down = false;
    }
  });

  it('keeps the single issuer with LANDFLOW_MCP_GATEWAY_ACCEPT_IDP=off or without a provider', async () => {
    process.env.LANDFLOW_OIDC_ISSUER = issuer;
    process.env.LANDFLOW_MCP_GATEWAY_ACCEPT_IDP = 'off';
    const off = new Routes();
    await sync(off).reconcile();
    expect(policiesOf(off).jwtAuth).toBeUndefined();
    delete process.env.LANDFLOW_MCP_GATEWAY_ACCEPT_IDP;
    delete process.env.LANDFLOW_OIDC_ISSUER;
    const none = new Routes();
    await sync(none).reconcile();
    expect(policiesOf(none).jwtAuth).toBeUndefined();
    // The host's own keys are inline either way (a gateway restarted while the host is down must still start).
    expect(typeof (policiesOf(none).mcpAuthentication as { jwks: unknown }).jwks).toBe('string');
  });

  const image = process.env.LANDFLOW_TEST_AGENTGATEWAY_IMAGE;
  it.skipIf(!image)('is a config the real agentgateway validates, with both issuers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'landflow-agw-'));
    return (async () => {
      process.env.LANDFLOW_OIDC_ISSUER = issuer;
      resetIdentityCaches();
      const adapter = new Routes();
      await sync(adapter).reconcile();
      const route = adapter.routes.get('landflow-mcp-text-toolkit')!;
      writeFileSync(join(dir, 'config.yaml'), JSON.stringify({ gateways: { default: { port: 4000 } }, routes: [route] }));
      const result = spawnSync('docker', ['--context', 'orbstack', 'run', '--rm', '-v', `${dir}:/c:ro`, image!, '--validate-only', '-f', '/c/config.yaml'], { encoding: 'utf8' });
      expect(`${result.stdout}${result.stderr}`).toMatch(/Configuration is valid/);
    })();
  });
});


// ---- The real thing: agentgateway in OrbStack's Docker in front of a fake host, Keycloak's tokens and Landflow's -------------------

const KEYCLOAK = process.env.LANDFLOW_KEYCLOAK_URL ?? 'http://localhost:58080';
const keycloakUp = await fetch(`${KEYCLOAK}/realms/master`, { signal: AbortSignal.timeout(2_000) })
  .then((r) => r.ok)
  .catch(() => false);

describe.skipIf(!process.env.LANDFLOW_TEST_AGENTGATEWAY_IMAGE || !keycloakUp)('agentgateway with Landflow tokens and a Keycloak realm on one route', () => {
  const REALM = `landflow-two-issuers-${Date.now().toString(36)}`;
  const container = `lf-w6-two-issuers-${process.pid}`;
  const admin = { username: process.env.LANDFLOW_KEYCLOAK_ADMIN ?? 'admin', password: process.env.LANDFLOW_KEYCLOAK_ADMIN_PASSWORD ?? 'admin-dev-only' };
  const seen: Array<{ method?: string; iss?: string; sub?: string; authorization?: string }> = [];
  let host: Server;
  let adminToken = '';
  let gatewayPort = 0;
  let configDir = '';
  const realIssuer = `${KEYCLOAK}/realms/${REALM}`;
  const kc = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${KEYCLOAK}/admin${path}`, { method, headers: { authorization: `Bearer ${adminToken}`, ...(body !== undefined && { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok && r.status !== 409) throw new Error(`Keycloak ${method} ${path}: ${r.status} ${await r.text()}`);
  };
  const docker = (...args: string[]) => spawnSync('docker', ['--context', 'orbstack', ...args], { encoding: 'utf8' });
  const call = async (token?: string) => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/mcp/plugins/text-toolkit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token && { authorization: `Bearer ${token}` }) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    return { status: response.status, text: await response.text() };
  };

  beforeAll(async () => {
    // The fake host: answers MCP and remembers the identity the gateway forwarded.
    host = createServer((req: IncomingMessage, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const message = JSON.parse(raw || '{}') as { id?: number; method?: string };
        seen.push({ method: message.method, iss: req.headers['x-landflow-caller-iss'] as string, sub: req.headers['x-landflow-caller-sub'] as string, authorization: req.headers.authorization });
        res.setHeader('content-type', 'application/json');
        if (message.method === 'initialize') return res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-host', version: '1' } } }));
        if (message.method === 'tools/list') return res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] } }));
        res.writeHead(202).end();
      });
    });
    await new Promise<void>((resolve) => host.listen(0, '0.0.0.0', resolve));
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    gatewayPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const r = await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: admin.username, password: admin.password }) });
    adminToken = ((await r.json()) as { access_token: string }).access_token;
    await kc('POST', '/realms', { realm: REALM, enabled: true, displayName: 'Landflow two issuers test (temporary)', accessTokenLifespan: 300 });
    await kc('POST', `/realms/${REALM}/clients`, {
      clientId: 'landflow-two-issuers',
      publicClient: true,
      directAccessGrantsEnabled: true,
      standardFlowEnabled: false,
      protocolMappers: [{ name: 'gateway-audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper', config: { 'included.custom.audience': `http://127.0.0.1:${gatewayPort}/mcp`, 'access.token.claim': 'true', 'id.token.claim': 'false' } }],
    });
    await kc('POST', `/realms/${REALM}/users`, { username: 'agent', enabled: true, email: 'agent@two-issuers.test', emailVerified: true, firstName: 'Agent', lastName: 'Test', credentials: [{ type: 'password', value: 'agent-test-only', temporary: false }] });
  }, 60_000);

  afterAll(async () => {
    docker('rm', '-f', container);
    await new Promise<void>((resolve) => host.close(() => resolve()));
    await fetch(`${KEYCLOAK}/admin/realms/${REALM}`, { method: 'DELETE', headers: { authorization: `Bearer ${adminToken}` } }).catch(() => undefined);
    for (const key of ['LANDFLOW_OIDC_ISSUER', 'LANDFLOW_OIDC_DISCOVERY_URL']) delete process.env[key];
    process.env.LANDFLOW_MCP_GATEWAY_PUBLIC_URL = GATEWAY;
  });

  it('signs in a Landflow token and a Keycloak token, refuses a third issuer, and forwards who they are', async () => {
    process.env.LANDFLOW_MCP_GATEWAY_PUBLIC_URL = `http://127.0.0.1:${gatewayPort}`;
    process.env.LANDFLOW_OIDC_ISSUER = realIssuer;
    resetIdentityCaches();
    // What the sync writes for the route, with the real realm's keys inline and the fake host as the target.
    const adapter = new Routes();
    const targets: GatewayTarget[] = [];
    adapter.upsert = async (target) => void targets.push(target);
    const sync = new McpGatewaySync({
      mode: 'bundled',
      adapter,
      plugins: () => [{ id: 'text-toolkit', online: true, exposed: true, tools: 2 }],
      now: () => 1_000_000,
      hostUrl: () => `http://host.docker.internal:${(host.address() as AddressInfo).port}`,
      secret: () => SECRET,
      store: new MemoryOwnedStore(),
      routes: true,
      routePolicies: () => ({ mcpAuthentication: { mode: 'optional', issuer: INSTANCE, audiences: [`http://127.0.0.1:${gatewayPort}/mcp`], jwks: { url: `${INSTANCE}/api/mcp/jwks` } } }),
      onChanged: () => {},
      purge: null,
    });
    await sync.reconcile();
    const route = adapter.routes.get('landflow-mcp-text-toolkit')!;
    configDir = mkdtempSync(join(tmpdir(), 'landflow-agw-live-'));
    writeFileSync(join(configDir, 'config.yaml'), JSON.stringify({ gateways: { default: { port: 4000 } }, routes: [route] }));
    expect(docker('run', '-d', '--name', container, '-p', `127.0.0.1:${gatewayPort}:4000`, '-v', `${configDir}:/c:ro`, process.env.LANDFLOW_TEST_AGENTGATEWAY_IMAGE!, '-f', '/c/config.yaml').status).toBe(0);
    for (let i = 0; i < 40; i++) {
      if ((await call().catch(() => ({ status: 0 }))).status === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    // A Landflow-issued token.
    const user = await createUser({ email: 'member@two-issuers.test', name: 'Member', role: 'member', password: 'member-pass-123' });
    const landflow = (await issueMcpToken(user, { label: 'live' })).token;
    seen.length = 0;
    const ok1 = await call(landflow);
    expect(ok1.status).toBe(200);
    expect(ok1.text).toContain('ping');
    expect(seen.at(-1)).toMatchObject({ iss: INSTANCE, sub: user.id });
    expect(seen.at(-1)?.authorization).toBeUndefined();

    // A real Keycloak access token.
    const kcResponse = await fetch(`${realIssuer}/protocol/openid-connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'password', client_id: 'landflow-two-issuers', username: 'agent', password: 'agent-test-only', scope: 'openid' }) });
    const keycloak = ((await kcResponse.json()) as { access_token: string }).access_token;
    const ok2 = await call(keycloak);
    expect(ok2.status).toBe(200);
    expect(ok2.text).toContain('ping');
    expect(seen.at(-1)).toMatchObject({ iss: realIssuer });
    expect(seen.at(-1)?.sub).toBeTruthy();

    // No token: anonymous (the route is `optional`), no identity forwarded. A token of another issuer, or a forged one: 401.
    seen.length = 0;
    expect((await call()).status).toBe(200);
    expect(seen.every((entry) => !entry.sub || entry.sub === '')).toBe(true);
    const [header, , signature] = keycloak.split('.');
    const forged = `${header}.${Buffer.from(JSON.stringify({ iss: 'http://elsewhere.test', sub: 'x', aud: `http://127.0.0.1:${gatewayPort}/mcp`, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')}.${signature}`;
    expect((await call(forged)).status).toBe(401);
    expect((await call('not.a.token')).status).toBe(401);
  }, 90_000);
});
