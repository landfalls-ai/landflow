/** The plugin end to end: the manifest over HTTP, credential tests (good and bad) and a call through the HTTP face. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HTTP_PATHS, manifestSchema, type ExecuteResponse, type PluginManifest } from '@landflow/protocol';
import { createFetchHandler } from '@landflow/sdk/http';
import { plugin } from '../src/main';
import { FakeAttio, TOKEN } from './fake-attio';
import { executeRequest, startFakeApi, testCredentials, type FakeApi } from './helpers';

const fake = new FakeAttio().seed();
let api: FakeApi;
beforeAll(async () => {
  api = await startFakeApi(fake.handle);
});
afterAll(() => api.close());
const handler = createFetchHandler(plugin);

describe('Attio plugin', () => {
  it('serves a valid manifest: trigger, node, two credential types, inlined icons', async () => {
    const response = await handler(new Request(`http://plugin${HTTP_PATHS.manifest}`));
    const manifest = manifestSchema.parse(await response.json()) as PluginManifest;
    expect(manifest.plugin).toMatchObject({ id: 'attio', name: 'Attio' });
    expect(manifest.plugin.icon).toMatch(/^data:image\/svg\+xml/);
    expect(manifest.nodes.map((n) => n.name)).toEqual(['attioTrigger', 'attio']);
    const [trigger, node] = manifest.nodes;
    expect(trigger).toMatchObject({ kind: 'trigger', triggerSource: 'appWebhook' });
    expect(trigger.icon).toMatch(/^data:image\/svg\+xml/);
    expect(node).toMatchObject({ usableAsTool: true, idempotent: false });
    expect(manifest.credentialTypes?.map((c) => c.name)).toEqual(['attioApi', 'attioOAuth2Api']);
    const oauth = manifest.credentialTypes![1];
    expect(oauth.extends).toEqual(['oAuth2Api']);
    const defaults = Object.fromEntries(oauth.properties.map((p) => [p.name, p.default]));
    expect(defaults).toMatchObject({ authUrl: 'https://app.attio.com/authorize', accessTokenUrl: 'https://app.attio.com/oauth/token', grantType: 'authorizationCode', authentication: 'body' });
    expect(manifest.credentialTypes![0].properties.map((p) => p.name)).toEqual(['accessToken', 'baseUrl']);
  });

  it('the credential test calls /v2/self: good token names the workspace, bad token fails', async () => {
    for (const type of ['attioApi', 'attioOAuth2Api']) {
      const good = await testCredentials(type, { accessToken: TOKEN, baseUrl: api.url });
      expect(good).toMatchObject({ ok: true });
      expect(good.message).toContain('Acme CRM');
      const bad = await testCredentials(type, { accessToken: 'nope', baseUrl: api.url });
      expect(bad.ok).toBe(false);
      expect(bad.message).toMatch(/not active/);
    }
    fake.fail.set('GET /v2/self', { status: 401, body: { status_code: 401, code: 'unauthorized', message: 'Invalid token' } });
    expect((await testCredentials('attioApi', { accessToken: TOKEN, baseUrl: api.url })).message).toMatch(/401/);
    expect((await testCredentials('attioApi', { accessToken: TOKEN, baseUrl: 'http://127.0.0.1:1' })).ok).toBe(false);
  });

  it('executes over HTTP', async () => {
    const request = executeRequest('attio', { resource: 'workspaceMember', operation: 'getAll' }, { credentials: { attioApi: { accessToken: TOKEN, baseUrl: api.url } } });
    const response = await handler(new Request(`http://plugin${HTTP_PATHS.execute}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) }));
    const body = (await response.json()) as ExecuteResponse;
    expect(body.error).toBeUndefined();
    expect(body.outputs[0].map((i) => i.json.email)).toEqual(['Ana@Acme.example', 'ben@acme.example']);
  });
});
