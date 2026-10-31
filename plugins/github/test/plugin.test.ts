/** The plugin end to end: the manifest over HTTP, the node and credential in it, and a call through the HTTP face. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HTTP_PATHS, manifestSchema, type ExecuteResponse, type PluginManifest } from '@landflow/protocol';
import { createFetchHandler } from '@landflow/sdk/http';
import { plugin } from '../src/main';
import { FakeGitHub, OWNER, REPO, TOKEN } from './fake-github';
import { executeRequest, startFakeApi, type FakeApi } from './helpers';

const fake = new FakeGitHub();
let api: FakeApi;
beforeAll(async () => {
  api = await startFakeApi(fake.handle);
});
afterAll(() => api.close());

describe('GitHub plugin', () => {
  const handler = createFetchHandler(plugin);

  it('serves a valid manifest with the node, the credential and inlined icons', async () => {
    const response = await handler(new Request(`http://plugin${HTTP_PATHS.manifest}`));
    expect(response.status).toBe(200);
    const manifest = manifestSchema.parse(await response.json()) as PluginManifest;
    expect(manifest.plugin).toMatchObject({ id: 'github', name: 'GitHub' });
    expect(manifest.plugin.icon).toMatch(/^data:image\/svg\+xml/);
    expect(manifest.nodes.map((n) => n.name)).toEqual(['github']);
    expect(manifest.nodes[0]).toMatchObject({ usableAsTool: true, idempotent: false, credentials: [{ name: 'githubApi', required: true }] });
    expect(manifest.credentialTypes?.map((c) => c.name)).toEqual(['githubApi']);
    expect(manifest.credentialTypes?.[0].properties.map((p) => p.name)).toEqual(['accessToken', 'baseUrl']);
  });

  it('executes over HTTP', async () => {
    const request = executeRequest('github', { resource: 'branch', operation: 'get', owner: OWNER, repository: REPO, branch: 'main' }, {
      credentials: { githubApi: { accessToken: TOKEN, baseUrl: `${api.url}/api/v3` } },
    });
    const response = await handler(new Request(`http://plugin${HTTP_PATHS.execute}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) }));
    const body = (await response.json()) as ExecuteResponse;
    expect(body.error).toBeUndefined();
    expect(body.outputs[0][0].json).toMatchObject({ branch: 'main', sha: fake.refs.get('main') });
  });
});
