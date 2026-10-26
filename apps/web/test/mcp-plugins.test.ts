/**
 * The host's per-plugin MCP endpoints (lib/server/mcp/plugin-servers.ts; docs/transports.md, docs/protocol.md §15.3):
 * - /api/mcp/plugins/<id> and /api/mcp/plugins/core answer 2026-07-28 clients (server/discover, the _meta envelope,
 *   subscriptions/listen) and 2025-11-25 clients (initialize) with the tools of the plugin's manifest, filtered by the
 *   caller's grants; an unexposed or unknown plugin is 404; callers are API keys, the gateway secret with the caller
 *   headers, or nothing (401);
 * - a tools/call runs as an execution with mode `mcp` (the caller and the tool on the record, the arguments as the
 *   node's input, the output items as structuredContent), fails as an error result, and is audited (`mcp.tool.call`);
 * - credentials come from the grant, from the call's `_meta["dev.landflow/node"]`, or from the caller's own, and only
 *   ones the caller may use;
 * - "Expose to agents": PATCH /api/plugins/:id { mcp: { exposed } }, GET /api/mcp/tools, the `core` endpoint's
 *   tools/list_changed to subscriptions/listen streams when the registry (or an exposure) changes.
 * The test plugin runs over HTTP on 7480 (stream T2-E's range), so calls go through the registry's client path.
 */
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { defineCredentialType, defineNode, definePlugin } from '@landflow/sdk';
import type { McpToolsResponse } from '@/lib/shared/mcp';
import type { PluginSummary } from '@/lib/shared/types';

vi.setConfig({ testTimeout: 20_000 });
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-mcp-plugins-'));
const GATEWAY_SECRET = 'test-gateway-secret-0123456789';
const ENV = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_PUBLIC_URL: 'http://mcp.test',
  LANDFLOW_ENCRYPTION_KEY: 'mcp-plugins-test-key',
  LANDFLOW_MCP_GATEWAY_SECRET: GATEWAY_SECRET,
};
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
delete process.env.LANDFLOW_OIDC_ISSUER;

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { createUser } = await import('@/lib/server/auth/users');
const { createApiKey } = await import('@/lib/server/auth/api-keys');
const { createGrant, deleteGrant } = await import('@/lib/server/mcp/grants');
const { issueMcpToken } = await import('@/lib/server/mcp/tokens');
const { mcpExposure } = await import('@/lib/server/mcp/exposure');
const { closeMcpEndpoints } = await import('@/lib/server/mcp/server');
const { startListChangedRelay, exposedTools, mcpWorkflowId } = await import('@/lib/server/mcp/plugin-servers');
const { createTeamProject, ensurePersonalProject, setHomeProject } = await import('@/lib/server/projects/store');
const { queryEvents } = await import('@/lib/server/audit/store');
const { serveHttp } = await import('@landflow/sdk/http');
const pluginRoute = await import('@/app/api/mcp/plugins/[id]/route');
const toolsRoute = await import('@/app/api/mcp/tools/route');
const pluginsRoute = await import('@/app/api/plugins/[id]/route');

registry.registerBuiltin(corePlugin);

// ---------------------------------------------------------------------------
// A plugin over HTTP: one node with resource × operation, one that needs a credential
// ---------------------------------------------------------------------------

const PLUGIN_ID = 'tp-mcp';
const HTTP_PORT = 7480;
const CREDENTIAL_TYPE = `${PLUGIN_ID}.demoApi`;

const notes = defineNode({
  description: {
    name: 'notes',
    displayName: 'Notes',
    description: 'A notebook',
    version: 1,
    kind: 'action',
    usableAsTool: true,
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    properties: [
      { name: 'resource', displayName: 'Resource', type: 'options', default: 'note', options: [{ name: 'Note', value: 'note' }] },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        default: 'create',
        displayOptions: { show: { resource: ['note'] } },
        options: [
          { name: 'Create', value: 'create', action: 'Create a note' },
          { name: 'Get', value: 'get', action: 'Get a note' },
          { name: 'Delete', value: 'delete', action: 'Delete a note', mcp: false },
        ],
      },
      { name: 'title', displayName: 'Title', type: 'string', default: '', required: true, displayOptions: { show: { operation: ['create'] } } },
      { name: 'id', displayName: 'Id', type: 'string', default: '', displayOptions: { show: { operation: ['get'] } } },
    ],
  },
  execute: (ctx) => {
    const operation = ctx.getNodeParameter<string>('operation');
    if (operation === 'get' && ctx.getNodeParameter<string>('id') === 'missing') throw new Error('No such note');
    return ctx.getInputData().map((item) => ({ json: { ok: true, operation, title: ctx.getNodeParameter<string>('title', 0, ''), input: item.json } }));
  },
});

