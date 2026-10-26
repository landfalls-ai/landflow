/**
 * Webhook and Form Trigger authentication (lib/server/webhook-auth.ts): none, Basic Auth, Header Auth, JWT Auth
 * (HS256 secret, PEM public key, JWKS URL; issuer and audience) and the IP allow-list, through the real routes. And the
 * project rule for the credential a trigger checks callers with (Webhook, Form, MCP Server Trigger): refused (403, a
 * log line) while the workflow's project can't use it, a warning on save.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, exportSPKI, generateKeyPair, SignJWT } from 'jose';
import type { Workflow } from '@landflow/engine';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-webhook-auth-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://auth.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { publishDraft } = await import('@/lib/server/publish');
const { callerIp, ipMatches, parseIpList, verifyJwt } = await import('@/lib/server/webhook-auth');
const webhookRoute = await import('@/app/api/webhook/[...path]/route');
const formRoute = await import('@/app/form/[...path]/route');
const mcpRoute = await import('@/app/mcp/[...path]/route');
const workflowRoute = await import('@/app/api/workflows/[id]/route');
const projects = await import('@/lib/server/projects');
const { logger } = await import('@/lib/server/telemetry/logger');

registry.registerBuiltin(corePlugin);

const ISSUER = 'https://issuer.auth.test';
let jwksServer: Server;
let jwksUrl: string;
let rsa: Awaited<ReturnType<typeof generateKeyPair>>;

beforeAll(async () => {
  rsa = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(rsa.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  jwksServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  jwksUrl = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/.well-known/jwks.json`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Ref = { id: string; name: string };
const ref = (credential: { id: string; name: string }): Ref => ({ id: credential.id, name: credential.name });

async function hook(path: string, parameters: Record<string, unknown>, creds?: Record<string, Ref>): Promise<void> {
  const workflow: Workflow = {
    id: `wf_auth_${path.replace(/\W/g, '_')}`,
    name: `Auth ${path}`,
    nodes: [
      { id: 'Hook', name: 'Hook', type: 'core.webhook', typeVersion: 1, position: [0, 0], parameters: { path, method: 'POST', respond: 'lastNode', ...parameters }, ...(creds && { credentials: creds }) },
    ],
    connections: [],
  };
  store.saveWorkflow(workflow);
  await publishDraft(workflow.id);
}

const call = (path: string, headers: Record<string, string> = {}) =>
  webhookRoute.POST(
    new Request(`http://auth.test/api/webhook/${path}`, { method: 'POST', body: JSON.stringify({ hello: 'world' }), headers: { 'content-type': 'application/json', ...headers } }),
    { params: Promise.resolve({ path: [path] }) },
  );

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const hs256 = (secret: string, claims: Record<string, unknown> = {}, expires = '5m') =>
  new SignJWT({ sub: 'user-1', ...claims }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(expires).sign(new TextEncoder().encode(secret));

// ---------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------

describe('IP allow-list matching', () => {
  it('matches addresses and CIDR ranges, IPv4 and IPv6', () => {
    expect(ipMatches('203.0.113.7', '203.0.113.7')).toBe(true);
    expect(ipMatches('203.0.113.8', '203.0.113.7')).toBe(false);
    expect(ipMatches('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipMatches('11.1.2.3', '10.0.0.0/8')).toBe(false);
    expect(ipMatches('192.168.1.200', '192.168.1.128/25')).toBe(true);
    expect(ipMatches('192.168.1.100', '192.168.1.128/25')).toBe(false);
    expect(ipMatches('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(ipMatches('2001:db9::1', '2001:db8::/32')).toBe(false);
    expect(ipMatches('::1', '::1')).toBe(true);
    expect(ipMatches('127.0.0.1', 'localhost')).toBe(true);
    expect(ipMatches('10.0.0.1', '2001:db8::/32')).toBe(false);
    expect(ipMatches('10.0.0.1', 'not-an-ip')).toBe(false);
    expect(parseIpList(' 10.0.0.1, 10.0.0.2\n10.0.0.0/24 ')).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.0/24']);
  });

  it('reads the caller from X-Forwarded-For, then X-Real-IP, else 127.0.0.1', () => {
    const request = (headers: Record<string, string>) => new Request('http://auth.test/', { headers });
    expect(callerIp(request({ 'x-forwarded-for': '198.51.100.4, 10.0.0.1', 'x-real-ip': '10.9.9.9' }))).toBe('198.51.100.4');
    expect(callerIp(request({ 'x-real-ip': '10.9.9.9' }))).toBe('10.9.9.9');
    expect(callerIp(request({ 'x-forwarded-for': '::ffff:10.0.0.5' }))).toBe('10.0.0.5');
    expect(callerIp(request({}))).toBe('127.0.0.1');
  });
});

describe('verifyJwt', () => {
  it('checks HS256 secrets, issuer, audience and expiry', async () => {
    await expect(verifyJwt(await hs256('s3cret', { iss: ISSUER, aud: 'landflow' }), { keyType: 'passphrase', secret: 's3cret', issuer: ISSUER, audience: 'landflow' })).resolves.toMatchObject({ sub: 'user-1' });
    await expect(verifyJwt(await hs256('s3cret', { iss: 'https://evil' }), { keyType: 'passphrase', secret: 's3cret', issuer: ISSUER })).rejects.toThrow();
    await expect(verifyJwt(await hs256('s3cret', { aud: 'other' }), { keyType: 'passphrase', secret: 's3cret', audience: 'landflow' })).rejects.toThrow();
    await expect(verifyJwt(await hs256('s3cret', {}, '-1m'), { keyType: 'passphrase', secret: 's3cret' })).rejects.toThrow();
    await expect(verifyJwt(await hs256('other'), { keyType: 'passphrase', secret: 's3cret' })).rejects.toThrow();
    await expect(verifyJwt(await hs256('s3cret'), { keyType: 'passphrase', secret: '' })).rejects.toThrow(/no secret/);
  });

  it('checks RS256 tokens against a PEM public key, refusing algorithm confusion', async () => {
    const token = await new SignJWT({ sub: 'pem' }).setProtectedHeader({ alg: 'RS256' }).setExpirationTime('5m').sign(rsa.privateKey);
    const pem = await exportSPKI(rsa.publicKey);
    await expect(verifyJwt(token, { keyType: 'pemKey', publicKey: pem, algorithm: 'RS256' })).resolves.toMatchObject({ sub: 'pem' });
    // An HS256 token "signed" with the public key text must not pass as RS256.
    await expect(verifyJwt(await hs256(pem), { keyType: 'pemKey', publicKey: pem, algorithm: 'RS256' })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Through the routes
// ---------------------------------------------------------------------------

describe('Webhook trigger authentication', () => {
  it('accepts anyone with authentication none', async () => {
    await hook('auth-none', {});
    expect((await call('auth-none')).status).toBe(200);
  });

  it('checks Basic Auth', async () => {
    const credential = credentials.create({ name: 'Hook login', type: 'core.httpBasicAuth', data: { user: 'ada', password: 'lovelace' } });
    await hook('auth-basic', { authentication: 'basicAuth' }, { httpBasicAuth: ref(credential) });
    const missing = await call('auth-basic');
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toMatch(/^Basic realm="Webhook"/);
    expect((await call('auth-basic', { authorization: basic('ada', 'wrong') })).status).toBe(401);
    expect((await call('auth-basic', { authorization: basic('bob', 'lovelace') })).status).toBe(401);
    const ok = await call('auth-basic', { authorization: basic('ada', 'lovelace') });
    expect(ok.status).toBe(200);
    // The item never carries the Authorization header.
    expect(JSON.stringify(await ok.json())).not.toContain('Basic ');
  });

  it('checks Header Auth and keeps the secret header out of the run', async () => {
    const credential = credentials.create({ name: 'Hook key', type: 'core.httpHeaderAuth', data: { name: 'X-Api-Key', value: 'k-123' } });
    await hook('auth-header', { authentication: 'headerAuth' }, { httpHeaderAuth: ref(credential) });
    expect((await call('auth-header')).status).toBe(403);
    expect((await call('auth-header', { 'x-api-key': 'nope' })).status).toBe(403);
    const ok = await call('auth-header', { 'x-api-key': 'k-123', 'x-other': 'kept' });
    expect(ok.status).toBe(200);
    const item = (await ok.json()) as { headers: Record<string, string> };
    expect(item.headers['x-api-key']).toBeUndefined();
    expect(item.headers['x-other']).toBe('kept');
  });

  it('checks JWTs signed with a shared secret and hands the claims to the run', async () => {
    const credential = credentials.create({ name: 'Hook JWT', type: 'core.jwtAuth', data: { keyType: 'passphrase', secret: 'hs-secret', algorithm: 'HS256', audience: 'landflow' } });
    await hook('auth-jwt', { authentication: 'jwtAuth' }, { jwtAuth: ref(credential) });
    const missing = await call('auth-jwt');
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');
    expect((await call('auth-jwt', { authorization: `Bearer ${await hs256('wrong', { aud: 'landflow' })}` })).status).toBe(401);
    expect((await call('auth-jwt', { authorization: `Bearer ${await hs256('hs-secret', { aud: 'someone-else' })}` })).status).toBe(401);
    const ok = await call('auth-jwt', { authorization: `Bearer ${await hs256('hs-secret', { aud: 'landflow', role: 'admin' })}` });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ jwtPayload: { sub: 'user-1', role: 'admin', aud: 'landflow' }, body: { hello: 'world' } });
  });

  it('checks JWTs against a JWKS URL', async () => {
    const credential = credentials.create({ name: 'Hook JWKS', type: 'core.jwtAuth', data: { keyType: 'jwks', jwksUrl, algorithm: 'RS256', issuer: ISSUER } });
    await hook('auth-jwks', { authentication: 'jwtAuth' }, { jwtAuth: ref(credential) });
    const sign = (issuer: string, kid = 'k1') => new SignJWT({ sub: 'svc' }).setProtectedHeader({ alg: 'RS256', kid }).setIssuer(issuer).setExpirationTime('5m').sign(rsa.privateKey);
    expect((await call('auth-jwks', { authorization: `Bearer ${await sign(ISSUER)}` })).status).toBe(200);
    expect((await call('auth-jwks', { authorization: `Bearer ${await sign('https://other.test')}` })).status).toBe(401);
    const stranger = await generateKeyPair('RS256');
    const forged = await new SignJWT({ sub: 'svc' }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(ISSUER).setExpirationTime('5m').sign(stranger.privateKey);
    expect((await call('auth-jwks', { authorization: `Bearer ${forged}` })).status).toBe(401);
  });

  it('answers 500 when the selected credential is missing', async () => {
    await hook('auth-unset', { authentication: 'basicAuth' });
    const response = await call('auth-unset', { authorization: basic('a', 'b') });
    expect(response.status).toBe(500);
    expect((await response.json()).error).toMatch(/credential is missing/);
  });

  it('limits callers to the IP allow-list', async () => {
    await hook('auth-ip', { options: { ipWhitelist: '203.0.113.7, 10.0.0.0/8' } });
    expect((await call('auth-ip', { 'x-forwarded-for': '203.0.113.7' })).status).toBe(200);
    expect((await call('auth-ip', { 'x-forwarded-for': '10.20.30.40' })).status).toBe(200);
    const refused = await call('auth-ip', { 'x-forwarded-for': '198.51.100.1' });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toBe('IP address not allowed');
    // No proxy header: the host itself (127.0.0.1), not on the list.
    expect((await call('auth-ip')).status).toBe(403);
  });
});

describe('Form Trigger authentication', () => {
  it('asks the browser for Basic Auth before showing or accepting the form', async () => {
    const credential = credentials.create({ name: 'Form login', type: 'core.httpBasicAuth', data: { user: 'grace', password: 'hopper' } });
    const workflow: Workflow = {
      id: 'wf_auth_form',
      name: 'Auth form',
      nodes: [
        {
          id: 'Form',
          name: 'Form',
          type: 'core.formTrigger',
          typeVersion: 1,
          position: [0, 0],
          parameters: { path: 'auth-form', formTitle: 'Private', authentication: 'basicAuth', formFields: { values: [{ fieldLabel: 'Name', fieldType: 'text' }] } },
          credentials: { httpBasicAuth: ref(credential) },
        },
      ],
      connections: [],
    };
    store.saveWorkflow(workflow);
    await publishDraft(workflow.id);
    const params = { params: Promise.resolve({ path: ['auth-form'] }) };
    const page = (headers: Record<string, string> = {}) => formRoute.GET(new Request('http://auth.test/form/auth-form', { headers }), params);
    const denied = await page();
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toMatch(/^Basic realm="Form"/);
    expect(denied.headers.get('content-type')).toMatch(/text\/html/);
    expect((await page({ authorization: basic('grace', 'hopper') })).status).toBe(200);

    const submit = (headers: Record<string, string>) =>
      formRoute.POST(new Request('http://auth.test/form/auth-form', { method: 'POST', body: new URLSearchParams({ f0: 'Ada' }), headers }), params);
    expect((await submit({})).status).toBe(401);
    expect((await submit({ authorization: basic('grace', 'hopper') })).status).toBe(200);
    // The end screen comes straight away; the run is saved as it finishes.
    for (let i = 0; i < 200 && store.listExecutions({ workflowId: workflow.id }).length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.listExecutions({ workflowId: workflow.id })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The trigger's credential and the workflow's project
// ---------------------------------------------------------------------------

describe('trigger credentials outside the workflow’s project', () => {
  const REFUSED = 'trigger call refused: its authentication credential isn’t available to the workflow’s project';
  /** A credential that lives in another project than the workflow's (`team`). */
  const setup = (name: string, type: string, data: Record<string, unknown>) => {
    const team = projects.createTeamProject({ name: `${name} team` });
    const elsewhere = projects.createTeamProject({ name: `${name} elsewhere` });
    const credential = credentials.create({ name, type, data });
    projects.setHomeProject('credential', credential.id, elsewhere.id);
    return { team: team.id, credential };
  };
  const put = (workflow: Workflow) =>
    workflowRoute.PUT(new Request(`http://auth.test/api/workflows/${workflow.id}`, { method: 'PUT', body: JSON.stringify(workflow), headers: { 'content-type': 'application/json' } }), {
      params: Promise.resolve({ id: workflow.id }),
    });

  it('refuses every webhook call with 403 (not naming the credential) and logs it, until the credential is shared; saving warns', async () => {
    const { team, credential } = setup('Team hook login', 'core.httpBasicAuth', { user: 'ada', password: 'lovelace' });
    await hook('auth-project', { authentication: 'basicAuth' }, { httpBasicAuth: ref(credential) });
    const id = 'wf_auth_auth_project';
    projects.setHomeProject('workflow', id, team);
    const warn = vi.spyOn(logger, 'warn');
    try {
      // The right password, or none: the same 403, before any secret is compared (no Basic challenge either).
      for (const headers of [{ authorization: basic('ada', 'lovelace') }, {} as Record<string, string>]) {
        const refused = await call('auth-project', headers);
        expect(refused.status).toBe(403);
        expect(refused.headers.get('www-authenticate')).toBeNull();
        const body = await refused.json();
        expect(body.error).toBe('Forbidden: the Webhook’s authentication credential isn’t available to its workflow’s project');
        expect(JSON.stringify(body)).not.toContain(credential.id);
        expect(JSON.stringify(body)).not.toContain(credential.name);
      }
      expect(store.listExecutions({ workflowId: id })).toHaveLength(0);
      // Whoever runs the host learns which one.
      expect(warn).toHaveBeenCalledWith(REFUSED, expect.objectContaining({ 'landflow.workflow.id': id, 'landflow.node.name': 'Hook', 'landflow.node.type': 'core.webhook', 'landflow.credential.id': credential.id }));
    } finally {
      warn.mockRestore();
    }

    // Saving says so (the editor shows it as a warning); the save itself stands.
    const saved = await put(store.getWorkflow(id)!);
    expect(saved.status).toBe(200);
    expect((await saved.json()).triggerAuthWarnings).toEqual([{ nodeId: 'Hook', nodeName: 'Hook', message: expect.stringContaining('calls will be refused (403)') }]);

    // Shared with the workflow's project: the trigger's own check applies again.
    projects.addShare('credential', credential.id, team, 'user');
    expect((await call('auth-project')).status).toBe(401);
    expect((await call('auth-project', { authorization: basic('ada', 'lovelace') })).status).toBe(200);
    expect((await (await put(store.getWorkflow(id)!)).json()).triggerAuthWarnings).toBeUndefined();
    // A trigger without authentication never asks.
    await hook('auth-project-open', {}, { httpBasicAuth: ref(credential) });
    projects.removeShare('credential', credential.id, team);
    projects.setHomeProject('workflow', 'wf_auth_auth_project_open', team);
    expect((await call('auth-project-open')).status).toBe(200);
  });

  it('refuses a form (HTML 403) and an MCP Server Trigger (JSON-RPC 403) the same way', async () => {
    const form = setup('Team form login', 'core.httpBasicAuth', { user: 'grace', password: 'hopper' });
    const formWorkflow: Workflow = {
      id: 'wf_auth_project_form',
      name: 'Project form',
      nodes: [
        {
          id: 'Form',
          name: 'Form',
          type: 'core.formTrigger',
          typeVersion: 1,
          position: [0, 0],
          parameters: { path: 'auth-project-form', formTitle: 'Team', authentication: 'basicAuth', formFields: { values: [{ fieldLabel: 'Name', fieldType: 'text' }] } },
          credentials: { httpBasicAuth: ref(form.credential) },
        },
      ],
      connections: [],
    };
    store.saveWorkflow(formWorkflow);
    await publishDraft(formWorkflow.id);
    projects.setHomeProject('workflow', formWorkflow.id, form.team);
    const params = { params: Promise.resolve({ path: ['auth-project-form'] }) };
    const page = await formRoute.GET(new Request('http://auth.test/form/auth-project-form', { headers: { authorization: basic('grace', 'hopper') } }), params);
    expect(page.status).toBe(403);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(await page.text()).toContain('You are not allowed to open this form.');
    const submit = await formRoute.POST(
      new Request('http://auth.test/form/auth-project-form', { method: 'POST', body: new URLSearchParams({ f0: 'Ada' }), headers: { authorization: basic('grace', 'hopper') } }),
      params,
    );
    expect(submit.status).toBe(403);
    projects.addShare('credential', form.credential.id, form.team, 'user');
    expect((await formRoute.GET(new Request('http://auth.test/form/auth-project-form', { headers: { authorization: basic('grace', 'hopper') } }), params)).status).toBe(200);

    const mcp = setup('Team MCP token', 'core.httpBearerAuth', { token: 'team-token' });
    const tools: Workflow = {
      id: 'wf_auth_project_mcp',
      name: 'Project tools',
      nodes: [
        { id: 'mcp', name: 'MCP Server', type: 'core.mcpTrigger', typeVersion: 1, position: [0, 0], parameters: { path: 'auth-project-mcp', authentication: 'bearerAuth' }, credentials: { httpBearerAuth: ref(mcp.credential) } },
        { id: 'calc', name: 'Calculator', type: 'core.calculatorTool', typeVersion: 1, position: [0, 200], parameters: {} },
      ],
      connections: [{ id: 'c1', type: 'ai_tool', source: 'calc', target: 'mcp', sourceIndex: 0, targetIndex: 0 }],
    };
    store.saveWorkflow(tools);
    await publishDraft(tools.id);
    projects.setHomeProject('workflow', tools.id, mcp.team);
    const initialize = (authorization: string) =>
      mcpRoute.POST(
        new Request('http://auth.test/mcp/auth-project-mcp', {
          method: 'POST',
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization },
        }),
        { params: Promise.resolve({ path: ['auth-project-mcp'] }) },
      );
    const refused = await initialize('Bearer team-token');
    expect(refused.status).toBe(403);
    const body = await refused.json();
    expect(body).toMatchObject({ jsonrpc: '2.0', error: { code: -32001, message: 'Forbidden: the MCP Server Trigger’s authentication credential isn’t available to its workflow’s project' } });
    expect(JSON.stringify(body)).not.toContain(mcp.credential.id);
    expect((await initialize('Bearer wrong')).status).toBe(403);
    projects.addShare('credential', mcp.credential.id, mcp.team, 'user');
    expect((await initialize('Bearer wrong')).status).toBe(401);
    expect((await initialize('Bearer team-token')).status).toBe(200);
  });
});
