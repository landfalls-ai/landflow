/** The opt-in HTTP guard: a plugin that can start real work refuses browsers and callers without the shared token. */
import { describe, expect, it } from 'vitest';
import { defineNode, definePlugin } from '../src';
import { createFetchHandler } from '../src/http';
import { HTTP_PATHS } from '@landflow/protocol';
import { GUARD_HEADER, pluginHttpToken } from '../src/guard';

const echo = defineNode({
  description: { name: 'echo', displayName: 'Echo', description: '', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
  async execute(ctx) {
    return [ctx.getInputData()];
  },
});
const plugin = definePlugin({ info: { id: 'guarded', name: 'Guarded', version: '0.0.1' }, nodes: [echo] });

const token = pluginHttpToken('s3cret', 'guarded');
const post = (path: string, headers: Record<string, string> = {}, body = '{}') => new Request(`http://127.0.0.1:7999${path}`, { method: 'POST', headers, body });
const json = { 'content-type': 'application/json' };

describe('pluginHttpToken', () => {
  it('is stable, differs by secret and never is the secret', () => {
    expect(pluginHttpToken('s3cret', 'guarded')).toBe(token);
    expect(pluginHttpToken('other', 'guarded')).not.toBe(token);
    expect(pluginHttpToken('s3cret', 'another-plugin')).not.toBe(token); // a token for one plugin does not open another
    expect(token).not.toContain('s3cret');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('without a guard (every other plugin)', () => {
  it('behaves as before: text/plain, an Origin and no token still reach /execute', async () => {
    const handle = createFetchHandler(plugin);
    const response = await handle(post(HTTP_PATHS.execute, { 'content-type': 'text/plain', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }));
    expect(response.status).toBe(400); // reached validation, not refused
  });
});

describe('with a guard', () => {
  const handle = createFetchHandler(plugin, { guard: { token } });
  const ok = { ...json, [GUARD_HEADER]: token };

  it('passes a correct call through to the handler', async () => {
    expect((await handle(post(HTTP_PATHS.execute, ok))).status).toBe(400);
  });
  it('refuses a request carrying an Origin header', async () => {
    expect((await handle(post(HTTP_PATHS.execute, { ...ok, origin: 'http://127.0.0.1:3000' }))).status).toBe(403);
  });
  it('refuses Sec-Fetch-Site other than none', async () => {
    for (const site of ['cross-site', 'same-site', 'same-origin']) expect((await handle(post(HTTP_PATHS.execute, { ...ok, 'sec-fetch-site': site }))).status).toBe(403);
    expect((await handle(post(HTTP_PATHS.execute, { ...ok, 'sec-fetch-site': 'none' }))).status).toBe(400);
  });
  it('requires application/json', async () => {
    expect((await handle(post(HTTP_PATHS.execute, { [GUARD_HEADER]: token, 'content-type': 'text/plain' }))).status).toBe(415);
    expect((await handle(post(HTTP_PATHS.execute, { [GUARD_HEADER]: token }))).status).toBe(415);
  });
  it('requires the token', async () => {
    expect((await handle(post(HTTP_PATHS.execute, json))).status).toBe(401);
    expect((await handle(post(HTTP_PATHS.execute, { ...json, [GUARD_HEADER]: pluginHttpToken('wrong', 'guarded') }))).status).toBe(401);
  });
  it('guards every POST route and the MCP mount', async () => {
    for (const path of [HTTP_PATHS.loadOptions, HTTP_PATHS.testCredentials, HTTP_PATHS.webhookMethod, HTTP_PATHS.webhook]) expect((await handle(post(path, json))).status).toBe(401);
    const withMcp = createFetchHandler(plugin, { guard: { token }, mcp: { fetch: async () => new Response('mcp reached') } });
    expect((await withMcp(post('/mcp', json))).status).toBe(401);
    expect((await withMcp(new Request('http://127.0.0.1:7999/mcp', { method: 'GET' }))).status).toBe(401);
    expect(await (await withMcp(post('/mcp', ok))).text()).toBe('mcp reached');
  });
  it('leaves discovery and health readable', async () => {
    for (const path of [HTTP_PATHS.health, HTTP_PATHS.manifest, HTTP_PATHS.wellKnown]) expect((await handle(new Request(`http://127.0.0.1:7999${path}`))).status).toBe(200);
  });
});