const secret = defineNode({
  description: {
    name: 'secret',
    displayName: 'Secret',
    description: 'Echoes the bound credential',
    version: 1,
    kind: 'action',
    usableAsTool: true,
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'demoApi', required: true }],
    properties: [],
  },
  execute: async (ctx) => {
    const data = await ctx.getCredentials<{ token: string }>('demoApi');
    return [{ json: { token: data?.token } }];
  },
});

const plugin = definePlugin({
  info: { id: PLUGIN_ID, name: 'MCP test plugin', version: '1.2.3' },
  nodes: [notes, secret],
  credentialTypes: [defineCredentialType({ name: 'demoApi', displayName: 'Demo API', properties: [{ name: 'token', displayName: 'Token', type: 'string', required: true, typeOptions: { password: true } }] })],
});

let httpPlugin: Server;
let admin: Awaited<ReturnType<typeof createUser>>;
let member: Awaited<ReturnType<typeof createUser>>;
let adminKey = '';
let memberKey = '';

beforeAll(async () => {
  httpPlugin = await serveHttp(plugin, { port: HTTP_PORT, host: '127.0.0.1' });
  await registry.addEndpoint(`http://127.0.0.1:${HTTP_PORT}`, 'static');
  admin = await createUser({ email: 'ada@mcp.test', name: 'Ada Admin', role: 'admin', password: 'admin-password-1' });
  member = await createUser({ email: 'mo@mcp.test', name: 'Mo Member', role: 'member', password: 'member-password-1' });
  adminKey = createApiKey(admin, { label: 'admin', scopes: ['admin'] }).token;
  memberKey = createApiKey(member, { label: 'member', scopes: ['admin'] }).token;
});

afterAll(async () => {
  startListChangedRelay()();
  await closeMcpEndpoints();
  await new Promise<void>((resolve) => httpPlugin.close(() => resolve()));
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

// ---------------------------------------------------------------------------
// Helpers: the route as a fetch, v2 clients of both eras, raw requests
// ---------------------------------------------------------------------------

type Handler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
const route = pluginRoute as unknown as { GET: Handler; POST: Handler; DELETE: Handler };
const url = (id: string) => `http://mcp.test/api/mcp/plugins/${id}`;

function routeFetch(statuses: number[] = []) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const id = decodeURIComponent(new URL(request.url).pathname.split('/').pop()!);
    const response = await route[request.method as 'GET' | 'POST' | 'DELETE'](request, { params: Promise.resolve({ id }) });
    statuses.push(response.status);
    return response;
  };
}

async function connect(id: string, headers: Record<string, string>, mode: 'auto' | 'legacy' = 'auto') {
  const client = new Client({ name: 'agent', version: '1.0.0' }, { versionNegotiation: { mode } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url(id)), { fetch: routeFetch(), requestInit: { headers } }));
  return client;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const gateway = (subject?: string) => ({ 'x-landflow-gateway': GATEWAY_SECRET, 'x-landflow-caller-iss': 'http://mcp.test', ...(subject && { 'x-landflow-caller-sub': subject }) });

const text = (result: CallToolResult) =>
  result.content
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text: string }).text)
    .join('');

const MODERN_META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };

