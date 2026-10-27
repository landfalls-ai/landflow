/**
 * Connect for every provider preset and for the OAuth2 credential types the plugins ship (messaging: Slack, Discord;
 * productivity: GitHub, Notion, Airtable, HubSpot), against the fake provider (./fake-oauth2). The presets and the
 * plugins' real descriptors are used as they are, except that the provider's two URLs point at the fake: the scope,
 * the extra authorization parameters, the grant (PKCE or not) and the client authentication each one asks for are
 * checked on the wire, then a node of the plugin gets a fresh token (refresh before expiry, renew after a 401).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CredentialTypeDescriptor, JsonObject } from '@landflow/protocol';
import type { Workflow } from '@landflow/engine';
import { startFakeOAuth2 } from './fake-oauth2';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-oauth2-plugins-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://landflow.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { credentials } = await import('@/lib/server/credentials/vault');
const oauth2 = await import('@/lib/server/credentials/oauth2');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { waits } = await import('@/lib/server/waits');
const { OAUTH2_PRESETS } = await import('@/lib/shared/oauth2');
const authorizeRoute = await import('@/app/api/credentials/[id]/oauth2/authorize/route');
const callbackRoute = await import('@/app/api/oauth2/callback/route');
const { defineNode, definePlugin } = await import('@landflow/sdk');

const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const fake = await startFakeOAuth2({ expiresIn: 3600 });

/** The OAuth2 credential types of the TypeScript messaging plugin, as its manifest declares them. */
const messaging = ((await import('../../../plugins/messaging/src/main')) as { plugin: { credentialTypes?: CredentialTypeDescriptor[] } }).plugin.credentialTypes ?? [];
/** The productivity plugin's (Python): its manifest, printed by the plugin itself. */
const productivity = JSON.parse(
  execFileSync(
    'python3',
    [
      '-I',
      '-c',
      `import json, sys\nsys.path[:0] = [${JSON.stringify(join(repo, 'plugins/productivity'))}, ${JSON.stringify(join(repo, 'sdks/python'))}]\nfrom productivity import build_plugin\nprint(json.dumps(build_plugin().manifest()["credentialTypes"]))`,
    ],
    { encoding: 'utf8' },
  ),
) as CredentialTypeDescriptor[];

const oauth2Types = (all: CredentialTypeDescriptor[]) => all.filter((type) => type.extends?.includes('oAuth2Api'));
/** The descriptor with the provider's URLs replaced by the fake's; everything else (grant, scope, query, client auth) as shipped. */
const pointAtFake = (type: CredentialTypeDescriptor): CredentialTypeDescriptor => ({
  ...type,
  icon: undefined, // file: icons need the plugin's icon directory
  properties: type.properties.map((p) =>
    p.name === 'authUrl' ? { ...p, default: `${fake.url}/authorize` } : p.name === 'accessTokenUrl' ? { ...p, default: `${fake.url}/token` } : p.name === 'userInfoUrl' ? { ...p, default: '' } : p,
  ),
});

/** A node per credential type that echoes what it receives and fails with a 401 on a token the provider does not know. */
const pluginOf = (id: string, types: CredentialTypeDescriptor[]) =>
  definePlugin({
    info: { id, name: id, version: '1.0.0', language: 'typescript' },
    credentialTypes: types.map((type) => pointAtFake(type) as never),
    nodes: types.map((type) =>
      defineNode({
        description: { name: `use_${type.name}`, displayName: type.name, version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [], credentials: [{ name: type.name, required: true }] },
        async execute(ctx) {
          const data = ctx.getCredentials(type.name);
          const response = await fetch(`${fake.url}/resource`, { headers: { authorization: `Bearer ${String(data.accessToken)}` } });
          if (response.status === 401) throw new Error('API error 401: Unauthorized');
          return [[{ json: { received: data } }]];
        },
      }),
    ),
  });

