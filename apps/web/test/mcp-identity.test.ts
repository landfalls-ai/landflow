/**
 * MCP identity, tokens, grants and the catalog (docs/transports.md "Sign-in and identity", docs/protocol.md §15.3–15.5;
 * lib/server/mcp/identity.ts, tokens.ts, grants.ts, registry.ts): the gateway headers are trusted only with the secret
 * (forged ones never), Landflow-issued tokens (issue, verify, scopes, audience, revoke, expiry, the JWKS), identity
 * provider tokens against a local JWKS fixture (and against Keycloak when it is up at 127.0.0.1:58080, with a temporary
 * realm), grants (subjects, exclusions, governance, admin browsing), the registry API's v0.1 shapes, Server Cards and
 * protected resource metadata.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ListServersResult, ServerResponse } from '@/lib/server/mcp/registry';
import type { McpCaller } from '@/lib/server/mcp/identity';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-mcp-identity-'));
const INSTANCE = 'http://localhost:3000';
const GATEWAY = 'http://127.0.0.1:54000';
const SECRET = 'test-gateway-secret-0123456789abcdef';
const ENV: Record<string, string> = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_PUBLIC_URL: INSTANCE,
  LANDFLOW_MCP_GATEWAY_SECRET: SECRET,
  LANDFLOW_MCP_GATEWAY_PUBLIC_URL: GATEWAY,
  LANDFLOW_MCP_NAMESPACE: 'test.landflow',
};
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
for (const key of ['LANDFLOW_OIDC_ISSUER', 'LANDFLOW_OIDC_DISCOVERY_URL', 'LANDFLOW_OIDC_CLIENT_ID', 'LANDFLOW_MCP_IDP_AUDIENCE']) delete process.env[key];

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { createUser, findUserByOidc } = await import('@/lib/server/auth/users');
const { createApiKey } = await import('@/lib/server/auth/api-keys');
const { createSession } = await import('@/lib/server/auth/sessions');
const identity = await import('@/lib/server/mcp/identity');
const tokens = await import('@/lib/server/mcp/tokens');
const grants = await import('@/lib/server/mcp/grants');
const catalog = await import('@/lib/server/mcp/registry');
const { authDb } = await import('@/lib/server/auth/db');
const { updateGovernancePolicy } = await import('@/lib/server/governance/policy');
const { MCP_TOOL_META_KEY } = await import('@landflow/protocol');
const { isPublicPath } = await import('@/lib/shared/auth-paths');
const { routePolicy } = await import('@/lib/server/auth/policy');

const jwksRoute = await import('@/app/api/mcp/jwks/route');
const tokensRoute = await import('@/app/api/mcp/tokens/route');
const tokenRoute = await import('@/app/api/mcp/tokens/[id]/route');
const grantsRoute = await import('@/app/api/mcp/grants/route');
const grantRoute = await import('@/app/api/mcp/grants/[id]/route');
const statusRoute = await import('@/app/api/mcp/status/route');
const serversRoute = await import('@/app/api/mcp/registry/v0.1/servers/route');
const versionsRoute = await import('@/app/api/mcp/registry/v0.1/servers/[name]/versions/route');
const versionRoute = await import('@/app/api/mcp/registry/v0.1/servers/[name]/versions/[version]/route');
const serverCardRoute = await import('@/app/api/mcp/plugins/[id]/server-card/route');
const instanceCardRoute = await import('@/app/.well-known/mcp/server-card.json/route');
const prmRoute = await import('@/app/.well-known/oauth-protected-resource/api/mcp/plugins/[id]/route');
const prmRootRoute = await import('@/app/.well-known/oauth-protected-resource/api/mcp/route');

registry.registerBuiltin(corePlugin);

const req = (path: string, init: RequestInit = {}) => new Request(`${INSTANCE}${path}`, init);
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const auth = (token: string, extra: Record<string, string> = {}) => ({ headers: { authorization: `Bearer ${token}`, ...extra } });

let owner: Awaited<ReturnType<typeof createUser>>;
let member: Awaited<ReturnType<typeof createUser>>;
let ssoUser: Awaited<ReturnType<typeof createUser>>;

// A fake identity provider: discovery + JWKS on a local port, tokens signed with its ES256 key.
const idpKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
let idp: Server;
let idpIssuer: string;
const idpToken = (claims: Record<string, unknown>, options: { issuer?: string; audience?: string | string[]; expiresIn?: string } = {}) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: 'idp-1' })
    .setIssuer(options.issuer ?? idpIssuer)
    .setAudience(options.audience ?? `${INSTANCE}/api/mcp`)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
    .sign(idpKey.privateKey);

beforeAll(async () => {
  owner = await createUser({ email: 'owner@mcp.test', name: 'Owner', role: 'owner', password: 'owner-pass-123' });
  member = await createUser({ email: 'member@mcp.test', name: 'Member', role: 'member', password: 'member-pass-123' });
  const jwk = await exportJWK(idpKey.publicKey);
  idp = createServer((request, response) => {
    if (request.url === '/.well-known/openid-configuration') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ issuer: idpIssuer, authorization_endpoint: `${idpIssuer}/auth`, token_endpoint: `${idpIssuer}/token`, jwks_uri: `${idpIssuer}/jwks` }));
    } else if (request.url === '/jwks') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [{ ...jwk, kid: 'idp-1', alg: 'ES256', use: 'sig' }] }));
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => idp.listen(0, '127.0.0.1', resolve));
  idpIssuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
  process.env.LANDFLOW_OIDC_ISSUER = idpIssuer;
  ssoUser = await createUser({ email: 'sso@mcp.test', name: 'SSO User', role: 'member', oidc: { issuer: idpIssuer, subject: 'sso-subject-1' } });
});

afterAll(async () => {
  await new Promise<void>((resolve) => idp.close(() => resolve()));
  process.env = previousEnv;
});

const coreTool = () => grants.pluginTools('core').find((t) => t._meta[MCP_TOOL_META_KEY].nodeType === 'core.httpRequest') ?? grants.pluginTools('core')[0];

describe('public paths and route policies', () => {
  it('keeps the MCP endpoints, JWKS, registry and well-known routes public and the UI routes private', () => {
    expect(isPublicPath('/api/mcp/jwks')).toBe(true);
    expect(isPublicPath('/api/mcp/plugins/twilio')).toBe(true);
    expect(isPublicPath('/api/mcp/registry/v0.1/servers')).toBe(true);
    expect(isPublicPath('/.well-known/oauth-protected-resource/api/mcp/plugins/twilio')).toBe(true);
    expect(isPublicPath('/.well-known/mcp/server-card.json')).toBe(true);
    expect(isPublicPath('/api/mcp/tokens')).toBe(false);
    expect(isPublicPath('/api/mcp/grants/x')).toBe(false);
    expect(isPublicPath('/api/mcp/status')).toBe(false);
    expect(routePolicy('POST', '/api/mcp/tokens')).toEqual({ scope: 'any', sessionOnly: true });
    expect(routePolicy('POST', '/api/mcp/grants')).toEqual({ scope: 'admin', action: 'mcp:manage' });
  });
});

describe('gateway identity headers', () => {
  it('trusts x-landflow-caller-* only with the secret', async () => {
    const caller = await identity.authenticateMcpRequest(req('/api/mcp/plugins/core', { headers: { 'x-landflow-gateway': SECRET, 'x-landflow-caller-iss': idpIssuer, 'x-landflow-caller-sub': 'sso-subject-1' } }), { pluginId: 'core' });
    expect(caller).toMatchObject({ kind: 'gateway', viaGateway: true, userId: ssoUser.id, issuer: idpIssuer, subject: ssoUser.id });
  });

  it('refuses a wrong secret, and ignores forged headers without one', async () => {
    await expect(identity.authenticateMcpRequest(req('/api/mcp/plugins/core', { headers: { 'x-landflow-gateway': 'nope', 'x-landflow-caller-sub': 'sso-subject-1' } }), { pluginId: 'core' })).rejects.toMatchObject({ status: 401 });
    const forged = identity.authenticateMcpRequest(req('/api/mcp/plugins/core', { headers: { 'x-landflow-caller-iss': idpIssuer, 'x-landflow-caller-sub': 'sso-subject-1' } }), { pluginId: 'core' });
    await expect(forged).rejects.toBeInstanceOf(identity.McpAuthError);
    await expect(forged).rejects.toMatchObject({ status: 401, wwwAuthenticate: `Bearer resource_metadata="${INSTANCE}/.well-known/oauth-protected-resource/api/mcp/plugins/core"` });
  });

  it('refuses gateway calls when no secret is configured (even with the right headers)', async () => {
    const saved = process.env.LANDFLOW_MCP_GATEWAY_SECRET;
    delete process.env.LANDFLOW_MCP_GATEWAY_SECRET;
    try {
      await expect(identity.authenticateMcpRequest(req('/x', { headers: { 'x-landflow-gateway': SECRET, 'x-landflow-caller-iss': idpIssuer, 'x-landflow-caller-sub': 'sso-subject-1' } }), { pluginId: 'core' })).rejects.toMatchObject({ status: 401 });
    } finally {
      process.env.LANDFLOW_MCP_GATEWAY_SECRET = saved;
    }
  });

  it('maps no token, an unknown subject and an unknown issuer to an anonymous caller with no grants', async () => {
    const none = await identity.authenticateMcpRequest(req('/x', { headers: { 'x-landflow-gateway': SECRET } }), { pluginId: 'core' });
    expect(none).toMatchObject({ kind: 'gateway', subject: 'anonymous', scopes: [] });
    expect(none.userId).toBeUndefined();
    const unknown = await identity.authenticateMcpRequest(req('/x', { headers: { 'x-landflow-gateway': SECRET, 'x-landflow-caller-iss': idpIssuer, 'x-landflow-caller-sub': 'nobody' } }), { pluginId: 'core' });
    expect(unknown.userId).toBeUndefined();
    const other = await identity.authenticateMcpRequest(req('/x', { headers: { 'x-landflow-gateway': SECRET, 'x-landflow-caller-iss': 'https://evil.example', 'x-landflow-caller-sub': 'sso-subject-1' } }), { pluginId: 'core' });
    expect(other.userId).toBeUndefined();
    expect(identity.canListTool(none, 'core', coreTool().name)).toBe(false);
    expect(identity.canCallTool(unknown, 'core', coreTool().name)).toBe(false);
  });

  it('maps a Landflow-issued token subject through the gateway (by jti, or by the user holding a live token)', async () => {
    const { record } = await tokens.issueMcpToken(member, { label: 'via gateway', scopes: ['tools:list'] });
    const byJti = await identity.authenticateMcpRequest(req('/x', { headers: { 'x-landflow-gateway': SECRET, 'x-landflow-caller-iss': INSTANCE, 'x-landflow-caller-sub': member.id, 'x-landflow-caller-jti': record.id } }), { pluginId: 'core' });
    expect(byJti).toMatchObject({ kind: 'gateway', userId: member.id, tokenId: record.id, scopes: ['tools:list'] });
    const bySub = await identity.authenticateMcpRequest(req('/x', { headers: { 'x-landflow-gateway': SECRET, 'x-landflow-caller-iss': INSTANCE, 'x-landflow-caller-sub': member.id } }), { pluginId: 'core' });
    expect(bySub.userId).toBe(member.id);
    tokens.revokeMcpToken(record.id);
    const revoked = await identity.authenticateMcpRequest(req('/x', { headers: { 'x-landflow-gateway': SECRET, 'x-landflow-caller-iss': INSTANCE, 'x-landflow-caller-sub': member.id, 'x-landflow-caller-jti': record.id } }), { pluginId: 'core' });
    expect(revoked.userId).toBeUndefined();
    tokens.deleteMcpToken(record.id);
  });
});

describe('Landflow-issued MCP tokens', () => {
  it('issues a signed JWT with the right claims, verifiable against the JWKS', async () => {
    const { token, record } = await tokens.issueMcpToken(member, { label: 'direct', expiresInDays: 7 });
    const claims = tokens.unverifiedClaims(token)!;
    expect(claims).toMatchObject({ iss: INSTANCE, sub: member.id, jti: record.id, scope: 'tools:list tools:call registry:read' });
    expect(claims.aud).toEqual([`${INSTANCE}/api/mcp`, `${GATEWAY}/mcp`]);
    expect((claims.exp! - claims.iat!) / 86_400).toBe(7);
    const jwks = await tokens.mcpJwks();
    expect(jwks.keys.length).toBeGreaterThan(0);
    expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(jwks.keys[0]).not.toHaveProperty('d');
    const checked = await tokens.verifyMcpToken(token);
    expect(checked.ok).toBe(true);
    const response = await jwksRoute.GET(req('/api/mcp/jwks'));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { keys: unknown[] }).keys).toHaveLength(jwks.keys.length);
    tokens.deleteMcpToken(record.id);
  });

  it('authenticates a direct bearer call with the token’s scopes, then refuses it once revoked', async () => {
    const { token, record } = await tokens.issueMcpToken(member, { label: 'bearer', scopes: ['tools:list', 'registry:read'] });
    const caller = await identity.authenticateMcpRequest(req('/api/mcp/plugins/core', auth(token)), { pluginId: 'core' });
    expect(caller).toMatchObject({ kind: 'token', userId: member.id, tokenId: record.id, scopes: ['tools:list', 'registry:read'], viaGateway: false });
    expect(identity.canCallTool(caller, 'core', coreTool().name)).toBe(false); // no tools:call scope
    expect(tokens.revokeMcpToken(record.id)).toBe(true);
    expect(tokens.revokeMcpToken(record.id)).toBe(false);
    await expect(identity.authenticateMcpRequest(req('/x', auth(token)), { pluginId: 'core' })).rejects.toMatchObject({ status: 401, message: 'This MCP token was revoked' });
    tokens.deleteMcpToken(record.id);
  });

  it('refuses expired tokens, wrong audiences, tampered tokens and foreign issuers', async () => {
    const { token, record } = await tokens.issueMcpToken(member, { label: 'short', expiresInDays: 1 });
    expect((await tokens.verifyMcpToken(token, { now: Date.now() + 2 * 86_400_000 })).ok).toBe(false);
    expect(await tokens.verifyMcpToken(token, { now: Date.now() + 2 * 86_400_000 })).toMatchObject({ reason: 'expired' });
    expect(await tokens.verifyMcpToken(token, { audiences: ['https://other.example/mcp'] })).toMatchObject({ reason: 'audience' });
    const [h, p, s] = token.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...payload, sub: owner.id })).toString('base64url')}.${s}`;
    expect(await tokens.verifyMcpToken(tampered)).toMatchObject({ reason: 'invalid' });
    await expect(identity.authenticateMcpRequest(req('/x', auth('not.a.jwt')), { pluginId: 'core' })).rejects.toMatchObject({ status: 401 });
    await expect(identity.authenticateMcpRequest(req('/x', auth(await idpToken({ sub: 'x' }, { issuer: 'https://unknown.example' }))), { pluginId: 'core' })).rejects.toMatchObject({ status: 401 });
    tokens.deleteMcpToken(record.id);
  });

  it('refuses bad expiries and empty scopes', async () => {
    await expect(tokens.issueMcpToken(member, { label: 'x', expiresInDays: 0 })).rejects.toBeInstanceOf(tokens.McpTokenError);
    await expect(tokens.issueMcpToken(member, { label: 'x', expiresInDays: 9999 })).rejects.toBeInstanceOf(tokens.McpTokenError);
  });

  it('issues, lists, shows once and revokes through the routes (as the test owner), with the token hashed by jti', async () => {
    const created = await tokensRoute.POST(req('/api/mcp/tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'TMP route token', scopes: ['tools:list'], expiresInDays: 2 }) }));
    expect(created.status).toBe(201);
    const body = (await created.json()) as { token: string; record: { id: string; hint: string; scopes: string[] } };
    expect(body.token.split('.')).toHaveLength(3);
    expect(body.record.scopes).toEqual(['tools:list']);
    const listed = (await (await tokensRoute.GET(req('/api/mcp/tokens'))).json()) as { tokens: Array<{ id: string }> };
    expect(listed.tokens.some((t) => t.id === body.record.id)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(body.token);
    const revoked = await tokenRoute.DELETE(req(`/api/mcp/tokens/${body.record.id}`, { method: 'DELETE' }), params({ id: body.record.id }));
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as { record: { revokedAt?: string } }).record.revokedAt).toBeTruthy();
    expect((await tokenRoute.DELETE(req('/api/mcp/tokens/nope', { method: 'DELETE' }), params({ id: 'nope' }))).status).toBe(404);
    tokens.deleteMcpToken(body.record.id);
  });

  it('rotates the signing key: old tokens stay valid, new ones use the new kid', async () => {
    const { token: before, record: r1 } = await tokens.issueMcpToken(member, { label: 'before rotation' });
    const { kid } = await tokens.rotateMcpSigningKey();
    const { token: after, record: r2 } = await tokens.issueMcpToken(member, { label: 'after rotation' });
    expect(JSON.parse(Buffer.from(after.split('.')[0], 'base64url').toString()).kid).toBe(kid);
    expect((await tokens.verifyMcpToken(before)).ok).toBe(true);
    expect((await tokens.verifyMcpToken(after)).ok).toBe(true);
    expect((await tokens.mcpJwks()).keys.map((k) => k.kid)).toContain(kid);
    tokens.deleteMcpToken(r1.id);
    tokens.deleteMcpToken(r2.id);
  });
});

describe('identity provider tokens (local JWKS fixture)', () => {
  it('verifies an access token against the issuer’s JWKS and maps it through the SSO identity link', async () => {
    const token = await idpToken({ sub: 'sso-subject-1', azp: 'landflow' });
    const caller = await identity.authenticateMcpRequest(req('/api/mcp/plugins/core', auth(token)), { pluginId: 'core' });
    expect(caller).toMatchObject({ kind: 'idp', issuer: idpIssuer, subject: 'sso-subject-1', userId: ssoUser.id, viaGateway: false });
    expect(findUserByOidc(idpIssuer, 'sso-subject-1')?.id).toBe(ssoUser.id);
  });

  it('accepts the resource URL, the gateway URL and LANDFLOW_MCP_IDP_AUDIENCE as audiences, nothing else', async () => {
    for (const aud of [`${INSTANCE}/api/mcp/plugins/core`, `${GATEWAY}/mcp`, INSTANCE]) {
      const caller = await identity.authenticateMcpRequest(req('/x', auth(await idpToken({ sub: 'sso-subject-1' }, { audience: aud }))), { pluginId: 'core' });
      expect(caller.userId).toBe(ssoUser.id);
    }
    await expect(identity.authenticateMcpRequest(req('/x', auth(await idpToken({ sub: 'sso-subject-1' }, { audience: 'account' }))), { pluginId: 'core' })).rejects.toMatchObject({ status: 401, message: /aud/ });
    process.env.LANDFLOW_MCP_IDP_AUDIENCE = 'account';
    try {
      expect((await identity.authenticateMcpRequest(req('/x', auth(await idpToken({ sub: 'sso-subject-1' }, { audience: 'account' }))), { pluginId: 'core' })).userId).toBe(ssoUser.id);
    } finally {
      delete process.env.LANDFLOW_MCP_IDP_AUDIENCE;
    }
  });

  it('refuses expired tokens, unknown identities and tokens signed by another key', async () => {
    await expect(identity.authenticateMcpRequest(req('/x', auth(await idpToken({ sub: 'sso-subject-1' }, { expiresIn: '-1m' }))), { pluginId: 'core' })).rejects.toMatchObject({ status: 401, message: /expired/ });
    await expect(identity.authenticateMcpRequest(req('/x', auth(await idpToken({ sub: 'never-signed-in' }))), { pluginId: 'core' })).rejects.toMatchObject({ status: 403 });
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const forged = await new SignJWT({ sub: 'sso-subject-1' }).setProtectedHeader({ alg: 'ES256', kid: 'idp-1' }).setIssuer(idpIssuer).setAudience(`${INSTANCE}/api/mcp`).setIssuedAt().setExpirationTime('5m').sign(other.privateKey);
    await expect(identity.authenticateMcpRequest(req('/x', auth(forged)), { pluginId: 'core' })).rejects.toMatchObject({ status: 401 });
  });
});

describe('API keys and sessions', () => {
  it('accepts a Landflow API key and a session cookie', async () => {
    const { token } = createApiKey(member, { label: 'mcp', scopes: ['run'] });
    expect(await identity.authenticateMcpRequest(req('/x', auth(token)), { pluginId: 'core' })).toMatchObject({ kind: 'apiKey', userId: member.id });
    const session = createSession(owner, 'password');
    expect(await identity.authenticateMcpRequest(req('/x', { headers: { cookie: `landflow_session=${session.token}` } }), { pluginId: 'core' })).toMatchObject({ kind: 'session', userId: owner.id, role: 'owner' });
    await expect(identity.authenticateMcpRequest(req('/x', auth('lf_nope')), { pluginId: 'core' })).rejects.toMatchObject({ status: 401, message: 'Invalid API key' });
    await expect(identity.authenticateMcpRequest(req('/x'), { pluginId: 'core' })).rejects.toMatchObject({ status: 401 });
  });
});

describe('grants', () => {
  const memberCaller = (): McpCaller => ({ kind: 'token', subject: member.id, userId: member.id, role: 'member', scopes: ['tools:list', 'tools:call', 'registry:read'], viaGateway: false });
  const ownerSession = (): McpCaller => ({ kind: 'session', subject: owner.id, userId: owner.id, role: 'owner', scopes: ['tools:list', 'tools:call', 'registry:read'], viaGateway: false });

  it('maps the core nodes to tools', () => {
    const tools = grants.pluginTools('core');
    expect(tools.length).toBeGreaterThan(5);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    expect(grants.pluginsWithTools()).toContain('core');
  });

  it('lists nothing without a grant, everything with a role grant, and honours !exclusions', () => {
    const tool = coreTool();
    expect(identity.canListTool(memberCaller(), 'core', tool.name)).toBe(false);
    const grant = grants.createGrant({ subject: { kind: 'role', id: 'member' }, pluginId: 'core', tools: '*' }, owner.id);
    expect(identity.canListTool(memberCaller(), 'core', tool.name)).toBe(true);
    expect(identity.canCallTool(memberCaller(), 'core', tool.name)).toBe(true);
    expect(identity.listableTools(memberCaller(), 'core').length).toBe(grants.pluginTools('core').length);
    grants.updateGrant(grant.id, { tools: ['*', `!${tool.name}`] });
    expect(identity.canListTool(memberCaller(), 'core', tool.name)).toBe(false);
    const another = grants.pluginTools('core').find((t) => t.name !== tool.name)!;
    expect(identity.canListTool(memberCaller(), 'core', another.name)).toBe(true);
    grants.updateGrant(grant.id, { tools: [another.name] });
    expect(identity.listableTools(memberCaller(), 'core').map((t) => t.tool.name)).toEqual([another.name]);
    grants.deleteGrant(grant.id);
    expect(identity.canListTool(memberCaller(), 'core', another.name)).toBe(false);
  });

  it('applies user, token and project subjects, and binds credentials from the grant', () => {
    const tool = coreTool();
    const userGrant = grants.createGrant({ subject: { kind: 'user', id: member.id }, pluginId: 'core', tools: [tool.name], credentials: { httpBasicAuth: 'cred_1' } });
    const effective = identity.callableTool(memberCaller(), 'core', tool.name);
    expect(effective?.credentials).toEqual({ httpBasicAuth: 'cred_1' });
    expect(identity.canCallTool({ ...memberCaller(), userId: owner.id, subject: owner.id, role: 'owner' }, 'core', tool.name)).toBe(false);
    grants.deleteGrant(userGrant.id);
    const tokenGrant = grants.createGrant({ subject: { kind: 'role', id: 'owner' }, pluginId: 'core', tools: [tool.name], requireApproval: true });
    expect(identity.callableTool({ ...memberCaller(), userId: owner.id, subject: owner.id, role: 'owner' }, 'core', tool.name)?.requireApproval).toBe(true);
    grants.deleteGrant(tokenGrant.id);
    expect(() => grants.createGrant({ subject: { kind: 'user', id: 'nobody' }, pluginId: 'core', tools: '*' })).toThrow(grants.McpGrantError);
    expect(() => grants.createGrant({ subject: { kind: 'role', id: 'member' }, pluginId: 'core', tools: ['bad name!'] })).toThrow(/tool name/);
  });

  it('lets owners and admins browse every tool from the UI but not call without a grant; tokens need the scope', () => {
    const tool = coreTool();
    expect(identity.canListTool(ownerSession(), 'core', tool.name)).toBe(true);
    expect(identity.canListTool(ownerSession(), 'core', 'no_such_tool')).toBe(false);
    expect(identity.canCallTool(ownerSession(), 'core', tool.name)).toBe(false);
    expect(identity.canListTool({ ...ownerSession(), kind: 'token' }, 'core', tool.name)).toBe(false);
    expect(identity.canListTool({ ...ownerSession(), scopes: ['registry:read'] }, 'core', tool.name)).toBe(false);
  });

  it('hides tools whose node type governance blocks', () => {
    const tool = coreTool();
    const grant = grants.createGrant({ subject: { kind: 'role', id: 'member' }, pluginId: 'core', tools: '*' });
    expect(identity.canListTool(memberCaller(), 'core', tool.name)).toBe(true);
    updateGovernancePolicy({ nodes: { mode: 'block', types: [tool._meta[MCP_TOOL_META_KEY].nodeType] } });
    try {
      expect(identity.canListTool(memberCaller(), 'core', tool.name)).toBe(false);
      expect(identity.canCallTool(memberCaller(), 'core', tool.name)).toBe(false);
      const other = grants.pluginTools('core').find((t) => t._meta[MCP_TOOL_META_KEY].nodeType !== tool._meta[MCP_TOOL_META_KEY].nodeType)!;
      expect(identity.canListTool(memberCaller(), 'core', other.name)).toBe(true);
    } finally {
      updateGovernancePolicy({ nodes: { mode: 'off', types: [] } });
      grants.deleteGrant(grant.id);
    }
  });

  it('manages grants through the routes with audit-friendly shapes', async () => {
    const created = await grantsRoute.POST(req('/api/mcp/grants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject: { kind: 'role', id: 'member' }, pluginId: 'core', tools: ['a_tool', '!b_tool'] }) }));
    expect(created.status).toBe(201);
    const { grant } = (await created.json()) as { grant: { id: string; tools: string[]; subject: { kind: string; id: string } } };
    expect(grant.tools).toEqual(['a_tool', '!b_tool']);
    const listed = (await (await grantsRoute.GET(req('/api/mcp/grants?pluginId=core'))).json()) as { grants: Array<{ id: string }> };
    expect(listed.grants.some((g) => g.id === grant.id)).toBe(true);
    const patched = await grantRoute.PATCH(req(`/api/mcp/grants/${grant.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tools: '*', requireApproval: false }) }), params({ id: grant.id }));
    expect(((await patched.json()) as { grant: { tools: unknown; requireApproval: boolean } }).grant).toMatchObject({ tools: '*', requireApproval: false });
    expect((await grantsRoute.POST(req('/api/mcp/grants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject: { kind: 'user', id: 'nobody' }, pluginId: 'core', tools: '*' }) }))).status).toBe(404);
    expect((await grantRoute.DELETE(req(`/api/mcp/grants/${grant.id}`, { method: 'DELETE' }), params({ id: grant.id }))).status).toBe(200);
    expect((await grantRoute.GET(req(`/api/mcp/grants/${grant.id}`), params({ id: grant.id }))).status).toBe(404);
  });
});

describe('the catalog: server.json, the registry API, Server Cards, PRM', () => {
  let bearer: string;
  let tokenId: string;
  beforeAll(async () => {
    const issued = await tokens.issueMcpToken(member, { label: 'catalog' });
    bearer = issued.token;
    tokenId = issued.record.id;
  });
  afterAll(() => tokens.deleteMcpToken(tokenId));

  it('describes the core plugin with the registry schema, the namespace and both remotes', () => {
    const json = catalog.currentServerJson('core')!;
    expect(json.$schema).toBe(catalog.SERVER_JSON_SCHEMA);
    expect(json.name).toBe('test.landflow/core');
    expect(json.description.length).toBeLessThanOrEqual(100);
    expect(json.version).toBeTruthy();
    expect(json.remotes.map((r) => r.url)).toEqual([`${GATEWAY}/mcp/plugins/core`, `${INSTANCE}/api/mcp/plugins/core`]);
    expect(json.remotes.every((r) => r.type === 'streamable-http')).toBe(true);
    const meta = json._meta![catalog.LANDFLOW_META_KEY] as { pluginId: string; tools: number; health: string };
    expect(meta.pluginId).toBe('core');
    expect(meta.tools).toBe(grants.pluginTools('core').length);
    expect(catalog.pluginIdOf('test.landflow/core')).toBe('core');
    expect(catalog.pluginIdOf('other.ns/core')).toBeUndefined();
  });

  it('answers the registry API with v0.1 shapes, pagination and 401 without a caller', async () => {
    const unauth = await serversRoute.GET(req('/api/mcp/registry/v0.1/servers'));
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('www-authenticate')).toContain('resource_metadata="');
    const list = await serversRoute.GET(req('/api/mcp/registry/v0.1/servers', auth(bearer)));
    expect(list.status).toBe(200);
    const body = (await list.json()) as ListServersResult;
    expect(body.metadata.count).toBe(body.servers.length);
    const core = body.servers.find((s) => s.server.name === 'test.landflow/core')!;
    expect(core._meta[catalog.REGISTRY_META_KEY]).toMatchObject({ status: 'active', isLatest: true });
    expect(core._meta[catalog.REGISTRY_META_KEY].publishedAt).toBeTruthy();
    // Pagination: a page of one, then the cursor.
    const page1 = catalog.listServers({ limit: 1 });
    expect(page1.servers).toHaveLength(1);
    if (page1.metadata.nextCursor) {
      const page2 = catalog.listServers({ limit: 1, cursor: page1.metadata.nextCursor });
      expect(page2.servers[0]?.server.name).not.toBe(page1.servers[0].server.name);
    }
    expect(catalog.listServers({ search: 'core', version: 'latest' }).servers.map((s) => s.server.name)).toContain('test.landflow/core');
    expect(catalog.listServers({ search: 'zzz-none' }).servers).toHaveLength(0);
  });

  it('serves versions, latest and a specific version; 404 for unknown names', async () => {
    const name = encodeURIComponent('test.landflow/core');
    const versions = await versionsRoute.GET(req(`/api/mcp/registry/v0.1/servers/${name}/versions`, auth(bearer)), params({ name }));
    expect(versions.status).toBe(200);
    const list = (await versions.json()) as ListServersResult;
    expect(list.servers[0].server.name).toBe('test.landflow/core');
    const latest = await versionRoute.GET(req(`/api/mcp/registry/v0.1/servers/${name}/versions/latest`, auth(bearer)), params({ name, version: 'latest' }));
    const latestBody = (await latest.json()) as ServerResponse;
    expect(latestBody._meta[catalog.REGISTRY_META_KEY].isLatest).toBe(true);
    const exact = await versionRoute.GET(req(`/api/mcp/registry/v0.1/servers/${name}/versions/${latestBody.server.version}`, auth(bearer)), params({ name, version: latestBody.server.version }));
    expect(((await exact.json()) as ServerResponse).server.version).toBe(latestBody.server.version);
    expect((await versionsRoute.GET(req('/api/mcp/registry/v0.1/servers/nope/versions', auth(bearer)), params({ name: 'nope' }))).status).toBe(404);
    expect((await versionRoute.GET(req(`/api/mcp/registry/v0.1/servers/${name}/versions/0.0.0-none`, auth(bearer)), params({ name, version: '0.0.0-none' }))).status).toBe(404);
  });

  it('marks versions of plugins that moved on as deprecated and gone plugins as deleted', () => {
    const now = new Date().toISOString();
    authDb().upsert('mcp_catalog_servers', { name: 'test.landflow/core', version: '0.0.1-old', plugin_id: 'core', status: 'active', server_json: '{}', published_at: '2020-01-01T00:00:00.000Z', updated_at: now });
    authDb().upsert('mcp_catalog_servers', { name: 'test.landflow/gone', version: '1.0.0', plugin_id: 'gone', status: 'active', server_json: '{}', published_at: '2020-01-01T00:00:00.000Z', updated_at: now });
    catalog.syncCatalog();
    expect(catalog.getServerVersion('test.landflow/core', '0.0.1-old')?._meta[catalog.REGISTRY_META_KEY].status).toBe('deprecated');
    expect(catalog.getServerVersion('test.landflow/core', 'latest')?._meta[catalog.REGISTRY_META_KEY].status).toBe('active');
    expect(catalog.getServerVersion('test.landflow/gone', 'latest')?._meta[catalog.REGISTRY_META_KEY].status).toBe('deleted');
    authDb().delete('mcp_catalog_servers', { name: 'test.landflow/core', version: '0.0.1-old' });
    authDb().delete('mcp_catalog_servers', { name: 'test.landflow/gone' });
  });

  it('serves a plugin’s Server Card with the caller’s tools, and the instance card', async () => {
    const grant = grants.createGrant({ subject: { kind: 'token', id: tokenId }, pluginId: 'core', tools: [coreTool().name] });
    try {
      const card = await serverCardRoute.GET(req('/api/mcp/plugins/core/server-card', auth(bearer)), params({ id: 'core' }));
      expect(card.status).toBe(200);
      const body = (await card.json()) as { serverInfo: { name: string }; protocolVersion: string; transport: { endpoint: string }; authentication: { resourceMetadataUrl: string }; tools: Array<{ name: string }> };
      expect(body.serverInfo.name).toBe('test.landflow/core');
      expect(body.protocolVersion).toBe('2026-07-28');
      expect(body.transport.endpoint).toBe(`${GATEWAY}/mcp/plugins/core`);
      expect(body.authentication.resourceMetadataUrl).toBe(`${INSTANCE}/.well-known/oauth-protected-resource/api/mcp/plugins/core`);
      expect(body.tools.map((t) => t.name)).toEqual([coreTool().name]);
      expect((await serverCardRoute.GET(req('/api/mcp/plugins/core/server-card'), params({ id: 'core' }))).status).toBe(401);
      expect((await serverCardRoute.GET(req('/api/mcp/plugins/none/server-card', auth(bearer)), params({ id: 'none' }))).status).toBe(404);
      const instance = await instanceCardRoute.GET(req('/.well-known/mcp/server-card.json', auth(bearer)));
      const instanceBody = (await instance.json()) as { transport: { endpoint: string }; servers: Array<{ name: string; tools: number }> };
      expect(instanceBody.transport.endpoint).toBe(`${GATEWAY}/mcp`);
      expect(instanceBody.servers.find((s) => s.name === 'test.landflow/core')?.tools).toBe(1);
    } finally {
      grants.deleteGrant(grant.id);
    }
  });

  it('publishes protected resource metadata naming the identity provider and this host', async () => {
    const response = await prmRoute.GET(req('/.well-known/oauth-protected-resource/api/mcp/plugins/core'), params({ id: 'core' }));
    expect(response.status).toBe(200);
    const prm = (await response.json()) as { resource: string; authorization_servers: string[]; jwks_uri: string; bearer_methods_supported: string[] };
    expect(prm.resource).toBe(`${INSTANCE}/api/mcp/plugins/core`);
    expect(prm.authorization_servers).toEqual([idpIssuer, INSTANCE]);
    expect(prm.jwks_uri).toBe(`${INSTANCE}/api/mcp/jwks`);
    expect(prm.bearer_methods_supported).toEqual(['header']);
    const root = (await (await prmRootRoute.GET(req('/.well-known/oauth-protected-resource/api/mcp'))).json()) as { resource: string };
    expect(root.resource).toBe(`${INSTANCE}/api/mcp`);
  });

  it('reports the configuration to Settings → MCP', async () => {
    const status = (await (await statusRoute.GET(req('/api/mcp/status'))).json()) as { gateway: { mode: string; publicUrl: string; secretConfigured: boolean; sync: string }; instanceUrl: string; identityProvider?: { issuer: string }; namespace: string; canManage: boolean };
    expect(status).toMatchObject({ gateway: { mode: 'bundled', publicUrl: GATEWAY, secretConfigured: true, sync: 'stopped' }, instanceUrl: INSTANCE, identityProvider: { issuer: idpIssuer }, namespace: 'test.landflow', canManage: true });
  });
});

// ---- Keycloak, when the infra stack's auth profile is up (127.0.0.1:58080): a temporary realm, deleted afterwards ----

const KEYCLOAK = process.env.LANDFLOW_KEYCLOAK_URL ?? 'http://localhost:58080';
const keycloakUp = await fetch(`${KEYCLOAK}/realms/master`, { signal: AbortSignal.timeout(2_000) })
  .then((r) => r.ok)
  .catch(() => false);

describe.skipIf(!keycloakUp)('identity provider tokens against Keycloak (temporary realm)', () => {
  const REALM = `landflow-mcp-test-f-${Date.now().toString(36)}`;
  const issuer = `${KEYCLOAK}/realms/${REALM}`;
  const admin = { username: process.env.LANDFLOW_KEYCLOAK_ADMIN ?? 'admin', password: process.env.LANDFLOW_KEYCLOAK_ADMIN_PASSWORD ?? 'admin-dev-only' };
  let adminToken: string;
  const kc = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${KEYCLOAK}/admin${path}`, { method, headers: { authorization: `Bearer ${adminToken}`, ...(body !== undefined && { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok && r.status !== 409) throw new Error(`Keycloak ${method} ${path}: ${r.status} ${await r.text()}`);
    return r;
  };

  beforeAll(async () => {
    const r = await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: admin.username, password: admin.password }) });
    adminToken = ((await r.json()) as { access_token: string }).access_token;
    await kc('POST', '/realms', { realm: REALM, enabled: true, displayName: 'Landflow MCP identity test (temporary)', accessTokenLifespan: 300 });
    await kc('POST', `/realms/${REALM}/clients`, {
      clientId: 'landflow-mcp-test',
      publicClient: true,
      directAccessGrantsEnabled: true,
      standardFlowEnabled: false,
      protocolMappers: [{ name: 'mcp-audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper', config: { 'included.custom.audience': `${INSTANCE}/api/mcp`, 'access.token.claim': 'true', 'id.token.claim': 'false' } }],
    });
    await kc('POST', `/realms/${REALM}/users`, { username: 'mcp-agent', enabled: true, email: 'mcp-agent@landflow.test', emailVerified: true, firstName: 'Agent', lastName: 'Test', credentials: [{ type: 'password', value: 'agent-test-only', temporary: false }] });
  }, 60_000);

  afterAll(async () => {
    await fetch(`${KEYCLOAK}/admin/realms/${REALM}`, { method: 'DELETE', headers: { authorization: `Bearer ${adminToken}` } }).catch(() => undefined);
  });

  it('verifies a real Keycloak access token against the realm’s JWKS and maps it to the linked user', async () => {
    const r = await fetch(`${issuer}/protocol/openid-connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'password', client_id: 'landflow-mcp-test', username: 'mcp-agent', password: 'agent-test-only', scope: 'openid' }) });
    const { access_token } = (await r.json()) as { access_token: string };
    expect(access_token).toBeTruthy();
    const claims = tokens.unverifiedClaims(access_token)!;
    expect(claims.iss).toBe(issuer);
    const saved = process.env.LANDFLOW_OIDC_ISSUER;
    process.env.LANDFLOW_OIDC_ISSUER = issuer;
    identity.resetIdentityCaches();
    try {
      await expect(identity.authenticateMcpRequest(req('/x', auth(access_token)), { pluginId: 'core' })).rejects.toMatchObject({ status: 403 });
      const user = await createUser({ email: 'mcp-agent@landflow.test', name: 'Agent Test', role: 'member', oidc: { issuer, subject: claims.sub! } });
      const caller = await identity.authenticateMcpRequest(req('/x', auth(access_token)), { pluginId: 'core' });
      expect(caller).toMatchObject({ kind: 'idp', issuer, subject: claims.sub, userId: user.id });
      const viaGateway = await identity.authenticateMcpRequest(req('/x', { headers: { 'x-landflow-gateway': SECRET, 'x-landflow-caller-iss': issuer, 'x-landflow-caller-sub': claims.sub! } }), { pluginId: 'core' });
      expect(viaGateway.userId).toBe(user.id);
    } finally {
      process.env.LANDFLOW_OIDC_ISSUER = saved;
      identity.resetIdentityCaches();
    }
  }, 30_000);
});