/** A raw JSON-RPC POST: 2026-07-28 (the envelope and the standard headers) or 2025-11-25 (plain). */
function raw(id: string, method: string, params: Record<string, unknown>, headers: Record<string, string>, era: 'modern' | 'legacy' = 'modern') {
  const body = { jsonrpc: '2.0', id: 1, method, params: era === 'modern' ? { ...params, _meta: MODERN_META } : params };
  return route.POST(
    new Request(url(id), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(era === 'modern' && { 'mcp-protocol-version': '2026-07-28', 'mcp-method': method }), ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

const executions = () => store.listExecutions({ workflowId: mcpWorkflowId(PLUGIN_ID) });

// ---------------------------------------------------------------------------
// Tools and both protocol eras
// ---------------------------------------------------------------------------

describe('per-plugin MCP endpoints', () => {
  it('needs a credential (401 with a bearer challenge), and knows only installed, exposed plugins (404)', async () => {
    const anonymous = await raw(PLUGIN_ID, 'tools/list', {}, {});
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toMatch(/^Bearer resource_metadata=/);
    expect((await raw(PLUGIN_ID, 'tools/list', {}, { 'x-landflow-gateway': 'wrong-secret' })).status).toBe(401);
    expect((await raw('nope', 'tools/list', {}, bearer(adminKey))).status).toBe(404);
  });

  it('lists the manifest’s tools to an admin, in both eras, and the gateway’s per-plugin names in the tool browser', async () => {
    const client = await connect(PLUGIN_ID, bearer(adminKey));
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect(client.getServerVersion()).toMatchObject({ name: `landflow-${PLUGIN_ID}`, title: 'MCP test plugin', version: '1.2.3' });
    const { tools } = await client.listTools();
    // One tool per operation; `delete` opted out with mcp: false; the credential is never an argument.
    expect(tools.map((t) => t.name)).toEqual(['notes_note_create', 'notes_note_get', 'secret']);
    expect(tools[0]).toMatchObject({ title: 'Notes · Note · Create', description: expect.stringMatching(/^Create a note\./), annotations: { readOnlyHint: false, openWorldHint: true } });
    expect(tools[0].inputSchema).toMatchObject({ type: 'object', properties: { title: { type: 'string' } }, required: ['title'] });
    expect(tools[0].inputSchema.properties).not.toHaveProperty('operation');
    expect(tools[1].annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(tools[2].inputSchema.properties ?? {}).not.toHaveProperty('demoApi');
    expect(JSON.stringify(tools)).not.toContain('dev.landflow/node');
    await client.close();

    const older = await connect(PLUGIN_ID, bearer(adminKey), 'legacy');
    expect(older.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    expect((await older.listTools()).tools.map((t) => t.name)).toEqual(['notes_note_create', 'notes_note_get', 'secret']);
    await older.close();

    const core = await connect('core', bearer(adminKey));
    const coreTools = (await core.listTools()).tools.map((t) => t.name);
    expect(coreTools).toContain('httpRequest');
    expect(coreTools).toContain('executeWorkflow');
    expect(core.getInstructions()).toMatch(/built-in nodes/);
    await core.close();

    const browser = (await (await toolsRoute.GET(new Request('http://mcp.test/api/mcp/tools'))).json()) as McpToolsResponse;
    const mine = browser.tools.filter((t) => t.pluginId === PLUGIN_ID);
    expect(mine.map((t) => t.gatewayName)).toEqual(['tp-mcp_notes_note_create', 'tp-mcp_notes_note_get', 'tp-mcp_secret']);
    expect(mine[2]).toMatchObject({ credentials: [CREDENTIAL_TYPE], nodeType: `${PLUGIN_ID}.secret`, online: true });
    expect(browser.plugins).toContainEqual({ id: PLUGIN_ID, name: 'MCP test plugin', path: `/api/mcp/plugins/${PLUGIN_ID}`, tools: 3, online: true });
    expect(browser.plugins.some((p) => p.id === 'core')).toBe(true);
  });

  it('answers raw 2026-07-28 and 2025-11-25 requests', async () => {
    const discover = await raw(PLUGIN_ID, 'server/discover', {}, bearer(adminKey));
    expect(discover.status).toBe(200);
    const discovered = (await discover.json()) as { result: { supportedVersions: string[]; capabilities: unknown; cacheScope: string } };
    expect(discovered.result.supportedVersions).toContain('2026-07-28');
    expect(discovered.result.capabilities).toMatchObject({ tools: { listChanged: true } });

    const list = (await (await raw(PLUGIN_ID, 'tools/list', {}, bearer(adminKey))).json()) as { result: { tools: Array<{ name: string }>; cacheScope: string; ttlMs: number } };
    expect(list.result).toMatchObject({ cacheScope: 'private', ttlMs: 0 });
    expect(list.result.tools).toHaveLength(3);

    const init = await raw(PLUGIN_ID, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '1' } }, bearer(adminKey), 'legacy');
    expect(init.status).toBe(200);
    expect(init.headers.get('content-type')).toMatch(/application\/json/);
    expect(init.headers.get('mcp-session-id')).toBeNull();
    expect((await init.json()) as object).toMatchObject({ result: { protocolVersion: '2025-11-25', serverInfo: { name: `landflow-${PLUGIN_ID}` } } });
    expect((await route.GET(new Request(url(PLUGIN_ID), { headers: bearer(adminKey) }), { params: Promise.resolve({ id: PLUGIN_ID }) })).status).toBe(405);
  });

  it('shows a member only what a grant allows, and refuses calls without one', async () => {
    const none = await connect(PLUGIN_ID, bearer(memberKey));
    expect((await none.listTools()).tools).toEqual([]);
    await expect(none.callTool({ name: 'notes_note_create', arguments: { title: 'x' } })).rejects.toThrow(/Unknown tool/);
    await none.close();

    const grant = createGrant({ subject: { kind: 'user', id: member.id }, pluginId: PLUGIN_ID, tools: ['notes_note_get'] }, admin.id);
    const some = await connect(PLUGIN_ID, bearer(memberKey));
    expect((await some.listTools()).tools.map((t) => t.name)).toEqual(['notes_note_get']);
    await some.close();
    deleteGrant(grant.id);

    // An admin sees everything in the browser, but calling still takes a grant.
    const all = await connect(PLUGIN_ID, bearer(adminKey));
    const refused = (await all.callTool({ name: 'notes_note_create', arguments: { title: 'x' } })) as CallToolResult;
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/no grant/);
    await all.close();
  });
});

// ---------------------------------------------------------------------------
// Calls as executions
// ---------------------------------------------------------------------------

describe('tools/call', () => {
  let grantId = '';
  beforeAll(() => {
    grantId = createGrant({ subject: { kind: 'user', id: admin.id }, pluginId: PLUGIN_ID, tools: '*' }, admin.id).id;
  });
  afterAll(() => deleteGrant(grantId));

  it('runs the node as an execution with mode mcp, with the caller and the tool on the record, and returns structured output', async () => {
    const before = executions().length;
    const client = await connect(PLUGIN_ID, bearer(adminKey));
    const result = (await client.callTool({ name: 'notes_note_create', arguments: { title: 'Hello', extra: 'ignored' } })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ items: [{ ok: true, operation: 'create', title: 'Hello', input: { title: 'Hello', extra: 'ignored' } }] });
    expect(JSON.parse(text(result))).toEqual([{ ok: true, operation: 'create', title: 'Hello', input: { title: 'Hello', extra: 'ignored' } }]);
    const executionId = (result._meta as { 'dev.landflow/execution': { id: string; url: string } })['dev.landflow/execution'].id;
    expect((result._meta as { 'dev.landflow/execution': { url: string } })['dev.landflow/execution'].url).toBe(`http://mcp.test/workflows/${mcpWorkflowId(PLUGIN_ID)}/executions/${executionId}`);

    const list = executions();
    expect(list).toHaveLength(before + 1);
    expect(list[0]).toMatchObject({ id: executionId, mode: 'mcp', status: 'success', workflowName: 'MCP test plugin · MCP', mcp: { tool: 'notes_note_create', caller: `apiKey:${admin.id}` } });
    const record = store.getExecution(executionId)!;
    expect(record.mcp).toEqual({ pluginId: PLUGIN_ID, tool: 'notes_note_create', caller: `apiKey:${admin.id}`, userId: admin.id });
    expect(record.workflow?.nodes[0]).toMatchObject({ type: `${PLUGIN_ID}.notes`, parameters: { resource: 'note', operation: 'create', title: 'Hello' } });
    const run = record.runData.tool[0];
    expect(run.inputs[0][0].json).toEqual({ title: 'Hello', extra: 'ignored' });
    expect(run.outputs[0][0].json).toMatchObject({ ok: true });

    const audit = queryEvents({ actions: ['mcp.tool.call'] }).events.find((e) => e.details?.executionId === executionId)!;
    expect(audit).toMatchObject({ outcome: 'success', actor: { type: 'user', id: admin.id }, target: { type: 'plugin', id: PLUGIN_ID }, details: { tool: 'notes_note_create', gatewayTool: 'tp-mcp_notes_note_create', caller: `apiKey:${admin.id}`, callerKind: 'apiKey', viaGateway: false } });
    expect(JSON.stringify(audit.details)).not.toContain('Hello');
    await client.close();
  });

  it('returns a failed run as an error result naming the execution, and 2025-era clients get the same', async () => {
    const client = await connect(PLUGIN_ID, bearer(adminKey), 'legacy');
    const result = (await client.callTool({ name: 'notes_note_get', arguments: { id: 'missing' } })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/No such note.*\(execution ex_/);
    expect(executions()[0]).toMatchObject({ mode: 'mcp', status: 'error', mcp: { tool: 'notes_note_get' } });
    const ok = (await client.callTool({ name: 'notes_note_get', arguments: { id: 'n1' } })) as CallToolResult;
    expect(ok.structuredContent).toEqual({ items: [{ ok: true, operation: 'get', title: '', input: { id: 'n1' } }] });
    await client.close();
  });

  it('binds credentials: the grant’s, the call’s _meta, or the caller’s own; never one the caller may not use', async () => {
    // The member's own credential (in their personal project), and one in a team the member isn't in.
    const shared = credentials.create({ name: 'Demo shared', type: CREDENTIAL_TYPE, data: { token: 'tok-shared' } });
    setHomeProject('credential', shared.id, ensurePersonalProject(member.id)!);
    const adminOnly = credentials.create({ name: 'Demo private', type: CREDENTIAL_TYPE, data: { token: 'tok-private' } });
    const team = createTeamProject({ name: 'Secret team', createdBy: admin.id });
    setHomeProject('credential', adminOnly.id, team.id);
    const wrongType = credentials.create({ name: 'Not a demo', type: 'core.httpBearerAuth', data: { token: 'x' } });

    // The member's grant binds the private credential: the agent uses it without ever seeing it.
    const bound = createGrant({ subject: { kind: 'user', id: member.id }, pluginId: PLUGIN_ID, tools: ['secret'], credentials: { [CREDENTIAL_TYPE]: adminOnly.id } }, admin.id);
    const client = await connect(PLUGIN_ID, bearer(memberKey));
    expect((await client.callTool({ name: 'secret', arguments: {} })).structuredContent).toEqual({ items: [{ token: 'tok-private' }] });
    const record = store.getExecution(executions()[0].id)!;
    expect(record.workflow?.nodes[0].credentials).toEqual({ demoApi: { id: adminOnly.id, name: 'Demo private' } });
    // The secret never travels as an argument: only the node (through the vault) saw it.
    expect(JSON.stringify(record.workflow?.nodes[0].parameters)).not.toContain('tok-private');
    expect(JSON.stringify(record.runData.tool[0].inputs)).not.toContain('tok-private');
    await client.close();
    deleteGrant(bound.id);

    // Without a bound credential: the caller's own (the shared one in the default project), or the one _meta names.
    const plain = createGrant({ subject: { kind: 'user', id: member.id }, pluginId: PLUGIN_ID, tools: ['secret'] }, admin.id);
    const own = await connect(PLUGIN_ID, bearer(memberKey));
    const ownResult = (await own.callTool({ name: 'secret', arguments: {} })) as CallToolResult;
    expect(ownResult.isError, text(ownResult)).toBeFalsy();
    expect(ownResult.structuredContent).toEqual({ items: [{ token: 'tok-shared' }] });
    const named = (await own.callTool({ name: 'secret', arguments: {}, _meta: { 'dev.landflow/node': { credentials: { [CREDENTIAL_TYPE]: adminOnly.id } } } })) as CallToolResult;
    expect(named.isError).toBe(true);
    expect(text(named)).toMatch(/not available to apiKey:/);
    const mistyped = (await own.callTool({ name: 'secret', arguments: {}, _meta: { 'dev.landflow/node': { credentials: { demoApi: wrongType.id } } } })) as CallToolResult;
    expect(text(mistyped)).toMatch(/is a core\.httpBearerAuth, not a tp-mcp\.demoApi/);
    await own.close();
    deleteGrant(plain.id);

    // An admin may use the team's credential by naming it.
    const asAdmin = await connect(PLUGIN_ID, bearer(adminKey));
    const picked = (await asAdmin.callTool({ name: 'secret', arguments: {}, _meta: { 'dev.landflow/node': { credentials: { demoApi: adminOnly.id } } } })) as CallToolResult;
    expect(picked.structuredContent).toEqual({ items: [{ token: 'tok-private' }] });
    await asAdmin.close();
  });

  it('accepts the gateway’s secret with the identity it validated, and gives an anonymous gateway caller no tools', async () => {
    await issueMcpToken(admin, { label: 'agent' });
    const client = await connect(PLUGIN_ID, gateway(admin.id));
    expect((await client.listTools()).tools).toHaveLength(3);
    const result = (await client.callTool({ name: 'notes_note_create', arguments: { title: 'via gateway' } })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(executions()[0]).toMatchObject({ mode: 'mcp', mcp: { caller: `gateway:${admin.id}` } });
    await client.close();

    const anonymous = await connect(PLUGIN_ID, gateway());
    expect((await anonymous.listTools()).tools).toEqual([]);
    await anonymous.close();
  });
});

// ---------------------------------------------------------------------------
// Expose to agents, and tools/list_changed
// ---------------------------------------------------------------------------

describe('Expose to agents', () => {
  it('is on by default, switches off through PATCH /api/plugins/:id (audited), and hides the plugin everywhere', async () => {
    const summary = () => registry.list().find((p) => p.id === PLUGIN_ID)!;
    expect(summary().mcp).toEqual({ exposed: true, tools: 3, path: `/api/mcp/plugins/${PLUGIN_ID}` });

    const patch = (exposed: boolean) =>
      pluginsRoute.PATCH(new Request(`http://mcp.test/api/plugins/${PLUGIN_ID}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mcp: { exposed } }) }), { params: Promise.resolve({ id: PLUGIN_ID }) });
    const off = (await (await patch(false)).json()) as { plugins: PluginSummary[] };
    expect(off.plugins.find((p) => p.id === PLUGIN_ID)?.mcp).toMatchObject({ exposed: false });
    expect(mcpExposure.isExposed(PLUGIN_ID)).toBe(false);
    expect((await raw(PLUGIN_ID, 'tools/list', {}, bearer(adminKey))).status).toBe(404);
    expect(exposedTools().plugins.some((p) => p.id === PLUGIN_ID)).toBe(false);
    expect(queryEvents({ actions: ['plugin.mcp_exposure'] }).events[0]).toMatchObject({ target: { type: 'plugin', id: PLUGIN_ID }, details: { exposed: false } });

    const on = (await (await patch(true)).json()) as { plugins: PluginSummary[] };
    expect(on.plugins.find((p) => p.id === PLUGIN_ID)?.mcp).toMatchObject({ exposed: true });
    expect((await raw(PLUGIN_ID, 'tools/list', {}, bearer(adminKey))).status).toBe(200);
    // Core is exposed too, and nothing else is stored for the default.
    expect(summary().mcp?.exposed).toBe(true);
    expect(registry.list().find((p) => p.id === 'core')?.mcp?.exposed).toBe(true);
  });

  it('tells subscriptions/listen streams of the core endpoint (and the plugin’s own) when the registry or an exposure changes', async () => {
    startListChangedRelay();
    const listen = async (id: string) => {
      const response = await raw(id, 'subscriptions/listen', { notifications: { toolsListChanged: true } }, bearer(adminKey));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
      const reader = response.body!.getReader();
      const frames: string[] = [];
      const decoder = new TextDecoder();
      const pump = (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          frames.push(decoder.decode(value));
        }
      })();
      const until = (pattern: RegExp, ms = 3_000) =>
        vi.waitFor(
          () => {
            expect(frames.join('')).toMatch(pattern);
          },
          { timeout: ms, interval: 25 },
        );
      return { frames, until, close: () => reader.cancel().then(() => pump).catch(() => {}) };
    };
    const core = await listen('core');
    const own = await listen(PLUGIN_ID);
    await core.until(/notifications\/subscriptions\/acknowledged/);
    await own.until(/notifications\/subscriptions\/acknowledged/);

    // An exposure change is a registry event: both streams hear it.
    mcpExposure.set(PLUGIN_ID, false, { pluginName: 'MCP test plugin' });
    await core.until(/notifications\/tools\/list_changed/);
    await own.until(/notifications\/tools\/list_changed/);
    mcpExposure.set(PLUGIN_ID, true);

    // A manifest re-pull of the plugin: the core endpoint relays it too.
    const coreBefore = core.frames.join('').split('tools/list_changed').length;
    await registry.addEndpoint(`http://127.0.0.1:${HTTP_PORT}`, 'static');
    await vi.waitFor(() => expect(core.frames.join('').split('tools/list_changed').length).toBeGreaterThan(coreBefore), { timeout: 3_000, interval: 25 });
    await core.close();
    await own.close();
  });
});
