/** C14 (P14): the policy hook routes under /api/settings/mcp, called directly as the synthetic owner. */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'lf-mcp-policy-routes-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { credentials } = await import('@/lib/server/credentials/vault');
const { routePolicy } = await import('@/lib/server/auth/policy');
const { queryEvents } = await import('@/lib/server/audit/store');
const list = await import('@/app/api/settings/mcp/policy-hooks/route');
const one = await import('@/app/api/settings/mcp/policy-hooks/[id]/route');
const test = await import('@/app/api/settings/mcp/policy-hooks/[id]/test/route');

registry.registerBuiltin(corePlugin);

let service: Server;
let url = '';
let reply: unknown = { decision: 'allow' };
beforeAll(async () => {
  service = createServer((_req, res) => res.end(JSON.stringify(reply)));
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(service.address() as AddressInfo).port}/decide`;
});
afterAll(async () => {
  service.closeAllConnections();
  await new Promise((r) => service.close(r));
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const req = (path: string, method: string, body?: unknown) => new Request(`http://localhost/api/settings/mcp/policy-hooks${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const reads = async (response: Response) => (await response.json()) as Record<string, any>;

describe('the policy hook routes', () => {
  it('are admin mcp:manage by the settings rule, for every method', () => {
    for (const [method, path] of [['GET', '/api/settings/mcp/policy-hooks'], ['POST', '/api/settings/mcp/policy-hooks'], ['PATCH', '/api/settings/mcp/policy-hooks/x'], ['DELETE', '/api/settings/mcp/policy-hooks/x'], ['POST', '/api/settings/mcp/policy-hooks/x/test']] as const) {
      expect(routePolicy(method, path)).toEqual({ scope: 'admin', action: 'mcp:manage' });
    }
  });

  it('create, list, read, change and remove a hook, and never show the credential', async () => {
    const credential = credentials.create({ name: 'Hook key', type: 'core.httpBearerAuth', data: { token: 'route-secret-token' } });
    const created = await list.POST(req('', 'POST', { name: 'Finance', url, credentialId: credential.id, match: { tools: ['delete_*'] } }));
    expect(created.status).toBe(201);
    const { hook } = await reads(created);
    expect(hook).toMatchObject({ name: 'Finance', auth: 'hmac', credential: { id: credential.id, name: 'Hook key' }, match: { tools: ['delete_*'], methods: ['tools/call'] } });
    expect(hook.credentialId).toBeUndefined();

    const listed = await reads(await list.GET(req('', 'GET')));
    expect(listed.hooks.map((h: { id: string }) => h.id)).toEqual([hook.id]);
    expect((await reads(await one.GET(req(`/${hook.id}`, 'GET'), ctx(hook.id)))).hook.name).toBe('Finance');

    const patched = await reads(await one.PATCH(req(`/${hook.id}`, 'PATCH', { failureMode: 'closed', enabled: false }), ctx(hook.id)));
    expect(patched.hook).toMatchObject({ failureMode: 'closed', enabled: false, name: 'Finance' });
    const cleared = await reads(await one.PATCH(req(`/${hook.id}`, 'PATCH', { auth: 'none', credentialId: null }), ctx(hook.id)));
    expect(cleared.hook.credential).toBeUndefined();

    for (const text of [JSON.stringify(listed), JSON.stringify(patched)]) expect(text).not.toContain('route-secret-token');
    expect((await one.DELETE(req(`/${hook.id}`, 'DELETE'), ctx(hook.id))).status).toBe(200);
    expect((await one.GET(req(`/${hook.id}`, 'GET'), ctx(hook.id))).status).toBe(404);
    expect((await one.DELETE(req(`/${hook.id}`, 'DELETE'), ctx(hook.id))).status).toBe(404);
    expect(queryEvents({ action: ['mcp.policy_hook.create'] }, { limit: 10 }).events[0].actor.type).toBeDefined();
  });

  it('answer 400 for a bad body, a bad URL and a credential of another type', async () => {
    expect((await list.POST(req('', 'POST', { name: '', url }))).status).toBe(400);
    expect((await list.POST(req('', 'POST', { name: 'x', url: 'ftp://x', auth: 'none' }))).status).toBe(400);
    expect((await list.POST(req('', 'POST', { name: 'x', url, auth: 'none', surprise: 1 }))).status).toBe(400);
    expect((await list.POST(req('', 'POST', { name: 'x', url, auth: 'none', timeoutMs: 10 }))).status).toBe(400);
    const header = credentials.create({ name: 'Header', type: 'core.httpHeaderAuth', data: { name: 'x', value: 'y' } });
    expect((await list.POST(req('', 'POST', { name: 'x', url, credentialId: header.id }))).status).toBe(400);
  });

  it('send a sample request on Test, and report an unreachable service without auditing', async () => {
    const { hook } = await reads(await list.POST(req('', 'POST', { name: 'Tested', url, auth: 'none' })));
    reply = { decision: 'deny', reason: 'sample says no', ruleId: 'r9' };
    const answered = await reads(await test.POST(req(`/${hook.id}/test`, 'POST'), ctx(hook.id)));
    expect(answered).toMatchObject({ ok: true, decision: 'deny', reason: 'sample says no', ruleId: 'r9' });
    expect(answered.ms).toBeGreaterThanOrEqual(0);

    const moved = await one.PATCH(req(`/${hook.id}`, 'PATCH', { url: 'http://127.0.0.1:9/nothing' }), ctx(hook.id));
    expect(moved.status).toBe(200);
    const mcpEvents = () => queryEvents({}, { limit: 1000 }).events.filter((e) => e.action.startsWith('mcp.')).length;
    const before = mcpEvents();
    const down = await reads(await test.POST(req(`/${hook.id}/test`, 'POST'), ctx(hook.id)));
    expect(down.ok).toBe(false);
    expect(down.error).toEqual(expect.any(String));
    expect(queryEvents({ action: ['mcp.policy.failed', 'mcp.policy.denied'] }, { limit: 10 }).events).toEqual([]);
    expect(mcpEvents()).toBe(before); // a test is not a run: no MCP policy event
    expect((await test.POST(req('/nope/test', 'POST'), ctx('nope'))).status).toBe(404);
  });
});
