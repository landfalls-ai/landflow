/** The plugin end to end: the manifest over HTTP with both nodes, the credentials and inlined icons, and a call through the HTTP face. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HTTP_PATHS, manifestSchema, type ExecuteResponse, type PluginManifest } from '@landflow/protocol';
import { createFetchHandler } from '@landflow/sdk/http';
import { plugin } from '../src/main';
import { API_KEY, FakeLinear, startFakeLinear } from './fake-linear';
import { executeRequest, type FakeApi } from './helpers';

const fake = new FakeLinear();
let api: FakeApi;
beforeAll(async () => {
  api = await startFakeLinear(fake);
});
afterAll(() => api.close());

describe('Linear plugin', () => {
  const handler = createFetchHandler(plugin);

  it('serves a valid manifest with the nodes, the credentials and inlined icons', async () => {
    const response = await handler(new Request(`http://plugin${HTTP_PATHS.manifest}`));
    expect(response.status).toBe(200);
    const manifest = manifestSchema.parse(await response.json()) as PluginManifest;
    expect(manifest.plugin).toMatchObject({ id: 'linear', name: 'Linear' });
    expect(manifest.plugin.icon).toMatch(/^data:image\/svg\+xml/);
    expect(manifest.nodes.map((n) => n.name)).toEqual(['linear', 'linearTrigger']);
    expect(manifest.nodes[0]).toMatchObject({ usableAsTool: true, idempotent: false, icon: expect.stringMatching(/^data:image\/svg\+xml/) });
    expect(manifest.nodes[1]).toMatchObject({ kind: 'trigger', triggerSource: 'appWebhook' });
    expect(manifest.credentialTypes?.map((c) => c.name)).toEqual(['linearApi', 'linearOAuth2Api']);
    expect(manifest.credentialTypes?.[1].extends).toEqual(['oAuth2Api']);
  });

  it('executes over HTTP', async () => {
    const request = executeRequest('linear', { authentication: 'apiKey', resource: 'comment', operation: 'create', issueId: 'ENG-1', body: 'hello' }, {
      credentials: { linearApi: { apiKey: API_KEY, baseUrl: api.url } },
    });
    const response = await handler(new Request(`http://plugin${HTTP_PATHS.execute}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) }));
    const body = (await response.json()) as ExecuteResponse;
    expect(body.error).toBeUndefined();
    expect(body.outputs[0][0].json).toMatchObject({ body: 'hello' });
  });
});
