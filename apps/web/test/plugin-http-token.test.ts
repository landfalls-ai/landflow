/** The host proves the shared secret to HTTP plugins with a derived token (never the raw secret); without a secret it sends none. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GUARD_HEADER, pluginHttpToken } from '@landflow/sdk';
import { createClient } from '@/lib/server/plugins/clients';

let server: Server;
let endpoint: string;
let claimedId = 'x';
let seen: Record<string, string | string[] | undefined>[];

beforeEach(async () => {
  seen = [];
  claimedId = 'x';
  server = createServer((req, res) => {
    seen.push(req.headers);
    req.resume();
    res.setHeader('content-type', 'application/json');
    if (req.url?.includes('well-known')) return res.end(JSON.stringify({ protocol: 'landflow.plugin/v1', plugin: { id: claimedId, name: 'x', version: '1' }, endpoints: {} }));
    res.end(JSON.stringify({ status: 'ok', uptimeMs: 1, pluginId: 'x', version: '1' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => {
  delete process.env.LANDFLOW_TRANSPORT_SECRET;
  delete process.env.LANDFLOW_REGISTRY_SECRET;
  return new Promise<void>((r) => server.close(() => r()));
});

const request = { protocol: 'landflow.plugin/v1', executionId: 'e', mode: 'manual', node: { id: 'n', name: 'n', type: 'x.y', typeVersion: 1 }, parameters: {}, itemParameters: [{}], inputs: [[]] } as never;

describe('HttpPluginClient token', () => {
  it('sends the derived token on execute when a secret is set, and not the secret', async () => {
    process.env.LANDFLOW_TRANSPORT_SECRET = 'shared-secret';
    await createClient(endpoint).execute(request).catch(() => {});
    expect(seen.at(-1)![GUARD_HEADER]).toBe(pluginHttpToken('shared-secret', 'x'));
    expect(JSON.stringify(seen.at(-1))).not.toContain('shared-secret');
  });
  it('falls back to the registry secret', async () => {
    process.env.LANDFLOW_REGISTRY_SECRET = 'registry-secret';
    await createClient(endpoint).execute(request).catch(() => {});
    expect(seen.at(-1)![GUARD_HEADER]).toBe(pluginHttpToken('registry-secret', 'x'));
  });
  it('sends nothing without a secret', async () => {
    await createClient(endpoint).execute(request).catch(() => {});
    expect(seen.at(-1)![GUARD_HEADER]).toBeUndefined();
  });
  it('does not send it on health probes', async () => {
    process.env.LANDFLOW_TRANSPORT_SECRET = 'shared-secret';
    await createClient(endpoint).health();
    expect(seen.at(-1)![GUARD_HEADER]).toBeUndefined();
  });
  it('derives the token from the plugin id the endpoint reports, so one plugin\'s token does not open another', async () => {
    process.env.LANDFLOW_TRANSPORT_SECRET = 'shared-secret';
    claimedId = 'deck';
    await createClient(endpoint).execute(request).catch(() => {});
    expect(seen.at(-1)![GUARD_HEADER]).toBe(pluginHttpToken('shared-secret', 'deck'));
    expect(seen.at(-1)![GUARD_HEADER]).not.toBe(pluginHttpToken('shared-secret', 'x'));
  });
  it('never sends the token with the discovery request itself', async () => {
    process.env.LANDFLOW_TRANSPORT_SECRET = 'shared-secret';
    await createClient(endpoint).execute(request).catch(() => {});
    expect(seen[0][GUARD_HEADER]).toBeUndefined();
  });
});
