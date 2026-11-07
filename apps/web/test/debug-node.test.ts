/**
 * The one-node local override (docs/specs/19-debug-token.md; lib/server/debug-node/): a `runs:debug` token, minted over REST,
 * runs ONE node of a recorded execution against a plugin served on localhost, once, only while the owner's setting is on and
 * only at an allowed host; the result is tagged and not stored in the execution; every use is audited.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-debug-node-'));
const INSTANCE = 'http://localhost:3000';
const ENV: Record<string, string> = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_PUBLIC_URL: INSTANCE,
};
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
for (const key of ['LANDFLOW_OIDC_ISSUER', 'LANDFLOW_OIDC_DISCOVERY_URL', 'LANDFLOW_MCP_GATEWAY_SECRET']) delete process.env[key];

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { runWorkflow } = await import('@/lib/server/runner');
const { createUser } = await import('@/lib/server/auth/users');
const { createSession } = await import('@/lib/server/auth/sessions');
const { createTeamProject, setHomeProject, setMember } = await import('@/lib/server/projects/store');
const { setMcpEnabled } = await import('@/lib/server/mcp/instance');
const { closeMcpEndpoints } = await import('@/lib/server/mcp/server');
const { queryEvents } = await import('@/lib/server/audit/store');
const { guardRequest } = await import('@/lib/server/auth/guard');
const { isPublicPath } = await import('@/lib/shared/auth-paths');
const dbt = await import('@/lib/server/auth/debug-tokens');
const { normalizeAllowedHost, checkPluginUrl } = await import('@/lib/server/debug-node/settings');
const { demoPlugin, startDemoPlugin } = await import('./fixtures/debug-demo-plugin');
const mcpRoute = await import('@/app/api/mcp/route');
const mintRoute = await import('@/app/api/executions/[id]/debug-tokens/route');
const runRoute = await import('@/app/api/debug-node/route');
const settingsRoute = await import('@/app/api/settings/debug-node/route');

registry.registerBuiltin(corePlugin);
// The build "in production": it fails for a text with a digit.
registry.registerBuiltin(demoPlugin('buggy'));

const fixed = await startDemoPlugin({ variant: 'fixed' });
const buggyLocal = await startDemoPlugin({ variant: 'buggy' });

afterAll(async () => {
  await fixed.close();
  await buggyLocal.close();
  await closeMcpEndpoints();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Route = (r: Request, c?: unknown) => Promise<Response>;
const asRoute = (handler: unknown) => handler as Route;
const cookieOf = (user: Parameters<typeof createSession>[0]) => ({ cookie: `landflow_session=${createSession(user, 'password').token}`, 'content-type': 'application/json' });
const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
const link = (source: string, target: string) => ({ id: `${source}-${target}`, type: 'main' as const, source, target, sourceIndex: 0, targetIndex: 0 });

const CRED_SECRET = 'credential-secret-value-777';

describe('one-node local override', () => {
  let owner: Awaited<ReturnType<typeof createUser>>;
  let editor: Awaited<ReturnType<typeof createUser>>;
  let viewer: Awaited<ReturnType<typeof createUser>>;
  let exec = '';
  let other = '';

  const patchSettings = async (user: typeof owner, body: Record<string, unknown>) => {
    const response = await asRoute(settingsRoute.PATCH)(new Request(`${INSTANCE}/api/settings/debug-node`, { method: 'PATCH', headers: cookieOf(user), body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Json };
  };
  const mint = async (user: typeof owner, executionId: string, body: Record<string, unknown>) => {
    const response = await asRoute(mintRoute.POST)(new Request(`${INSTANCE}/api/executions/${executionId}/debug-tokens`, { method: 'POST', headers: cookieOf(user), body: JSON.stringify(body) }), { params: Promise.resolve({ id: executionId }) });
    return { status: response.status, body: (await response.json()) as Json };
  };
  const mintRun = (executionId = exec, body: Record<string, unknown> = {}) => mint(editor, executionId, { scopes: ['runs:debug'], node: 'Shout', ...body });
  const run = async (token: string | undefined, body: Record<string, unknown>) => {
    const response = await asRoute(runRoute.POST)(new Request(`${INSTANCE}/api/debug-node`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Json };
  };
  const audits = () => queryEvents({ actions: ['debug.node.run'] }, { limit: 500 }).events;

  it('records an execution that failed in a plugin node, in a project the editor can run', async () => {
    owner = await createUser({ email: 'owner@dbgnode.test', name: 'Owner', role: 'owner', password: 'owner-pass-123' });
    editor = await createUser({ email: 'editor@dbgnode.test', name: 'Editor', role: 'member', password: 'editor-pass-123' });
    viewer = await createUser({ email: 'viewer@dbgnode.test', name: 'Viewer', role: 'member', password: 'viewer-pass-123' });
    const project = createTeamProject({ name: 'Alpha', createdBy: owner.id });
    setMember(project.id, editor.id, 'editor');
    setMember(project.id, viewer.id, 'viewer');
    const cred = credentials.create({ name: 'Header auth', type: 'core.httpHeaderAuth', data: { name: 'X-Key', value: CRED_SECRET } });
    const flow = (id: string): Workflow => {
      setHomeProject('workflow', id, project.id);
      return store.saveWorkflow({
        id,
        name: id,
        nodes: [node('Start', 'core.manualTrigger'), node('Shout', 'debugdemo.shout', { suffix: '{{ $json.mark }}' }, { credentials: { 'core.httpHeaderAuth': { id: cred.id, name: cred.name } } })],
        connections: [link('Start', 'Shout')],
      } as Workflow);
    };
    const input = [{ json: { text: 'order 42', mark: '!!' } }];
    const ran = await runWorkflow({ workflow: flow('wf_dbgnode'), mode: 'manual', startNodeId: 'Shout', triggerItems: input });
    const ranOther = await runWorkflow({ workflow: flow('wf_dbgnode_2'), mode: 'manual', startNodeId: 'Shout', triggerItems: input });
    [exec, other] = [ran.executionId, ranOther.executionId];
    expect(ran.status).toBe('error');
    setMcpEnabled(true);
  });

  it('is off by default: no token can be minted and the route refuses', async () => {
    const minted = await mintRun();
    expect(minted.status).toBe(403);
    expect(minted.body.error).toMatch(/off/);
    expect((await run('lf_dbg_nope', { executionId: exec, node: 'Shout', pluginUrl: fixed.url })).status).toBe(401);
  });

  it('is turned on by an owner only, with allowed hosts of a safe shape', async () => {
    expect((await patchSettings(editor, { enabled: true })).status).toBe(403);
    for (const bad of ['*.example.com', '10.0.0.5', '169.254.169.254', 'http://localhost', 'user@host.dev', 'single', '[fe80::1]', 'evil.dev:99999']) {
      const refused = await patchSettings(owner, { allowedHosts: [bad] });
      expect(refused.status, bad).toBe(400);
    }
    const ok = await patchSettings(owner, { enabled: true, allowedHosts: ['127.0.0.1', 'Tunnel.Example.dev'] });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ enabled: true, allowedHosts: ['127.0.0.1', 'tunnel.example.dev'] });
    expect(normalizeAllowedHost('::1')).toBe('[::1]');
    expect(normalizeAllowedHost('localhost:7000')).toBe('localhost:7000');
  });

  it('checks plugin URLs against the list', () => {
    const settings = { enabled: true, allowedHosts: ['127.0.0.1', 'tunnel.example.dev', 'localhost:7000'] };
    expect(checkPluginUrl('http://127.0.0.1:9999', settings).ok).toBe(true);
    expect(checkPluginUrl('https://tunnel.example.dev/x', settings).ok).toBe(true);
    expect(checkPluginUrl('http://localhost:7000', settings).ok).toBe(true);
    for (const url of ['http://localhost:7001', 'http://169.254.169.254/latest', 'http://10.0.0.1', 'http://tunnel.example.dev.evil.com', 'http://user:pw@127.0.0.1', 'ftp://127.0.0.1', 'file:///etc/passwd', 'not a url']) {
      expect(checkPluginUrl(url, settings).ok, url).toBe(false);
    }
  });

  it('refuses scope mixing, a missing node, an unrun node, a viewer, and a node on a read token', async () => {
    expect((await mintRun(exec, { scopes: ['runs:debug', 'executions:read'] })).status).toBe(400);
    expect((await mintRun(exec, { scopes: ['runs:debug', 'trace:read'] })).body.error).toMatch(/together/);
    expect((await mint(editor, exec, { scopes: ['runs:debug'] })).status).toBe(400); // no node
    expect((await mintRun(exec, { node: 'Start' })).status).toBe(404); // the trigger did not run in this execution
    expect((await mintRun(exec, { node: 'Nope' })).status).toBe(404);
    expect((await mint(editor, exec, { node: 'Shout' })).status).toBe(400); // a node binds only runs:debug
    expect((await mint(viewer, exec, { scopes: ['runs:debug'], node: 'Shout' })).status).toBe(403); // can read, cannot run
    expect((await mintRun(exec, { ttlSeconds: 7200 })).status).toBe(400); // at most an hour
    expect(() => dbt.mintDebugToken(editor, { executionId: exec, workflowId: 'wf_dbgnode', scopes: ['runs:debug', 'trace:read'], node: { id: 'Shout', name: 'Shout' } })).toThrow(/together/);
  });

  it('runs the one node against the local plugin, tagged, with the recorded input and no credentials, and stores nothing', async () => {
    const minted = await mintRun();
    expect(minted.status).toBe(201);
    expect(minted.body.record).toMatchObject({ scopes: ['runs:debug'], nodeId: 'Shout', nodeName: 'Shout', executionId: exec });
    const ttl = Date.parse(minted.body.record.expiresAt) - Date.parse(minted.body.record.createdAt);
    expect(ttl).toBe(900_000);
    const token = minted.body.token as string;

    const before = JSON.stringify(store.getExecution(exec));
    const executions = store.listExecutions().length;
    const result = await run(token, { executionId: exec, node: 'Shout', pluginUrl: fixed.url });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ debugRun: true, status: 'success', node: 'Shout', inputItems: 1, outputItems: [1], output: [{ shouted: 'ORDER 42!!', build: 'fixed' }], recorded: { status: 'error' } });
    expect(result.body.notRecorded).toMatch(/not stored/);

    // The local plugin got the recorded input and the resolved parameter, and no credential.
    expect(fixed.seen).toEqual([{ parameters: '!!', items: [{ text: 'order 42', mark: '!!' }] }].map((s) => expect.objectContaining(s)));
    expect(JSON.stringify(fixed.seen)).not.toContain(CRED_SECRET);

    // Not written to the production execution, and no execution was made.
    expect(JSON.stringify(store.getExecution(exec))).toBe(before);
    expect(store.listExecutions().length).toBe(executions);

    // Audited, actor anonymous, minter in the details, the token nowhere.
    const events = audits().filter((e) => e.details?.debugId === minted.body.record.id);
    expect(events.map((e) => e.outcome)).toEqual(['success']);
    expect(events[0]).toMatchObject({ actor: { type: 'anonymous' }, details: { via: 'debug-token', mintedBy: editor.id, executionId: exec, node: 'Shout', pluginHost: new URL(fixed.url).host } });
    expect(JSON.stringify(events)).not.toContain(token);

    // Single use: the token is spent, and the list says so.
    const again = await run(token, { executionId: exec, node: 'Shout', pluginUrl: fixed.url });
    expect(again.status).toBe(401);
    expect(again.body.error).toMatch(/used/);
    expect(fixed.seen).toHaveLength(1);
    expect(dbt.getDebugToken(minted.body.record.id)?.uses).toBe(1);
    expect(audits().filter((e) => e.details?.debugId === minted.body.record.id).map((e) => e.outcome)).toEqual(expect.arrayContaining(['success', 'denied']));
  });

  it('is bound to its node and execution, and a refusal does not spend it', async () => {
    const minted = await mintRun();
    const token = minted.body.token as string;
    const seenBefore = fixed.seen.length;
    expect((await run(token, { executionId: exec, node: 'Start', pluginUrl: fixed.url })).status).toBe(403);
    expect((await run(token, { executionId: other, node: 'Shout', pluginUrl: fixed.url })).status).toBe(404);
    expect((await run(token, { executionId: 'ex_missing', node: 'Shout', pluginUrl: fixed.url })).status).toBe(404);
    expect(fixed.seen).toHaveLength(seenBefore);
    const denied = audits().filter((e) => e.details?.debugId === minted.body.record.id && e.outcome === 'denied');
    expect(denied.map((e) => e.details?.reason)).toEqual(expect.arrayContaining(['other node', 'other execution']));
    // Still unspent: the right call works.
    expect((await run(token, { executionId: exec, node: 'Shout', pluginUrl: fixed.url })).status).toBe(200);
  });

  it('calls only allowed hosts', async () => {
    const minted = await mintRun();
    const token = minted.body.token as string;
    for (const pluginUrl of ['http://localhost:' + fixed.port, 'http://169.254.169.254/latest/meta-data', 'http://10.1.2.3:80', 'http://tunnel.example.dev.attacker.test', 'file:///etc/passwd', 'nonsense']) {
      const refused = await run(token, { executionId: exec, node: 'Shout', pluginUrl });
      expect(refused.status, pluginUrl).toBe(403);
    }
    expect(audits().some((e) => e.details?.reason === 'plugin url')).toBe(true);
    // The token is still good for the allowed one; the plugin's own failure comes back as a debug result, and spends it too.
    const failed = await run(token, { executionId: exec, node: 'Shout', pluginUrl: buggyLocal.url });
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({ debugRun: true, status: 'error' });
    expect(failed.body.error.message).toMatch(/cannot handle digits/);
    expect((await run(token, { executionId: exec, node: 'Shout', pluginUrl: fixed.url })).status).toBe(401);
    // A reachable-but-wrong URL is a 502 debug result.
    const dead = await mintRun();
    const down = await run(dead.body.token, { executionId: exec, node: 'Shout', pluginUrl: 'http://127.0.0.1:1' });
    expect(down.status).toBe(502);
    expect(down.body).toMatchObject({ debugRun: true, status: 'error' });
  });

  it('stops when revoked, expired, or switched off, and a read token cannot run', async () => {
    const revoked = await mintRun();
    dbt.revokeDebugToken(revoked.body.record.id, owner.id);
    expect((await run(revoked.body.token, { executionId: exec, node: 'Shout', pluginUrl: fixed.url })).status).toBe(401);

    const expired = dbt.mintDebugToken(editor, { executionId: exec, workflowId: 'wf_dbgnode', scopes: ['runs:debug'], node: { id: 'Shout', name: 'Shout' } }, Date.now() - 2 * 3_600_000);
    expect((await run(expired.token, { executionId: exec, node: 'Shout', pluginUrl: fixed.url })).body.error).toMatch(/expired/);

    const reader = await mint(editor, exec, {});
    const readRun = await run(reader.body.token, { executionId: exec, node: 'Shout', pluginUrl: fixed.url });
    expect(readRun.status).toBe(403);
    expect(readRun.body.error).toMatch(/lacks/);

    const live = await mintRun();
    await patchSettings(owner, { enabled: false });
    const off = await run(live.body.token, { executionId: exec, node: 'Shout', pluginUrl: fixed.url });
    expect(off.status).toBe(403);
    expect(off.body.error).toMatch(/off/);
    await patchSettings(owner, { enabled: true });
    expect((await run(live.body.token, { executionId: exec, node: 'Shout', pluginUrl: fixed.url })).status).toBe(200);
  });

  it('is no other credential: not REST, not MCP tools', async () => {
    const minted = await mintRun();
    const token = minted.body.token as string;
    const rest = guardRequest(new Request(`${INSTANCE}/api/workflows`, { headers: { authorization: `Bearer ${token}` } }));
    expect(rest.ok).toBe(false);
    expect(isPublicPath('/api/debug-node')).toBe(true);
    const response = await asRoute(mcpRoute.POST)(new Request(`${INSTANCE}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_execution', arguments: { id: exec } } }) }));
    expect(await response.text()).toMatch(/lacks the|no longer valid|isError/);
    // The token is unspent after that.
    expect((await run(token, { executionId: exec, node: 'Shout', pluginUrl: fixed.url })).status).toBe(200);
  });
});