registry.registerBuiltin(corePlugin);
registry.registerBuiltin(pluginOf('lfmessaging', oauth2Types(messaging)));
registry.registerBuiltin(pluginOf('lfproductivity', oauth2Types(productivity)));

afterAll(async () => {
  waits.stop();
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

beforeEach(() => {
  fake.options.expiresIn = 3600;
  fake.options.rotateRefreshTokens = true;
  fake.tokenRequests.length = 0;
});

const params = <T>(value: T) => ({ params: Promise.resolve(value) });

/** Connect through the routes the way a browser would. */
async function connect(id: string) {
  const start = await authorizeRoute.GET(new Request(`http://landflow.test/api/credentials/${id}/oauth2/authorize`), params({ id }));
  expect(start.status).toBe(302);
  const authorizeUrl = new URL(start.headers.get('location')!);
  const cookie = start.headers.get('set-cookie')!.split(';')[0];
  const consent = await fetch(authorizeUrl, { redirect: 'manual' });
  const page = await callbackRoute.GET(new Request(new URL(consent.headers.get('location')!), { headers: { cookie } }));
  return { page, html: await page.text(), authorizeUrl };
}

const defaultOf = (type: { properties: Array<{ name: string; default?: unknown }> }, name: string) => type.properties.find((p) => p.name === name)?.default;
const queryOf = (text: unknown) => Object.fromEntries(new URLSearchParams(String(text ?? '')));

/** What the type or preset asks for, checked on the wire. */
function expectFlow(authorizeUrl: URL, expected: { scope: string; query: string; grantType: string; authentication: string }) {
  const sent = authorizeUrl.searchParams;
  expect(sent.get('scope') ?? '').toBe(expected.scope);
  for (const [key, value] of Object.entries(queryOf(expected.query))) expect(sent.get(key), key).toBe(value);
  expect(sent.get('code_challenge_method') === 'S256').toBe(expected.grantType === 'pkce');
  const exchange = fake.tokenRequests.at(-1)!;
  expect(exchange.params.grant_type).toBe('authorization_code');
  expect(Boolean(exchange.params.code_verifier)).toBe(expected.grantType === 'pkce');
  if (expected.authentication === 'header') expect(exchange.basic).toEqual({ id: 'client-1', secret: 'secret-1' });
  else expect(exchange.basic === undefined && exchange.params.client_id === 'client-1').toBe(true);
}

describe('provider presets', () => {
  it('lists every provider the plugins use', () => {
    expect(OAUTH2_PRESETS.map((p) => p.id)).toEqual(expect.arrayContaining(['google', 'github', 'slack', 'microsoft', 'notion', 'discord', 'hubspot', 'airtable']));
    for (const preset of OAUTH2_PRESETS) {
      expect(preset.values.authUrl).toMatch(/^https:\/\//);
      expect(preset.values.accessTokenUrl).toMatch(/^https:\/\//);
      expect(preset.docsUrl).toMatch(/^https:\/\//);
    }
  });

  for (const preset of OAUTH2_PRESETS) {
    it(`${preset.name}: Connect asks for the preset's scope and parameters and authenticates the client as it says`, async () => {
      const credential = credentials.create({
        name: preset.name,
        type: 'core.oAuth2Api',
        data: { ...preset.values, authUrl: `${fake.url}/authorize`, accessTokenUrl: `${fake.url}/token`, userInfoUrl: '', clientId: 'client-1', clientSecret: 'secret-1' } as JsonObject,
      });
      const { page, authorizeUrl } = await connect(credential.id);
      expect(page.status).toBe(200);
      expectFlow(authorizeUrl, { scope: preset.values.scope, query: preset.values.authQueryParameters ?? '', grantType: 'pkce', authentication: preset.values.authentication ?? 'header' });
      expect(credentials.list().find((c) => c.id === credential.id)!.oauth2).toMatchObject({ connected: true, refreshable: true });
    });
  }
});

describe('the plugins’ OAuth2 credential types', () => {
  const shipped = [
    ...oauth2Types(messaging).map((type) => ['lfmessaging', type] as const),
    ...oauth2Types(productivity).map((type) => ['lfproductivity', type] as const),
  ];

  it('are the seven services with an OAuth2 variant', () => {
    expect(shipped.map(([, type]) => type.name).sort()).toEqual([
      'airtableOAuth2Api',
      'discordOAuth2Api',
      'githubOAuth2Api',
      'hubspotOAuth2Api',
      'jiraSoftwareCloudOAuth2Api',
      'notionOAuth2Api',
      'slackOAuth2Api',
    ]);
  });

  for (const [pluginId, type] of shipped) {
    const qualified = `${pluginId}.${type.name}`;
    const workflowFor = (credentialId: string): Workflow =>
      store.saveWorkflow({
        id: `wf_${type.name}`,
        name: type.name,
        nodes: [
          { id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
          { id: 'Use', name: 'Use', type: `${pluginId}.use_${type.name}`, typeVersion: 1, position: [200, 0], parameters: {}, credentials: { [type.name]: { id: credentialId, name: type.name } } },
        ],
        connections: [{ id: 'e0', type: 'main', source: 'Start', target: 'Use', sourceIndex: 0, targetIndex: 0 }],
      } as Workflow);
    const run = (workflow: Workflow) => runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start' });

    it(`${type.name}: merges the generic fields, connects, and hands its node a fresh token`, async () => {
      const info = registry.credentialType(qualified)!;
      expect(info.oauth2).toBe(true);
      expect(info.extendsTypes).toEqual(['core.oAuth2Api']);
      const names = info.descriptor.properties.map((p) => p.name);
      expect(names).toEqual(expect.arrayContaining(['grantType', 'authUrl', 'accessTokenUrl', 'clientId', 'clientSecret', 'scope', 'authentication']));
      // The provider's URLs are fixed by the type, not typed in the dialog.
      expect(info.descriptor.properties.find((p) => p.name === 'authUrl')?.type).toBe('hidden');
      expect(info.descriptor.properties.find((p) => p.name === 'accessTokenUrl')?.type).toBe('hidden');

      const credential = credentials.create({ name: type.name, type: qualified, data: { clientId: 'client-1', clientSecret: 'secret-1' } });
      const { page, authorizeUrl } = await connect(credential.id);
      expect(page.status).toBe(200);
      const merged = info.descriptor;
      expectFlow(authorizeUrl, {
        scope: String(defaultOf(merged, 'scope')),
        query: String(defaultOf(merged, 'authQueryParameters') ?? ''),
        grantType: String(defaultOf(merged, 'grantType')),
        authentication: String(defaultOf(merged, 'authentication')),
      });

      // Refresh before expiry: an expired token is renewed before the node runs, and the node sees the new one.
      const token = credentials.oauth2(credential.id).token!;
      credentials.saveOAuth2Token(credential.id, { ...token, expires_at: new Date(Date.now() - 5_000).toISOString() });
      const workflow = workflowFor(credential.id);
      let record = await run(workflow);
      expect(record.status).toBe('success');
      const fresh = credentials.oauth2(credential.id).token!;
      expect(fresh.access_token).not.toBe(token.access_token);
      const received = record.runData.Use[0].outputs[0][0].json.received as JsonObject;
      expect(received.accessToken).toBe(oauth2.tokenField(fresh, 'access_token'));
      expect(JSON.stringify(received)).not.toContain(oauth2.tokenField(fresh, 'refresh_token'));

      // Renew after a 401: the provider forgot the token, the node fails with a 401, the host refreshes and runs it again.
      const before = fake.tokenRequests.length;
      fake.revokeAccess();
      record = await run(workflow);
      expect(record.status).toBe('success');
      expect(fake.tokenRequests.slice(before).map((r) => r.params.grant_type)).toEqual(['refresh_token']);
    });
  }
});
