/**
 * The MCP OAuth client against the dev Keycloak (opt-in, it must be running):
 *
 *   docker compose -p landflow-infra -f deploy/compose.infra.yml --profile auth up -d keycloak
 *   LANDFLOW_INTEGRATION=oauth2 npx vitest run test/mcp-oauth-keycloak.test.ts
 *
 * An MCP server (./fake-mcp-oauth) whose protected resource metadata names the Keycloak realm `landflow` as its authorization
 * server. Discovery reads the realm's OpenID Connect metadata, the confidential client `landflow` is preconfigured (the realm
 * has no open registration), the sign-in goes through Keycloak's login form (alice) with the authorize and callback routes, and
 * the MCP Client node calls the server with the Keycloak access token (the server checks it at Keycloak's userinfo endpoint).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Workflow } from '@landflow/engine';
import { startFakeMcpOAuth } from './fake-mcp-oauth';

const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('oauth2'));
const KEYCLOAK = process.env.LANDFLOW_KEYCLOAK_URL ?? 'http://localhost:58080';
const REALM = `${KEYCLOAK}/realms/landflow`;

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-mcp-oauth-keycloak-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://localhost:3000' };
const previousEnv = { ...process.env };

const unescapeHtml = (value: string) => value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

describe.skipIf(!enabled)('MCP OAuth against Keycloak', async () => {
  Object.assign(process.env, ENV);
  const { registry } = await import('@/lib/server/plugins/registry');
  const { corePlugin } = await import('@/lib/server/nodes');
  const { credentials } = await import('@/lib/server/credentials/vault');
  const { store } = await import('@/lib/server/store');
  const { runWorkflow } = await import('@/lib/server/runner');
  const { waits } = await import('@/lib/server/waits');
  const { closeMcpClients } = await import('@/lib/server/mcp/client');
  const authorizeRoute = await import('@/app/api/credentials/[id]/oauth2/authorize/route');
  const callbackRoute = await import('@/app/api/oauth2/callback/route');
  registry.registerBuiltin(corePlugin);

  const server = await startFakeMcpOAuth({
    externalIssuer: REALM,
    verifyToken: async (token) => (await fetch(`${REALM}/protocol/openid-connect/userinfo`, { headers: { authorization: `Bearer ${token}` } })).ok,
  });

  afterAll(async () => {
    await closeMcpClients();
    await server.close();
    waits.stop();
    for (const key of Object.keys(ENV)) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  it('discovers Keycloak from the server’s metadata, signs in through the login form and calls the server', async () => {
    const credential = credentials.create({
      name: 'Keycloak MCP',
      type: 'core.mcpOAuth2Api',
      data: { serverUrl: server.url, clientId: 'landflow', clientSecret: 'landflow-dev-client-secret', scope: 'openid email profile' },
    });
    const start = await authorizeRoute.GET(new Request(`http://localhost:3000/api/credentials/${credential.id}/oauth2/authorize`), { params: Promise.resolve({ id: credential.id }) });
    expect(start.status).toBe(302);
    const authorizeUrl = new URL(start.headers.get('location')!);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(`${REALM}/protocol/openid-connect/auth`);
    expect(authorizeUrl.searchParams.get('resource')).toBe(server.url);
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(credentials.mcpOAuth(credential.id)!.meta).toMatchObject({ issuer: REALM, resource: server.url });

    const flowCookie = start.headers.get('set-cookie')!.split(';')[0];
    const cookies = new Map<string, string>();
    const take = (response: Response) => {
      for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(';');
        const index = pair.indexOf('=');
        cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
    };
    const loginPage = await fetch(authorizeUrl, { redirect: 'manual' });
    take(loginPage);
    expect(loginPage.status).toBe(200);
    const action = (await loginPage.text()).match(/action="([^"]*login-actions\/authenticate[^"]*)"/)?.[1];
    expect(action, 'Keycloak login form').toBeTruthy();
    const submitted = await fetch(unescapeHtml(action!), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: new URLSearchParams({ username: 'alice', password: 'alice-test-only', credentialId: '' }),
    });
    expect(submitted.status).toBe(302);
    const page = await callbackRoute.GET(new Request(new URL(submitted.headers.get('location')!), { headers: { cookie: flowCookie } }));
    expect(await page.text()).toContain('Connected');

    const workflow = store.saveWorkflow({
      id: 'wf_mcp_keycloak',
      name: 'wf_mcp_keycloak',
      nodes: [
        { id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        {
          id: 'MCP',
          name: 'MCP',
          type: 'core.mcpClient',
          typeVersion: 1,
          position: [200, 0],
          parameters: { endpointUrl: server.url, authentication: 'mcpOAuth2', operation: 'callTool', tool: 'add', arguments: '{"a":40,"b":2}' },
          credentials: { mcpOAuth2Api: { id: credential.id, name: 'Keycloak MCP' } },
        },
      ],
      connections: [{ id: 'e0', type: 'main', source: 'Start', target: 'MCP', sourceIndex: 0, targetIndex: 0 }],
    } as Workflow);
    const record = await runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start' });
    expect(record.status).toBe('success');
    expect(record.runData.MCP[0].outputs[0][0].json).toMatchObject({ tool: 'add', text: '42' });
    expect(server.mcpCalls.at(-1)!.ok).toBe(true);
  });
});
