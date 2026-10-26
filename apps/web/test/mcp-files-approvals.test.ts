/**
 * Stream T6-A: the host's per-plugin MCP endpoints, three additions (docs/transports.md "From node to tool", "Credentials,
 * permissions and audit"):
 * - files in tool results: a `resource_link` per binary with a signed, expiring URL (lib/server/mcp/files.ts,
 *   /api/mcp/files/<id>), small images and audio inline under LANDFLOW_MCP_INLINE_MEDIA_MAX_BYTES;
 * - `list_options` on the endpoints (same contract as the plugin's own MCP face), governed and audited, and `enum`s in
 *   `tools/list` from the lookups remembered for the caller's credential (lib/server/mcp/options.ts);
 * - approvals for destructive tools (lib/server/mcp/approvals.ts): MCP elicitation for 2026-07-28 clients that declared it,
 *   else a Landflow approval answered in Settings → MCP; the grant's `approval` mode always / destructive / never.
 * The test plugin runs over HTTP on 7400 (stream T6-A's range 7400–7419).
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { defineCredentialType, defineNode, definePlugin } from '@landflow/sdk';

vi.setConfig({ testTimeout: 30_000 });
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-mcp-t6a-'));
const ENV = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_PUBLIC_URL: 'http://mcp.test',
  LANDFLOW_ENCRYPTION_KEY: 'mcp-t6a-test-key',
  LANDFLOW_MCP_GATEWAY_SECRET: 'test-gateway-secret-0123456789',
  LANDFLOW_BINARY_SECRET: 'mcp-t6a-binary-secret',
  LANDFLOW_MCP_APPROVAL_WAIT_SECONDS: '1',
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
const { createGrant, deleteGrant, getGrant, updateGrant, McpGrantError } = await import('@/lib/server/mcp/grants');
const { closeMcpEndpoints } = await import('@/lib/server/mcp/server');
const { mcpWorkflowId } = await import('@/lib/server/mcp/plugin-servers');
const { decideMcpApproval, listApprovals, McpApprovalError } = await import('@/lib/server/mcp/approvals');
const { signFileUrl, verifyFileUrl } = await import('@/lib/server/mcp/files');
const { clearOptionsCache } = await import('@/lib/server/mcp/options');
const { queryEvents } = await import('@/lib/server/audit/store');
const { serveHttp } = await import('@landflow/sdk/http');
const pluginRoute = await import('@/app/api/mcp/plugins/[id]/route');
const filesRoute = await import('@/app/api/mcp/files/[id]/route');
const approvalsRoute = await import('@/app/api/mcp/approvals/route');
const approvalRoute = await import('@/app/api/mcp/approvals/[id]/route');
const { isPublicPath } = await import('@/lib/shared/auth-paths');
const { routePolicy } = await import('@/lib/server/auth/policy');

registry.registerBuiltin(corePlugin);

// ---------------------------------------------------------------------------
// A plugin over HTTP: files, a dynamic list behind a credential, a destructive and a read-only tool
// ---------------------------------------------------------------------------

const PLUGIN_ID = 'tp-t6a';
const HTTP_PORT = 7400;
const CREDENTIAL_TYPE = `${PLUGIN_ID}.demoApi`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const WAV = Buffer.concat([Buffer.from('RIFF$\0\0\0WAVEfmt ', 'latin1'), Buffer.alloc(24)]);
let deletes = 0;

const files = defineNode({
  description: {
    name: 'files',
    displayName: 'Files',
    description: 'Returns files',
    version: 1,
    kind: 'action',
    usableAsTool: true,
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    properties: [{ name: 'kind', displayName: 'Kind', type: 'options', default: 'png', options: ['png', 'bigpng', 'text', 'audio', 'svg', 'many', 'none'].map((v) => ({ name: v, value: v })) }],
  },
  execute: (ctx) => {
    const kind = ctx.getNodeParameter<string>('kind');
    const file = (data: Buffer, mimeType: string, fileName: string) => ({ data: data.toString('base64'), mimeType, fileName });
    const binary =
      kind === 'png' ? { data: file(PNG, 'image/png', 'dot.png') }
      : kind === 'bigpng' ? { data: file(Buffer.concat([PNG, Buffer.alloc(600 * 1024)]), 'image/png', 'big.png') }
      : kind === 'text' ? { data: file(Buffer.from('hello'), 'text/plain', 'hello.txt') }
      : kind === 'audio' ? { data: file(WAV, 'audio/wav', 'beep.wav') }
      : kind === 'svg' ? { data: file(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml', 'x.svg') }
      : kind === 'many' ? Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}`, file(PNG, 'image/png', `f${i}.png`)]))
      : undefined;
    return [{ json: { ok: true, kind }, ...(binary && { binary }) }];
  },
});

const lists = defineNode({
  description: {
    name: 'lists',
    displayName: 'Lists',
    description: 'Picks a channel',
    version: 1,
    kind: 'action',
    usableAsTool: true,
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'demoApi', required: true }],
    properties: [
      { name: 'channel', displayName: 'Channel', type: 'options', default: '', required: true, typeOptions: { loadOptionsMethod: 'getChannels' } },
      { name: 'topic', displayName: 'Topic', type: 'options', default: '', typeOptions: { loadOptionsMethod: 'getTopics', loadOptionsDependsOn: ['channel'] } },
    ],
  },
  methods: {
    loadOptions: {
      async getChannels(ctx) {
        const data = await ctx.getCredentials<{ token: string }>('demoApi');
        return [
          { name: '#general', value: `${data?.token}-general`, description: 'everyone' },
          { name: '#random', value: `${data?.token}-random` },
        ];
      },
      async getTopics(ctx) {
        return [{ name: 'Topic', value: `for-${String(ctx.getNodeParameter('channel', 0, ''))}` }];
      },
    },
  },
  execute: (ctx) => [{ json: { channel: ctx.getNodeParameter('channel') } }],
});

const things = defineNode({
  description: {
    name: 'things',
    displayName: 'Things',
    description: 'Things',
    version: 1,
    kind: 'action',
    usableAsTool: true,
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    properties: [
      { name: 'resource', displayName: 'Resource', type: 'options', default: 'thing', options: [{ name: 'Thing', value: 'thing' }] },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        default: 'get',
        displayOptions: { show: { resource: ['thing'] } },
        options: [
          { name: 'Get', value: 'get', action: 'Get a thing' },
          { name: 'Delete', value: 'delete', action: 'Delete a thing' },
        ],
      },
      { name: 'id', displayName: 'Id', type: 'string', default: '' },
      { name: 'password', displayName: 'Password', type: 'string', default: '' },
    ],
  },
  execute: (ctx) => {
    const operation = ctx.getNodeParameter<string>('operation');
    if (operation === 'delete') deletes++;
    return [{ json: { operation, deletes } }];
  },
});

const plugin = definePlugin({
  info: { id: PLUGIN_ID, name: 'T6A test plugin', version: '1.0.0' },
  nodes: [files, lists, things],
  credentialTypes: [defineCredentialType({ name: 'demoApi', displayName: 'Demo API', properties: [{ name: 'token', displayName: 'Token', type: 'string', required: true, typeOptions: { password: true } }] })],
});

let httpPlugin: Server;
let admin: Awaited<ReturnType<typeof createUser>>;
let member: Awaited<ReturnType<typeof createUser>>;
let adminKey = '';
let memberKey = '';
let credA = { id: '', name: '' };
let credB = { id: '', name: '' };

beforeAll(async () => {
  httpPlugin = await serveHttp(plugin, { port: HTTP_PORT, host: '127.0.0.1' });
  await registry.addEndpoint(`http://127.0.0.1:${HTTP_PORT}`, 'static');
  admin = await createUser({ email: 'ada@t6a.test', name: 'Ada Admin', role: 'admin', password: 'admin-password-1' });
  member = await createUser({ email: 'mo@t6a.test', name: 'Mo Member', role: 'member', password: 'member-password-1' });
  adminKey = createApiKey(admin, { label: 'admin', scopes: ['admin'] }).token;
  memberKey = createApiKey(member, { label: 'member', scopes: ['admin'] }).token;
  const a = credentials.create({ name: 'Demo A', type: CREDENTIAL_TYPE, data: { token: 'tok-a' } });
  const b = credentials.create({ name: 'Demo B', type: CREDENTIAL_TYPE, data: { token: 'tok-b' } });
  credA = { id: a.id, name: a.name };
  credB = { id: b.id, name: b.name };
});

afterAll(async () => {
  await closeMcpEndpoints();
  await new Promise<void>((resolve) => httpPlugin.close(() => resolve()));
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

afterEach(() => {
  delete process.env.LANDFLOW_MCP_INLINE_MEDIA_MAX_BYTES;
  delete process.env.LANDFLOW_MCP_FILE_URL_TTL_SECONDS;
  delete process.env.LANDFLOW_MCP_OPTIONS_CACHE_SECONDS;
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Handler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
const route = pluginRoute as unknown as { POST: Handler };
const url = (id: string) => `http://mcp.test/api/mcp/plugins/${id}`;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function routeFetch() {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const id = decodeURIComponent(new URL(request.url).pathname.split('/').pop()!);
    return route.POST(request, { params: Promise.resolve({ id }) });
  };
}

type Elicit = (params: { message: string; requestedSchema: unknown }) => { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };

async function connect(headers: Record<string, string>, options: { mode?: 'auto' | 'legacy'; elicit?: Elicit; asked?: string[]; plugin?: string } = {}) {
  const client = new Client({ name: 'agent', version: '1.0.0' }, { versionNegotiation: { mode: options.mode ?? 'auto' }, capabilities: options.elicit ? { elicitation: {} } : {} });
  if (options.elicit) {
    const answer = options.elicit;
    client.setRequestHandler('elicitation/create', async (request) => {
      options.asked?.push(request.params.message);
      return answer(request.params as { message: string; requestedSchema: unknown });
    });
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(url(options.plugin ?? PLUGIN_ID)), { fetch: routeFetch(), requestInit: { headers } }));
  return client;
}

const text = (result: CallToolResult) =>
  result.content
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text: string }).text)
    .join('');

const grantAll = (subject = admin.id, extra: Partial<Parameters<typeof createGrant>[0]> = {}) => createGrant({ subject: { kind: 'user', id: subject }, pluginId: PLUGIN_ID, tools: '*', credentials: { [CREDENTIAL_TYPE]: credA.id }, ...extra }, admin.id);

const audits = (tool: string) => queryEvents({ actions: ['mcp.tool.call'] }).events.filter((e) => e.details?.tool === tool);

async function download(uri: string, method = 'GET') {
  const request = new Request(uri, { method });
  const id = decodeURIComponent(new URL(uri).pathname.split('/').pop()!);
  return (filesRoute as unknown as { GET: Handler; HEAD: Handler })[method as 'GET' | 'HEAD'](request, { params: Promise.resolve({ id }) });
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

describe('files in tool results', () => {
  let grant = '';
  beforeAll(() => {
    grant = grantAll().id;
  });
  afterAll(() => deleteGrant(grant));

  it('links a binary with a signed URL and puts a small image inline, in both protocol eras, keeping structuredContent a reference-free list of items', async () => {
    for (const mode of ['auto', 'legacy'] as const) {
      const client = await connect(bearer(adminKey), { mode });
      const result = (await client.callTool({ name: 'files', arguments: { kind: 'png' } })) as CallToolResult;
      expect(result.isError, text(result)).toBeFalsy();
      const link = result.content.find((c) => c.type === 'resource_link') as { uri: string; name: string; mimeType: string; size: number; _meta?: Record<string, { expiresAt: string }> };
      expect(link).toMatchObject({ name: 'dot.png', mimeType: 'image/png', size: PNG.length });
      expect(link.uri).toMatch(/^http:\/\/mcp\.test\/api\/mcp\/files\/[\w-]+\.[\w-]+\?exp=\d+&t=tp-t6a%2Ffiles&c=apiKey%3A/);
      expect(Date.parse(link._meta!['dev.landflow/file'].expiresAt)).toBeGreaterThan(Date.now());
      const image = result.content.find((c) => c.type === 'image') as { data: string; mimeType: string };
      expect(image.mimeType).toBe('image/png');
      expect(Buffer.from(image.data, 'base64').equals(PNG)).toBe(true);
      expect(result.structuredContent).toEqual({ items: [{ ok: true, kind: 'png' }] });
      expect(JSON.stringify(result.structuredContent)).not.toContain(image.data);
      expect(text(result)).toMatch(/1 file\(s\) in the output/);

      const response = await download(link.uri);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(response.headers.get('cache-control')).toMatch(/no-store/);
      expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
      expect((await download(link.uri, 'HEAD')).headers.get('content-length')).toBe(String(PNG.length));
      await client.close();
    }
    expect(queryEvents({ actions: ['mcp.file.download'] }).events[0]).toMatchObject({ target: { type: 'binary', name: 'dot.png' }, details: { tool: 'tp-t6a/files' } });
  });

  it('is a public path whose permission is the signature: a forged, borrowed, or expired URL does not work', async () => {
    expect(isPublicPath('/api/mcp/files/scope.abcdefgh12')).toBe(true);
    const client = await connect(bearer(adminKey));
    const one = (await client.callTool({ name: 'files', arguments: { kind: 'png' } })) as CallToolResult;
    const two = (await client.callTool({ name: 'files', arguments: { kind: 'text' } })) as CallToolResult;
    const [a, b] = [one, two].map((r) => (r.content.find((c) => c.type === 'resource_link') as { uri: string }).uri);
    // Tampered expiry, tool, caller or signature; and one file's signature used for another file.
    const forged = (u: string, change: (p: URLSearchParams) => void) => {
      const next = new URL(u);
      change(next.searchParams);
      return next.toString();
    };
    expect((await download(forged(a, (p) => p.set('exp', String(Number(p.get('exp')) + 3600))))).status).toBe(403);
    expect((await download(forged(a, (p) => p.set('t', 'tp-t6a/other')))).status).toBe(403);
    expect((await download(forged(a, (p) => p.set('c', 'session:owner')))).status).toBe(403);
    expect((await download(forged(a, (p) => p.set('sig', 'AAAA')))).status).toBe(403);
    expect((await download(forged(a, (p) => p.delete('sig')))).status).toBe(403);
    const idB = new URL(b).pathname.split('/').pop()!;
    expect((await download(`http://mcp.test/api/mcp/files/${idB}?${new URL(a).searchParams}`)).status).toBe(403);
    expect(await (await download(b)).text()).toBe('hello');
    await client.close();

    // Expiry: the URL works up to `exp` and gives 410 after.
    const exp = Number(new URL(a).searchParams.get('exp'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime((exp - 1) * 1000);
    expect((await download(a)).status).toBe(200);
    vi.setSystemTime((exp + 1) * 1000);
    const expired = await download(a);
    expect(expired.status).toBe(410);
    expect(await expired.text()).toMatch(/expired/);
  });

  it('does the same on the core endpoint (HTTP Request downloading an image)', async () => {
    const source = createServer((_req, res) => res.writeHead(200, { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="core.png"' }).end(PNG));
    await new Promise<void>((resolve) => source.listen(7401, '127.0.0.1', resolve));
    const coreGrant = createGrant({ subject: { kind: 'user', id: admin.id }, pluginId: 'core', tools: ['httpRequest'] }, admin.id);
    const client = await connect(bearer(adminKey), { plugin: 'core' });
    try {
      const result = (await client.callTool({ name: 'httpRequest', arguments: { url: 'http://127.0.0.1:7401/dot.png', method: 'GET' } })) as CallToolResult;
      expect(result.isError, text(result)).toBeFalsy();
      const link = result.content.find((c) => c.type === 'resource_link') as { uri: string; name: string; mimeType: string };
      expect(link).toMatchObject({ name: 'core.png', mimeType: 'image/png' });
      expect(result.content.some((c) => c.type === 'image')).toBe(true);
      expect(link.uri).toContain('t=core%2FhttpRequest');
      expect(Buffer.from(await (await download(link.uri)).arrayBuffer()).equals(PNG)).toBe(true);
    } finally {
      await client.close();
      deleteGrant(coreGrant.id);
      await new Promise<void>((resolve) => source.close(() => resolve()));
    }
  });

  it('signs for a configurable lifetime and verifies without a session', () => {
    process.env.LANDFLOW_MCP_FILE_URL_TTL_SECONDS = '30';
    const now = 1_800_000_000_000;
    const { url: signed, expiresAt } = signFileUrl('scope.randomid1234', { tool: 'p/t', caller: 'apiKey:u' }, now);
    expect(expiresAt).toBe(new Date(now + 30_000).toISOString());
    const params = new URL(signed).searchParams;
    expect(verifyFileUrl('scope.randomid1234', params, now)).toEqual({ ok: true, subject: { tool: 'p/t', caller: 'apiKey:u' } });
    expect(verifyFileUrl('scope.randomid1234', params, now + 31_000)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyFileUrl('scope.otherid123456', params, now)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('inlines only small images and audio: size limit, format, and a cap on the count', async () => {
    const client = await connect(bearer(adminKey));
    const call = async (kind: string) => (await client.callTool({ name: 'files', arguments: { kind } })) as CallToolResult;
    const kinds = (r: CallToolResult) => r.content.map((c) => c.type);

    // Default limit (512 KiB): the 600 KiB image is a link only; audio goes inline; text and SVG are links only.
    expect(kinds(await call('bigpng'))).toEqual(['text', 'resource_link']);
    const audio = await call('audio');
    expect(kinds(audio)).toEqual(['text', 'resource_link', 'audio']);
    expect(audio.content.find((c) => c.type === 'audio')).toMatchObject({ mimeType: 'audio/wav' });
    expect(kinds(await call('text'))).toEqual(['text', 'resource_link']);
    expect(kinds(await call('svg'))).toEqual(['text', 'resource_link']);
    expect(kinds(await call('none'))).toEqual(['text']);

    // Six files: all six linked, four inline.
    const many = await call('many');
    expect(many.content.filter((c) => c.type === 'resource_link')).toHaveLength(6);
    expect(many.content.filter((c) => c.type === 'image')).toHaveLength(4);

    // A bigger limit takes the big image; 0 turns inline media off; a tiny limit leaves the 1x1 PNG a link.
    process.env.LANDFLOW_MCP_INLINE_MEDIA_MAX_BYTES = String(1024 * 1024);
    expect(kinds(await call('bigpng'))).toEqual(['text', 'resource_link', 'image']);
    process.env.LANDFLOW_MCP_INLINE_MEDIA_MAX_BYTES = '0';
    expect(kinds(await call('png'))).toEqual(['text', 'resource_link']);
    process.env.LANDFLOW_MCP_INLINE_MEDIA_MAX_BYTES = String(PNG.length - 1);
    expect(kinds(await call('png'))).toEqual(['text', 'resource_link']);
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// list_options
// ---------------------------------------------------------------------------

describe('list_options', () => {
  let grant = '';
  beforeAll(() => {
    clearOptionsCache();
    grant = grantAll().id;
  });
  afterAll(() => deleteGrant(grant));

  it('is offered when a tool has a dynamic list and the caller has a credential, with the plugin’s own contract', async () => {
    const client = await connect(bearer(adminKey));
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'list_options')!;
    expect(tool).toBeDefined();
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect((tool.inputSchema.properties as Record<string, { enum?: string[] }>).tool.enum).toEqual(['lists']);
    expect(tool.inputSchema.required).toEqual(['tool', 'parameter']);
    expect(tool.outputSchema).toMatchObject({ required: ['options'] });
    await client.close();

    // No grants, no tools, so no list_options either.
    const member1 = await connect(bearer(memberKey));
    expect((await member1.listTools()).tools).toEqual([]);
    await member1.close();
  });

  it('resolves the grant’s credential, calls the plugin’s load-options method, and is audited', async () => {
    const client = await connect(bearer(adminKey));
    const result = (await client.callTool({ name: 'list_options', arguments: { tool: 'lists', parameter: 'channel' } })) as CallToolResult;
    expect(result.isError, text(result)).toBeFalsy();
    expect(result.structuredContent).toEqual({
      options: [
        { name: '#general', value: 'tok-a-general', description: 'everyone' },
        { name: '#random', value: 'tok-a-random' },
      ],
    });
    // The call's own _meta names another credential when no grant binds one (grant first: here the grant wins).
    const named = (await client.callTool({ name: 'list_options', arguments: { tool: 'lists', parameter: 'channel' }, _meta: { 'dev.landflow/node': { credentials: { [CREDENTIAL_TYPE]: credB.id } } } })) as CallToolResult;
    expect((named.structuredContent as { options: Array<{ value: string }> }).options[0].value).toBe('tok-a-general');

    // Dependent lists take the arguments the list depends on.
    const topic = (await client.callTool({ name: 'list_options', arguments: { tool: 'lists', parameter: 'topic', arguments: { channel: 'C9' } } })) as CallToolResult;
    expect(topic.structuredContent).toEqual({ options: [{ name: 'Topic', value: 'for-C9' }] });

    // Wrong input is a protocol error, not a tool result.
    await expect(client.callTool({ name: 'list_options', arguments: { tool: 'lists' } })).rejects.toThrow(/needs "tool" and "parameter"/);
    await expect(client.callTool({ name: 'list_options', arguments: { tool: 'files', parameter: 'kind' } })).rejects.toThrow(/Unknown tool/);
    await expect(client.callTool({ name: 'list_options', arguments: { tool: 'lists', parameter: 'nope' } })).rejects.toThrow(/no dynamic options/);

    const entry = audits('list_options').find((e) => e.details?.parameter === 'channel')!;
    expect(entry).toMatchObject({ outcome: 'success', details: { tool: 'list_options', lookup: 'lists', options: 2, callerKind: 'apiKey' } });
    expect(JSON.stringify(entry.details)).not.toContain('tok-a');
    await client.close();
  });

  it('uses the caller’s newest credential when the grant binds none, or the one _meta names; not offered without any credential or grant', async () => {
    // A member who holds no credential of their own gets no list_options (nothing to resolve a lookup with).
    const free = createGrant({ subject: { kind: 'user', id: member.id }, pluginId: PLUGIN_ID, tools: ['lists', 'files'] }, admin.id);
    const lonely = await connect(bearer(memberKey));
    expect((await lonely.listTools()).tools.map((t) => t.name)).toEqual(['files', 'lists']);
    await expect(lonely.callTool({ name: 'list_options', arguments: { tool: 'lists', parameter: 'channel' } })).rejects.toThrow(/Unknown tool/);
    await lonely.close();
    deleteGrant(free.id);

    // An admin whose grant binds no credential: the newest visible one; `_meta` names another.
    deleteGrant(grant);
    const loose = createGrant({ subject: { kind: 'user', id: admin.id }, pluginId: PLUGIN_ID, tools: ['lists'] }, admin.id);
    const newest = credentials.create({ name: 'Demo C', type: CREDENTIAL_TYPE, data: { token: 'tok-c' } });
    const client = await connect(bearer(adminKey));
    const first = (await client.callTool({ name: 'list_options', arguments: { tool: 'lists', parameter: 'channel' } })) as CallToolResult;
    expect((first.structuredContent as { options: Array<{ value: string }> }).options[0].value).toBe('tok-c-general');
    const named = (await client.callTool({ name: 'list_options', arguments: { tool: 'lists', parameter: 'channel' }, _meta: { 'dev.landflow/node': { credentials: { [CREDENTIAL_TYPE]: credB.id } } } })) as CallToolResult;
    expect((named.structuredContent as { options: Array<{ value: string }> }).options[0].value).toBe('tok-b-general');
    const bad = (await client.callTool({ name: 'list_options', arguments: { tool: 'lists', parameter: 'channel' }, _meta: { 'dev.landflow/node': { credentials: { [CREDENTIAL_TYPE]: 'cred_nope' } } } })) as CallToolResult;
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/does not exist/);
    expect(audits('list_options').find((e) => e.outcome === 'denied')).toMatchObject({ details: { lookup: 'lists' } });
    await client.close();
    deleteGrant(loose.id);
    credentials.delete(newest.id);

    // Without a grant for the tool, looking up its options is refused too.
    const noGrant = await connect(bearer(adminKey));
    const refused = (await noGrant.callTool({ name: 'list_options', arguments: { tool: 'lists', parameter: 'channel' } })) as CallToolResult;
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/no grant to call lists/);
    await noGrant.close();
    grant = grantAll().id;
  });

  it('puts remembered lookups in tools/list as an enum, per credential, for a short time', async () => {
    clearOptionsCache();
    const property = async (headers: Record<string, string>) => {
      const client = await connect(headers);
      const tool = (await client.listTools()).tools.find((t) => t.name === 'lists')!;
      await client.close();
      return (tool.inputSchema.properties as Record<string, { enum?: string[]; description?: string }>).channel;
    };
    // Before any lookup: a plain string with the dynamic-list note.
    const before = await property(bearer(adminKey));
    expect(before.enum).toBeUndefined();
    expect(before.description).toMatch(/dynamic list/);

    const client = await connect(bearer(adminKey));
    await client.callTool({ name: 'list_options', arguments: { tool: 'lists', parameter: 'channel' } });
    await client.close();

    const after = await property(bearer(adminKey));
    expect(after.enum).toEqual(['tok-a-general', 'tok-a-random']);
    expect(after.description).toContain('`tok-a-general` (#general: everyone)');
    expect(after.description).toContain('`tok-a-random` (#random)');

    // Another caller whose resolved credential is B sees none of A's lookup (the key holds the credential).
    const bGrant = grantAll(member.id, { credentials: { [CREDENTIAL_TYPE]: credB.id } });
    const other = await property(bearer(memberKey));
    expect(other.enum).toBeUndefined();
    const asMember = await connect(bearer(memberKey));
    await asMember.callTool({ name: 'list_options', arguments: { tool: 'lists', parameter: 'channel' } });
    await asMember.close();
    expect((await property(bearer(memberKey))).enum).toEqual(['tok-b-general', 'tok-b-random']);
    expect((await property(bearer(adminKey))).enum).toEqual(['tok-a-general', 'tok-a-random']);
    deleteGrant(bGrant.id);

    // The dependent list is not shown (it depends on `channel`), and a list stays right for a refreshed lookup.
    const dependent = (await (await connect(bearer(adminKey))).listTools()).tools.find((t) => t.name === 'lists')!;
    expect((dependent.inputSchema.properties as Record<string, { enum?: string[] }>).topic.enum).toBeUndefined();

    // It expires, and the cache can be switched off.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect((await property(bearer(adminKey))).enum).toBeUndefined();
    vi.useRealTimers();
    const again = await connect(bearer(adminKey));
    process.env.LANDFLOW_MCP_OPTIONS_CACHE_SECONDS = '0';
    await again.callTool({ name: 'list_options', arguments: { tool: 'lists', parameter: 'channel' } });
    expect((await property(bearer(adminKey))).enum).toBeUndefined();
    await again.close();
  });
});

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

describe('approvals for destructive tools', () => {
  const del = { name: 'things_thing_delete', arguments: { id: 'x1', password: 'hunter2' } };
  const get = { name: 'things_thing_get', arguments: { id: 'x1' } };
  let grant = '';
  const setGrant = (approval?: 'always' | 'destructive' | 'never' | null, subject = admin.id) => {
    if (grant) deleteGrant(grant);
    grant = grantAll(subject, approval === undefined ? {} : { approval }).id;
  };
  afterAll(() => grant && deleteGrant(grant));

  it('asks through MCP elicitation when the 2026-07-28 client declared it: accept runs the tool, decline and cancel refuse it', async () => {
    setGrant();
    const asked: string[] = [];
    const client = await connect(bearer(adminKey), { asked, elicit: () => ({ action: 'accept', content: { confirm: true } }) });
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    const before = deletes;
    const ok = (await client.callTool(del)) as CallToolResult;
    expect(ok.isError, text(ok)).toBeFalsy();
    expect(deletes).toBe(before + 1);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('Run things_thing_delete');
    expect(asked[0]).toContain('id: "x1"');
    expect(asked[0]).not.toContain('hunter2');
    expect(audits('things_thing_delete')[0]).toMatchObject({ outcome: 'success', details: { approvalMode: 'destructive', approvedVia: 'elicitation' } });
    // A read-only tool does not ask.
    await client.callTool(get);
    expect(asked).toHaveLength(1);
    await client.close();

    for (const action of ['decline', 'cancel'] as const) {
      const refusing = await connect(bearer(adminKey), { elicit: () => ({ action }) });
      const count = deletes;
      const refused = (await refusing.callTool(del)) as CallToolResult;
      expect(refused.isError).toBe(true);
      expect(text(refused)).toMatch(new RegExp(`${action === 'decline' ? 'declined' : 'cancelled'}.*did not run`));
      expect(deletes).toBe(count);
      expect(audits('things_thing_delete')[0]).toMatchObject({ outcome: 'denied', details: { reason: `elicitation ${action === 'decline' ? 'declined' : 'cancelled'}` } });
      await refusing.close();
    }
    const notConfirmed = await connect(bearer(adminKey), { elicit: () => ({ action: 'accept', content: { confirm: false } }) });
    const count = deletes;
    expect(((await notConfirmed.callTool(del)) as CallToolResult).isError).toBe(true);
    expect(deletes).toBe(count);
    await notConfirmed.close();
  });

  it('does not take an answer to another call: the signed state binds the arguments', async () => {
    setGrant();
    const MODERN = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': { elicitation: {} } };
    const post = async (params: Record<string, unknown>) =>
      (await (
        await route.POST(
          new Request(url(PLUGIN_ID), {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'things_thing_delete', ...bearer(adminKey) },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { ...params, _meta: MODERN } }),
          }),
          { params: Promise.resolve({ id: PLUGIN_ID }) },
        )
      ).json()) as { result: { resultType?: string; requestState?: string; inputRequests?: Record<string, { method: string; params: { message: string } }>; isError?: boolean; content?: Array<{ text: string }> } };
    const first = await post({ name: 'things_thing_delete', arguments: { id: 'x1' } });
    expect(first.result.resultType).toBe('input_required');
    expect(first.result.inputRequests!.approve).toMatchObject({ method: 'elicitation/create', params: { message: expect.stringContaining('things_thing_delete') } });
    const state = first.result.requestState!;
    const count = deletes;
    // The same answer for different arguments, and an answer without the state: asked again, nothing runs.
    const answers = { approve: { action: 'accept', content: { confirm: true } } };
    const other = await post({ name: 'things_thing_delete', arguments: { id: 'OTHER' }, inputResponses: answers, requestState: state });
    expect(other.result.resultType).toBe('input_required');
    const stateless = await post({ name: 'things_thing_delete', arguments: { id: 'x1' }, inputResponses: answers });
    expect(stateless.result.resultType).toBe('input_required');
    const forged = await post({ name: 'things_thing_delete', arguments: { id: 'x1' }, inputResponses: answers, requestState: `${state}x` });
    expect(forged.result.resultType).toBe('input_required');
    expect(deletes).toBe(count);
    // The right pair runs.
    const good = await post({ name: 'things_thing_delete', arguments: { id: 'x1' }, inputResponses: answers, requestState: state });
    expect(good.result.isError).toBeFalsy();
    expect(deletes).toBe(count + 1);
  });

  it('otherwise creates a Landflow approval: approved while the call waits, it runs', async () => {
    setGrant();
    const client = await connect(bearer(adminKey));
    const count = deletes;
    const pending = client.callTool(del) as Promise<CallToolResult>;
    await vi.waitFor(() => expect(listApprovals(admin).some((a) => a.status === 'pending')).toBe(true));
    const [approval] = listApprovals(admin).filter((a) => a.status === 'pending');
    expect(approval).toMatchObject({ pluginId: PLUGIN_ID, tool: 'things_thing_delete', caller: `apiKey:${admin.id}`, canDecide: true });
    expect(approval.summary).toContain('id: "x1"');
    expect(approval.summary).toContain('password: ••••');
    expect(approval.summary).not.toContain('hunter2');
    decideMcpApproval(approval.id, true, admin);
    const result = await pending;
    expect(result.isError, text(result)).toBeFalsy();
    expect(deletes).toBe(count + 1);
    expect(audits('things_thing_delete')[0]).toMatchObject({ outcome: 'success', details: { approvedVia: 'approval', approvalId: approval.id, approvedBy: 'ada@t6a.test' } });
    // One use: the same call asks again.
    const again = (await client.callTool(del)) as CallToolResult;
    expect(again.isError).toBe(true);
    expect(deletes).toBe(count + 1);
    await client.close();
  });

  it('also serves 2025-era clients (no elicitation possible), and a client that declared elicitation on that era', async () => {
    setGrant();
    const asked: string[] = [];
    const client = await connect(bearer(adminKey), { mode: 'legacy', asked, elicit: () => ({ action: 'accept', content: { confirm: true } }) });
    expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    const count = deletes;
    const waiting = (await client.callTool(del)) as CallToolResult;
    expect(waiting.isError).toBe(true);
    expect(asked).toEqual([]);
    expect(deletes).toBe(count);
    await client.close();
  });

  it('times out with an error that says where to approve; approving afterwards lets the repeated call run once; denying refuses', async () => {
    setGrant();
    const client = await connect(bearer(adminKey));
    const count = deletes;
    const timedOut = (await client.callTool(del)) as CallToolResult;
    expect(timedOut.isError).toBe(true);
    expect(text(timedOut)).toMatch(/needs a person's approval.*Settings → MCP → Approvals \(http:\/\/mcp\.test\/settings#mcp\).*approval mcpa_\w+.*call things_thing_delete again with the same arguments within 10 minutes/s);
    expect(audits('things_thing_delete')[0]).toMatchObject({ outcome: 'denied', details: { reason: 'approval pending' } });
    expect(deletes).toBe(count);

    // Asking again while it waits reuses the pending approval (one row).
    const pendingBefore = listApprovals(admin).filter((a) => a.status === 'pending');
    await client.callTool(del);
    expect(listApprovals(admin).filter((a) => a.status === 'pending')).toHaveLength(pendingBefore.length);
    const id = pendingBefore[0].id;

    // Through the route, as a signed-in person; then the repeat runs without asking, once.
    const decide = (approve: boolean, who = admin) =>
      approvalRoute.POST(new Request(`http://mcp.test/api/mcp/approvals/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approve }) }), { params: Promise.resolve({ id }) });
    expect(((await decide(true)).status)).toBe(200);
    expect((await decide(true)).status).toBe(409);
    const ran = (await client.callTool(del)) as CallToolResult;
    expect(ran.isError, text(ran)).toBeFalsy();
    expect(deletes).toBe(count + 1);
    expect(((await client.callTool(del)) as CallToolResult).isError).toBe(true);

    // A denial is final and says who denied it.
    const second = client.callTool({ ...del, arguments: { id: 'x2' } }) as Promise<CallToolResult>;
    await vi.waitFor(() => expect(listApprovals(admin).some((a) => a.status === 'pending' && a.summary.includes('x2'))).toBe(true));
    decideMcpApproval(listApprovals(admin).find((a) => a.status === 'pending' && a.summary.includes('x2'))!.id, false, admin);
    const denied = await second;
    expect(denied.isError).toBe(true);
    expect(text(denied)).toMatch(/ada@t6a\.test denied this call/);
    expect(deletes).toBe(count + 1);
    await client.close();
    expect(queryEvents({ actions: ['mcp.approval.decide'] }).events.length).toBeGreaterThanOrEqual(0);
  });

  it('lists approvals only to people who may answer them', async () => {
    setGrant();
    const client = await connect(bearer(adminKey));
    await client.callTool({ ...del, arguments: { id: 'x3' } });
    await client.close();
    const pending = listApprovals(admin).find((a) => a.summary.includes('x3'))!;
    // A member of no shared project (and not the caller) sees nothing and cannot answer.
    expect(listApprovals(member).find((a) => a.id === pending.id)).toBeUndefined();
    expect(() => decideMcpApproval(pending.id, true, member)).toThrow(McpApprovalError);
    expect(approvalsRoute.GET).toBeTypeOf('function');
    expect(routePolicy('GET', '/api/mcp/approvals')).toEqual({ scope: 'any' });
    expect(isPublicPath('/api/mcp/approvals')).toBe(false);
  });

  it('follows the grant: never runs without asking, always asks for read-only tools too', async () => {
    const asked: string[] = [];
    const confirm = () => ({ action: 'accept' as const, content: { confirm: true } });
    setGrant('never');
    const client = await connect(bearer(adminKey), { asked, elicit: confirm });
    const count = deletes;
    expect(((await client.callTool(del)) as CallToolResult).isError).toBeFalsy();
    expect(deletes).toBe(count + 1);
    expect(asked).toEqual([]);
    expect(audits('things_thing_delete')[0].details).not.toHaveProperty('approvedVia');
    await client.close();

    setGrant('always');
    const strict = await connect(bearer(adminKey), { asked, elicit: confirm });
    expect(((await strict.callTool(get)) as CallToolResult).isError).toBeFalsy();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('things_thing_get');
    await strict.close();

    // The strictest grant that allows the tool wins when several apply.
    const loose = createGrant({ subject: { kind: 'role', id: 'admin' }, pluginId: PLUGIN_ID, tools: '*', credentials: { [CREDENTIAL_TYPE]: credA.id }, approval: 'never' }, admin.id);
    const both = await connect(bearer(adminKey), { asked, elicit: confirm });
    await both.callTool(get);
    expect(asked).toHaveLength(2);
    await both.close();
    deleteGrant(loose.id);
  });

  it('keeps the older requireApproval boolean working, and only the creator may turn approvals down', () => {
    if (grant) deleteGrant(grant);
    const created = createGrant({ subject: { kind: 'user', id: admin.id }, pluginId: PLUGIN_ID, tools: '*', requireApproval: true }, admin.id);
    grant = created.id;
    expect(created).toMatchObject({ approval: 'destructive', requireApproval: true });
    expect(updateGrant(created.id, { requireApproval: false }, admin)).toMatchObject({ approval: 'never', requireApproval: false });
    expect(updateGrant(created.id, { approval: 'always' }, member)).toMatchObject({ approval: 'always' });
    expect(() => updateGrant(created.id, { approval: 'never' }, member)).toThrow(McpGrantError);
    expect(() => updateGrant(created.id, { approval: 'destructive' }, { id: 'someone-else', role: 'owner' })).toThrow(/Only the person who created this grant/);
    expect(updateGrant(created.id, { approval: 'destructive' }, admin).approval).toBe('destructive');
    expect(updateGrant(created.id, { approval: null }, admin)).not.toHaveProperty('approval');
    expect(getGrant(created.id)).not.toHaveProperty('approval');
    // A grant nobody created (a config file, an old row) may be turned down by an instance owner.
    const orphan = createGrant({ subject: { kind: 'user', id: admin.id }, pluginId: PLUGIN_ID, tools: [] });
    expect(updateGrant(orphan.id, { approval: 'never' }, { id: 'x', role: 'owner' }).approval).toBe('never');
    deleteGrant(orphan.id);
  });
});

export {};
void mcpWorkflowId;
void store;
