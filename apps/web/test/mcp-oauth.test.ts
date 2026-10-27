/**
 * OAuth for the MCP clients (item: MCP servers that sign users in), against a fake protected MCP server and authorization
 * server (./fake-mcp-oauth): the 401 challenge, protected resource metadata (RFC 9728), authorization server metadata (RFC 8414
 * and OpenID Connect locations), dynamic client registration (RFC 7591) or a preconfigured client, the Connect flow through the
 * routes (PKCE, `resource` on the authorization and token requests, RFC 8707), refresh after expiry and after a 401, the MCP Client
 * node (tools, resources, prompts), the MCP Client Tool under an agent (resources and prompts as tools) and the credential's UI schema.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { Agent, AgentConfig } from '@/lib/shared/agents';
import { startFakeMcpOAuth, type FakeMcpOAuth, type FakeMcpOAuthOptions } from './fake-mcp-oauth';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-mcp-oauth-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://landflow.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { credentials } = await import('@/lib/server/credentials/vault');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { waits } = await import('@/lib/server/waits');
const { closeMcpClients, endpointFrom, listMcpTools, readMcpResource, listMcpResources, listMcpPrompts, getMcpPrompt } = await import('@/lib/server/mcp/client');
const { discoverAuthorizationServer, discoverProtectedResource, metadataUrls, parseChallenge, prepareMcpAuthorization } = await import('@/lib/server/mcp/oauth');
const { buildToolset } = await import('@/lib/server/agents/tools');
const authorizeRoute = await import('@/app/api/credentials/[id]/oauth2/authorize/route');
const callbackRoute = await import('@/app/api/oauth2/callback/route');

registry.registerBuiltin(corePlugin);

const REDIRECT = 'http://landflow.test/api/oauth2/callback';
const servers: FakeMcpOAuth[] = [];
async function start(options: FakeMcpOAuthOptions = {}) {
  const server = await startFakeMcpOAuth(options);
  servers.push(server);
  return server;
}

afterAll(async () => {
  await closeMcpClients();
  for (const server of servers) await server.close();
  waits.stop();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const params = <T>(value: T) => ({ params: Promise.resolve(value) });

function createCredential(server: FakeMcpOAuth, data: Record<string, unknown> = {}) {
  return credentials.create({ name: 'Protected MCP', type: 'core.mcpOAuth2Api', data: { serverUrl: server.url, ...data } as never });
}

/** Connect through the routes the way a browser would: authorize (discovery, registration) -> consent (302) -> callback with the cookie. */
async function connect(id: string) {
  const start = await authorizeRoute.GET(new Request(`http://landflow.test/api/credentials/${id}/oauth2/authorize`), params({ id }));
  if (start.status !== 302) return { start, html: '' as string };
  const authorizeUrl = new URL(start.headers.get('location')!);
  const cookie = start.headers.get('set-cookie')!.split(';')[0];
  const consent = await fetch(authorizeUrl, { redirect: 'manual' });
  const back = new URL(consent.headers.get('location')!);
  const page = await callbackRoute.GET(new Request(back, { headers: { cookie } }));
  return { start, authorizeUrl, html: await page.text() };
}

const tokenOf = (id: string) => credentials.oauth2(id).token!;
const expire = (id: string) => credentials.saveOAuth2Token(id, { ...tokenOf(id), expires_at: new Date(Date.now() - 5_000).toISOString() });

function workflow(id: string, credentialId: string, url: string, parameters: Record<string, unknown>): Workflow {
  return store.saveWorkflow({
    id,
    name: id,
    nodes: [
      { id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      {
        id: 'MCP',
        name: 'MCP',
        type: 'core.mcpClient',
        typeVersion: 1,
        position: [200, 0],
        parameters: { endpointUrl: url, authentication: 'mcpOAuth2', ...parameters },
        credentials: { mcpOAuth2Api: { id: credentialId, name: 'Protected MCP' } },
      },
    ],
    connections: [{ id: 'e0', type: 'main', source: 'Start', target: 'MCP', sourceIndex: 0, targetIndex: 0 }],
  } as Workflow);
}
const run = (wf: Workflow) => runWorkflow({ workflow: wf, mode: 'manual', startNodeId: 'Start' });
const outputs = (record: Awaited<ReturnType<typeof run>>) => record.runData.MCP[0].outputs[0].map((item) => item.json);

describe('discovery', () => {
  it('parses a Bearer challenge', () => {
    expect(parseChallenge('Bearer resource_metadata="https://x/.well-known/oauth-protected-resource/mcp", scope="a b", error="invalid_token"')).toEqual({
      resource_metadata: 'https://x/.well-known/oauth-protected-resource/mcp',
      scope: 'a b',
      error: 'invalid_token',
    });
    expect(parseChallenge('Basic realm="x"')).toEqual({});
    expect(parseChallenge(null)).toEqual({});
  });

  it('lists the metadata locations of an issuer with and without a path', () => {
    expect(metadataUrls('https://as.example')).toEqual(['https://as.example/.well-known/oauth-authorization-server', 'https://as.example/.well-known/openid-configuration']);
    expect(metadataUrls('https://as.example/tenant/1')).toEqual([
      'https://as.example/.well-known/oauth-authorization-server/tenant/1',
      'https://as.example/.well-known/openid-configuration/tenant/1',
      'https://as.example/tenant/1/.well-known/openid-configuration',
    ]);
  });

  it('follows the challenge to the protected resource metadata and the authorization server', async () => {
    const fake = await start();
    const resource = await discoverProtectedResource(fake.url);
    expect(resource).toMatchObject({ resource: fake.url, authorizationServers: [fake.issuer], scope: 'mcp:read' });
    expect(resource.metadataUrl).toBe(`${fake.origin}/.well-known/oauth-protected-resource/mcp`);
    const as = await discoverAuthorizationServer(fake.issuer);
    expect(as).toMatchObject({ issuer: fake.issuer, authUrl: `${fake.issuer}/authorize`, accessTokenUrl: `${fake.issuer}/token`, registrationUrl: `${fake.issuer}/register` });
  });

  it.each(['oidc', 'oidc-append'] as const)('finds an authorization server that only has OpenID Connect metadata (%s)', async (metadata) => {
    const fake = await start({ metadata });
    const prepared = await prepareMcpAuthorization({ serverUrl: fake.url, clientId: '', clientSecret: '', scope: '', redirectUri: REDIRECT });
    expect(prepared).toMatchObject({ issuer: fake.issuer, authUrl: `${fake.issuer}/authorize`, clientId: expect.stringMatching(/^dyn-/), registered: true, resource: fake.url });
  });

  it('treats a server without protected resource metadata as its own authorization server', async () => {
    const fake = await start({ prm: false });
    const prepared = await prepareMcpAuthorization({ serverUrl: fake.url, clientId: '', clientSecret: '', scope: '', redirectUri: REDIRECT });
    expect(prepared).toMatchObject({ issuer: fake.origin, authUrl: `${fake.origin}/authorize`, resource: fake.url, registered: true });
  });

  it('registers a public client dynamically, once per redirect URI', async () => {
    const fake = await start();
    const first = await prepareMcpAuthorization({ serverUrl: fake.url, clientId: '', clientSecret: '', scope: '', redirectUri: REDIRECT });
    expect(fake.registrations).toHaveLength(1);
    expect(fake.registrations[0]).toMatchObject({ client_name: 'Landflow', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' });
    expect(first.tokenAuth).toBe('none');
    const again = await prepareMcpAuthorization({ serverUrl: fake.url, clientId: '', clientSecret: '', scope: '', redirectUri: REDIRECT, meta: first as never });
    expect(again.clientId).toBe(first.clientId);
    expect(fake.registrations).toHaveLength(1);
    const moved = await prepareMcpAuthorization({ serverUrl: fake.url, clientId: '', clientSecret: '', scope: '', redirectUri: 'http://other.test/api/oauth2/callback', meta: first as never });
    expect(moved.clientId).not.toBe(first.clientId);
    expect(fake.registrations).toHaveLength(2);
  });

  it('uses a preconfigured client without registering, and says what to do when there is no way to get one', async () => {
    const fake = await start({ dcr: false, client: { id: 'pre-1', secret: 'pre-secret' } });
    const prepared = await prepareMcpAuthorization({ serverUrl: fake.url, clientId: 'pre-1', clientSecret: 'pre-secret', scope: 'mcp:write', redirectUri: REDIRECT });
    expect(prepared.clientId).toBeUndefined();
    expect(prepared.tokenAuth).toBe('basic');
    expect(fake.registrations).toHaveLength(0);
    await expect(prepareMcpAuthorization({ serverUrl: fake.url, clientId: '', clientSecret: '', scope: '', redirectUri: REDIRECT })).rejects.toThrow(/no dynamic client registration.*enter the client ID/s);
  });

  it('refuses an authorization server without PKCE S256, and a server that is not OAuth at all', async () => {
    const plain = await start({ plainOnly: true });
    await expect(prepareMcpAuthorization({ serverUrl: plain.url, clientId: '', clientSecret: '', scope: '', redirectUri: REDIRECT })).rejects.toThrow(/S256/);
    await expect(prepareMcpAuthorization({ serverUrl: `${plain.origin}/nothing-here`, clientId: '', clientSecret: '', scope: '', redirectUri: REDIRECT })).rejects.toThrow(/no authorization server metadata/i);
    await expect(prepareMcpAuthorization({ serverUrl: '', clientId: '', clientSecret: '', scope: '', redirectUri: REDIRECT })).rejects.toThrow(/endpoint URL/);
  });
});

describe('Connect through the routes', () => {
  it('registers, signs in with PKCE and the resource parameter, and stores an encrypted token', async () => {
    const fake = await start({ expiresIn: 3600 });
    const credential = createCredential(fake);
    expect(registry.credentialType('core.mcpOAuth2Api')?.oauth2).toBe(true);
    const { authorizeUrl, html } = await connect(credential.id);
    expect(html).toContain('Connected');
    expect(Object.fromEntries(authorizeUrl!.searchParams)).toMatchObject({ response_type: 'code', redirect_uri: REDIRECT, code_challenge_method: 'S256', resource: fake.url, scope: 'mcp:read' });
    expect(authorizeUrl!.searchParams.get('client_id')).toMatch(/^dyn-/);
    const exchange = fake.tokenRequests.at(-1)!;
    expect(exchange.params).toMatchObject({ grant_type: 'authorization_code', resource: fake.url, redirect_uri: REDIRECT });
    expect(exchange.params.code_verifier).toMatch(/^[\w-]{43}$/);
    // A public client: no secret goes out.
    expect(exchange.basic).toBeUndefined();
    expect(exchange.params.client_secret).toBeUndefined();
    expect(credentials.list().find((c) => c.id === credential.id)!.oauth2).toMatchObject({ connected: true, refreshable: true });
    // Connect again: the registered client is reused.
    await connect(credential.id);
    expect(fake.registrations).toHaveLength(1);
  });

  it('works with a preconfigured client id and secret', async () => {
    const fake = await start({ dcr: false, client: { id: 'pre-1', secret: 'pre-secret' } });
    const credential = createCredential(fake, { clientId: 'pre-1', clientSecret: 'pre-secret', scope: 'mcp:write' });
    const { authorizeUrl, html } = await connect(credential.id);
    expect(html).toContain('Connected');
    expect(authorizeUrl!.searchParams.get('client_id')).toBe('pre-1');
    expect(authorizeUrl!.searchParams.get('scope')).toBe('mcp:write');
    expect(fake.tokenRequests.at(-1)!.basic).toEqual({ id: 'pre-1', secret: 'pre-secret' });
    expect(fake.registrations).toHaveLength(0);
  });

  it('answers with a readable error when discovery fails', async () => {
    const fake = await start({ dcr: false });
    const credential = createCredential(fake);
    const start1 = await authorizeRoute.GET(new Request(`http://landflow.test/api/credentials/${credential.id}/oauth2/authorize`), params({ id: credential.id }));
    expect(start1.status).not.toBe(302);
    expect(await start1.text()).toMatch(/no dynamic client registration/);
  });
});

describe('MCP Client node with the OAuth credential', () => {
  it('calls a tool with the access token, lists and reads resources, lists and gets prompts', async () => {
    const fake = await start({ expiresIn: 3600 });
    const credential = createCredential(fake);
    await connect(credential.id);

    const add = await run(workflow('wf_mcp_oauth_call', credential.id, fake.url, { operation: 'callTool', tool: 'add', arguments: '{"a":2,"b":3}' }));
    expect(add.status).toBe('success');
    expect(outputs(add)[0]).toMatchObject({ tool: 'add', text: '5' });
    expect(fake.mcpCalls.at(-1)).toEqual({ token: tokenOf(credential.id).access_token, ok: true });

    // The older node without an operation still calls a tool.
    const legacy = await run(workflow('wf_mcp_oauth_legacy', credential.id, fake.url, { tool: 'add', arguments: '{"a":1,"b":1}' }));
    expect(outputs(legacy)[0]).toMatchObject({ text: '2' });

    const resources = await run(workflow('wf_mcp_oauth_resources', credential.id, fake.url, { operation: 'listResources' }));
    expect(outputs(resources)).toEqual([{ kind: 'resource', uri: 'doc://readme', name: 'readme', title: 'Readme', description: 'The project readme', mimeType: 'text/plain' }]);

    const read = await run(workflow('wf_mcp_oauth_read', credential.id, fake.url, { operation: 'readResource', resourceUri: 'doc://readme' }));
    expect(outputs(read)).toEqual([{ uri: 'doc://readme', mimeType: 'text/plain', text: 'Hello from the readme' }]);

    const prompts = await run(workflow('wf_mcp_oauth_prompts', credential.id, fake.url, { operation: 'listPrompts' }));
    expect(outputs(prompts)[0]).toMatchObject({ name: 'review', title: 'Code review', arguments: [{ name: 'language', required: true }] });

    const prompt = await run(workflow('wf_mcp_oauth_prompt', credential.id, fake.url, { operation: 'getPrompt', promptName: 'review', promptArguments: '{"language":"Go"}' }));
    expect(outputs(prompt)[0]).toMatchObject({ name: 'review', text: 'user: Please review this Go code', messages: [{ role: 'user', content: { type: 'text', text: 'Please review this Go code' } }] });
  });

  it('refreshes an expired token before the call, sending the resource parameter', async () => {
    const fake = await start({ expiresIn: 3600 });
    const credential = createCredential(fake);
    await connect(credential.id);
    const old = tokenOf(credential.id).access_token;
    expire(credential.id);
    const record = await run(workflow('wf_mcp_oauth_expiry', credential.id, fake.url, { operation: 'callTool', tool: 'add', arguments: '{"a":1,"b":2}' }));
    expect(record.status).toBe('success');
    const refresh = fake.tokenRequests.at(-1)!;
    expect(refresh.params).toMatchObject({ grant_type: 'refresh_token', resource: fake.url });
    expect(tokenOf(credential.id).access_token).not.toBe(old);
    expect(fake.mcpCalls.at(-1)).toEqual({ token: tokenOf(credential.id).access_token, ok: true });
  });

  it('renews the token once when the server answers 401 mid-flight', async () => {
    const fake = await start({ expiresIn: 3600 });
    const credential = createCredential(fake);
    await connect(credential.id);
    fake.revokeAccess();
    const calls = fake.mcpCalls.length;
    const record = await run(workflow('wf_mcp_oauth_401', credential.id, fake.url, { operation: 'listPrompts' }));
    expect(record.status).toBe('success');
    expect(fake.mcpCalls.slice(calls).some((call) => !call.ok)).toBe(true);
    expect(fake.mcpCalls.at(-1)!.ok).toBe(true);
    expect(fake.tokenRequests.at(-1)!.params.grant_type).toBe('refresh_token');
  });

  it('says to connect when the credential has no token', async () => {
    const fake = await start();
    const credential = createCredential(fake);
    const record = await run(workflow('wf_mcp_oauth_unconnected', credential.id, fake.url, { operation: 'listResources' }));
    expect(record.status).toBe('error');
    expect(record.error?.message).toMatch(/not connected/i);
  });

  it('refuses a token issued for another resource', async () => {
    const fake = await start({ expiresIn: 3600 });
    const credential = createCredential(fake);
    await connect(credential.id);
    fake.validAccess.set(tokenOf(credential.id).access_token, { resource: 'http://elsewhere.test/mcp' });
    const record = await run(workflow('wf_mcp_oauth_audience', credential.id, fake.url, { operation: 'listResources' }));
    // 401 -> renewed once (the refresh asks for the right resource) -> works.
    expect(record.status).toBe('success');
    expect(fake.tokenRequests.at(-1)!.params.resource).toBe(fake.url);
  });
});

describe('agents', () => {
  const agentWith = (tools: AgentConfig['tools']) => {
    const config = { name: 'MCP agent', skills: [], memory: { crossSession: false }, tools } as unknown as AgentConfig;
    return { agent: { id: 'ag_mcp_oauth', ...config } as unknown as Agent, config };
  };
  const ctx = {} as never;

  it('offers the server’s tools, resources and prompts, and renews the token when a call is refused', async () => {
    const fake = await start({ expiresIn: 3600 });
    const credential = createCredential(fake);
    await connect(credential.id);
    const { agent, config } = agentWith([
      { id: 'tool_mcp', type: 'mcp', name: 'Docs', parameters: { endpointUrl: fake.url, authentication: 'mcpOAuth2', extras: ['resources', 'prompts'] }, credentials: { mcpOAuth2Api: { id: credential.id, name: credential.name } } },
    ]);
    const { tools, unavailable } = await buildToolset(agent, config);
    expect(unavailable).toEqual([]);
    expect(tools.map((t) => t.name)).toEqual(['add', 'list_resources', 'read_resource', 'list_prompts', 'get_prompt']);
    const byName = (name: string) => tools.find((t) => t.name === name)!;
    expect(await byName('add').invoke({ a: 20, b: 22 }, ctx)).toEqual({ output: '42' });
    expect(await byName('read_resource').invoke({ uri: 'doc://readme' }, ctx)).toEqual({ output: { contents: [{ uri: 'doc://readme', mimeType: 'text/plain', text: 'Hello from the readme' }] } });
    expect(await byName('list_resources').invoke({}, ctx)).toMatchObject({ output: { resources: [{ uri: 'doc://readme' }] } });
    expect(await byName('list_prompts').invoke({}, ctx)).toMatchObject({ output: { prompts: [{ name: 'review' }] } });
    expect(await byName('get_prompt').invoke({ name: 'review', arguments: { language: 'Rust' } }, ctx)).toEqual({ output: 'user: Please review this Rust code' });

    // The server stops accepting the token (revoked early): the agent's tool renews it once and retries.
    fake.revokeAccess();
    const before = tokenOf(credential.id).access_token;
    expect(await byName('add').invoke({ a: 1, b: 1 }, ctx)).toEqual({ output: '2' });
    expect(tokenOf(credential.id).access_token).not.toBe(before);
    expect(fake.tokenRequests.at(-1)!.params).toMatchObject({ grant_type: 'refresh_token', resource: fake.url });
    // Calls after that use the new header without another refresh.
    const refreshes = fake.tokenRequests.length;
    expect(await byName('add').invoke({ a: 2, b: 2 }, ctx)).toEqual({ output: '4' });
    expect(fake.tokenRequests.length).toBe(refreshes);
  });

  it('leaves resources and prompts out unless asked', async () => {
    const fake = await start({ expiresIn: 3600 });
    const credential = createCredential(fake);
    await connect(credential.id);
    const { agent, config } = agentWith([{ id: 't', type: 'mcp', name: 'Docs', parameters: { endpointUrl: fake.url, authentication: 'mcpOAuth2' }, credentials: { mcpOAuth2Api: { id: credential.id, name: credential.name } } }]);
    expect((await buildToolset(agent, config)).tools.map((t) => t.name)).toEqual(['add']);
  });
});

describe('client library', () => {
  it('lists and reads resources and prompts with a bearer token directly', async () => {
    const fake = await start({ expiresIn: 3600 });
    const credential = createCredential(fake);
    await connect(credential.id);
    const endpoint = endpointFrom({ endpointUrl: fake.url, authentication: 'mcpOAuth2' }, { mcpOAuth2Api: { accessToken: tokenOf(credential.id).access_token } });
    expect((await listMcpTools(endpoint)).map((t) => t.name)).toEqual(['add']);
    expect((await listMcpResources(endpoint)).map((r) => r.uri)).toEqual(['doc://readme']);
    expect(await readMcpResource(endpoint, 'doc://readme')).toHaveLength(1);
    await expect(readMcpResource(endpoint, 'doc://missing')).rejects.toThrow();
    expect((await listMcpPrompts(endpoint)).map((p) => p.name)).toEqual(['review']);
    await expect(getMcpPrompt(endpoint, 'nope')).rejects.toThrow();
    // Without a token the server answers 401 and the error says what to do.
    const anonymous = endpointFrom({ endpointUrl: fake.url }, {});
    await expect(listMcpTools(anonymous)).rejects.toThrow(/rejected the credentials \(401\)/);
    expect(() => endpointFrom({ endpointUrl: fake.url, authentication: 'mcpOAuth2' }, {})).toThrow(/not connected/);
  });
});
