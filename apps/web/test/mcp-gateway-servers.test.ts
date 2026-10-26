/**
 * Stream T6-E: the instance server and MCP Server Trigger workflows behind the gateway, and the approval consume race.
 *
 * - `McpGatewaySync` registers the instance server (while it is on) and each published workflow's enabled MCP Server
 *   Trigger as targets (and routes) next to the plugins', and removes them again; with a fake adapter, the file adapter
 *   and the default registry source (`registryServers`).
 * - /api/mcp through the gateway headers: a signed-in user works under their project access in both protocol eras,
 *   an anonymous gateway call and a forged secret are refused, the access token still works directly.
 * - /mcp/<path> through the gateway: a user with run access passes (as that user), one without gets 403, an anonymous
 *   caller falls back to the trigger's own auth (and a bearer trigger says the gateway can't forward it).
 * - `consumeApproved`: two concurrent consumers of one approval, one wins (SQLite, and a fake Postgres sink shared by
 *   two "mains" whose copies each believe the row is approved).
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Workflow } from '@landflow/engine';
import type { GatewayRoute, GatewayTarget, McpGatewayAdapter, SyncPlugin, SyncServer } from '@/lib/server/mcp/gateway-sync';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-mcp-t6e-'));
const SECRET = 'test-gateway-secret-0123456789abcdef';
const INSTANCE = 'http://mcp.test';
const ENV = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_PUBLIC_URL: INSTANCE,
  LANDFLOW_MCP_GATEWAY_SECRET: SECRET,
  LANDFLOW_ENCRYPTION_KEY: 'mcp-t6e-test-key',
};
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { McpGatewaySync, MemoryOwnedStore, registryServers, gatewayTargetName, renderEntryTarget, entryForServer } = await import('@/lib/server/mcp/gateway-sync');
const { FileGatewayAdapter } = await import('@/lib/server/mcp/gateway-adapters');
const { createUser } = await import('@/lib/server/auth/users');
const { issueMcpToken } = await import('@/lib/server/mcp/tokens');
const { setMcpEnabled } = await import('@/lib/server/mcp/instance');
const projects = await import('@/lib/server/projects');
const { closeMcpEndpoints } = await import('@/lib/server/mcp/server');
const { consumeApproved, argumentsHash } = await import('@/lib/server/mcp/approvals');
const { mcpDb } = await import('@/lib/server/mcp/db');
const instanceRoute = await import('@/app/api/mcp/route');
const triggerRoute = await import('@/app/mcp/[...path]/route');

registry.registerBuiltin(corePlugin);

const HOST = 'http://127.0.0.1:3000';

class FakeAdapter implements McpGatewayAdapter {
  readonly kind = 'fake';
  readonly location = 'memory';
  readonly targets = new Map<string, GatewayTarget['value']>();
  readonly routes = new Map<string, GatewayRoute['value']>();
  async health() {
    return { ok: true, version: 'fake' };
  }
  async list() {
    return [...this.targets.values()];
  }
  async upsert(target: GatewayTarget) {
    this.targets.set(target.name, structuredClone(target.value));
  }
  async remove(name: string) {
    this.targets.delete(name);
  }
  async listRoutes() {
    return [...this.routes.values()];
  }
  async upsertRoute(route: GatewayRoute) {
    this.routes.set(route.name, structuredClone(route.value));
  }
  async removeRoute(name: string) {
    this.routes.delete(name);
  }
}

let member: Awaited<ReturnType<typeof createUser>>;
let admin: Awaited<ReturnType<typeof createUser>>;
let outsider: Awaited<ReturnType<typeof createUser>>;
let teamId = '';

const mcpWorkflow = (id: string, name: string, path: string, parameters: Record<string, unknown> = {}, nodeCredentials?: Record<string, { id: string; name: string }>): Workflow =>
  ({
    id,
    name,
    active: true,
    nodes: [
      { id: 'mcp', name: 'MCP Server', type: 'core.mcpTrigger', typeVersion: 1, position: [0, 0], parameters: { path, ...parameters }, ...(nodeCredentials && { credentials: nodeCredentials }) },
      { id: 'calc', name: 'Calculator', type: 'core.calculatorTool', typeVersion: 1, position: [0, 200], parameters: {} },
    ],
    connections: [{ id: 'c1', type: 'ai_tool', source: 'calc', target: 'mcp', sourceIndex: 0, targetIndex: 0 }],
  }) as Workflow;

beforeAll(async () => {
  admin = await createUser({ email: 'admin@t6e.test', name: 'Admin', role: 'owner', password: 'admin-pass-123' });
  member = await createUser({ email: 'member@t6e.test', name: 'Member', role: 'member', password: 'member-pass-123' });
  outsider = await createUser({ email: 'outsider@t6e.test', name: 'Outsider', role: 'member', password: 'outsider-pass-123' });
  teamId = projects.createTeamProject({ name: 'T6E team' }).id;
  projects.setMember(teamId, member.id, 'editor');
});

afterAll(async () => {
  await closeMcpEndpoints();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

// ---- the sync ------------------------------------------------------------------------------------------------

describe('gateway sync: instance and workflow servers', () => {
  const plugins: SyncPlugin[] = [{ id: 'core', online: true, exposed: true, tools: 8 }];
  const make = (servers: { current: SyncServer[] }, adapter: McpGatewayAdapter, routes = false, kind: 'bundled' | 'file' = 'bundled') => {
    const owned = new MemoryOwnedStore();
    const sync = new McpGatewaySync({
      mode: kind,
      adapter,
      plugins: () => plugins,
      servers: () => servers.current,
      now: () => 1_000_000,
      hostUrl: () => HOST,
      secret: () => SECRET,
      store: owned,
      routes,
      routePolicies: () => undefined,
      purge: null,
    });
    return { sync, owned };
  };

  it('names targets by kind and keeps names clear of plugin ids', () => {
    expect(entryForServer({ kind: 'instance', label: 'x' }).name).toBe(gatewayTargetName('landflow-mcp'));
    const entry = entryForServer({ kind: 'workflow', path: 'team/tools', label: 'x' });
    expect(entry.name).toBe(gatewayTargetName('wf-team/tools'));
    const target = renderEntryTarget(entry, { hostUrl: HOST, secret: SECRET });
    expect(target.value.mcp.host).toBe(`${HOST}/mcp/team/tools`);
    expect(renderEntryTarget(entryForServer({ kind: 'instance', label: 'x' }), { hostUrl: HOST, secret: SECRET }).value.mcp.host).toBe(`${HOST}/api/mcp`);
  });

  it('adds and removes the instance server and a workflow trigger target, with routes', async () => {
    const servers = { current: [] as SyncServer[] };
    const adapter = new FakeAdapter();
    const { sync, owned } = make(servers, adapter, true);
    await sync.reconcile();
    expect([...adapter.targets.keys()]).toEqual(['core']);

    servers.current = [
      { kind: 'instance', label: 'Landflow instance server' },
      { kind: 'workflow', path: 'team/tools', label: 'Tools (/mcp/team/tools)' },
    ];
    const added = await sync.reconcile();
    expect(added.changed).toBe(true);
    const names = [...adapter.targets.keys()].sort();
    expect(names).toHaveLength(3);
    expect(names).toContain('core');
    expect([...adapter.routes.keys()].filter((n) => n.startsWith('landflow-mcp-')).length).toBeGreaterThanOrEqual(3);
    const status = await sync.status();
    expect(status.targets.filter((t) => t.kind === 'mcp.target').map((t) => [t.serverKind, t.state]).sort()).toEqual([
      ['instance', 'in-step'],
      ['plugin', 'in-step'],
      ['workflow', 'in-step'],
    ]);
    expect(status.targets.find((t) => t.serverKind === 'workflow')?.label).toContain('/mcp/team/tools');
    expect(owned.list().filter((o) => o.kind === 'mcp.target').map((o) => o.pluginId).sort()).toEqual(['@instance', '@workflow:team/tools', 'core']);

    // The workflow is unpublished: only its target and routes go, nothing else is touched.
    servers.current = [{ kind: 'instance', label: 'Landflow instance server' }];
    const removed = await sync.reconcile();
    expect(removed.removed.length).toBeGreaterThanOrEqual(1);
    expect([...adapter.targets.keys()].sort()).toHaveLength(2);
    // The instance server is turned off.
    servers.current = [];
    await sync.reconcile();
    expect([...adapter.targets.keys()]).toEqual(['core']);
    expect([...adapter.routes.keys()].every((n) => !n.includes('@'))).toBe(true);
    expect(owned.list().filter((o) => o.kind === 'mcp.target').map((o) => o.pluginId)).toEqual(['core']);
  });

  it('writes them into the file adapter’s config too', async () => {
    const path = join(dataDir, 'gw-file', 'config.yaml');
    const servers = { current: [{ kind: 'instance', label: 'i' }, { kind: 'workflow', path: 'a/b', label: 'w' }] as SyncServer[] };
    const { sync } = make(servers, new FileGatewayAdapter({ path }), true, 'file');
    await sync.reconcile();
    const doc = parse(readFileSync(path, 'utf8'));
    const hosts = doc.mcp.targets.map((t: { mcp: { host: string } }) => t.mcp.host).sort();
    expect(hosts).toEqual([`${HOST}/api/mcp`, `${HOST}/api/mcp/plugins/core`, `${HOST}/mcp/a/b`].sort());
    servers.current = [];
    await sync.reconcile();
    const after = parse(readFileSync(path, 'utf8'));
    expect(after.mcp.targets.map((t: { name: string }) => t.name)).toEqual(['core']);
  });

  it('the default source follows the instance toggle and published workflows with an enabled MCP Server Trigger', async () => {
    setMcpEnabled(false);
    expect(await registryServers()).toEqual([]);
    setMcpEnabled(true);
    store.saveWorkflow(mcpWorkflow('wf_t6e_a', 'Alpha', '/alpha/'));
    store.saveWorkflow({ ...mcpWorkflow('wf_t6e_off', 'Off', 'off'), active: false });
    const disabledNode = mcpWorkflow('wf_t6e_dis', 'Disabled node', 'dis');
    disabledNode.nodes[0].disabled = true;
    store.saveWorkflow(disabledNode);
    const servers = await registryServers();
    expect(servers.map((s) => (s.kind === 'workflow' ? `workflow:${s.path}` : s.kind))).toEqual(['instance', 'workflow:alpha']);
    setMcpEnabled(false);
    for (const id of ['wf_t6e_a', 'wf_t6e_off', 'wf_t6e_dis']) store.deleteWorkflow(id);
    expect(await registryServers()).toEqual([]);
  });
});

// ---- identity through the gateway ----------------------------------------------------------------------------

type Handler = (request: Request, ctx?: unknown) => Promise<Response>;

/** A client over a route, with fixed extra headers (the gateway's). */
async function connect(url: string, route: Record<string, Handler>, headers: Record<string, string>, legacy: boolean) {
  const fetchRoute = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const segments = new URL(request.url).pathname.split('/').filter(Boolean).slice(1);
    return route[request.method](request, { params: Promise.resolve({ path: segments }) });
  };
  const client = new Client({ name: 't6e', version: '1.0.0' }, { versionNegotiation: { mode: legacy ? 'legacy' : 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: fetchRoute, requestInit: { headers } }));
  return client;
}

async function gatewayHeaders(user: { id: string }) {
  const { record } = await issueMcpToken(user as never, { label: 't6e' });
  return { 'x-landflow-gateway': SECRET, 'x-landflow-caller-iss': INSTANCE, 'x-landflow-caller-sub': user.id, 'x-landflow-caller-jti': record.id };
}

describe('/api/mcp through the gateway', () => {
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    setMcpEnabled(true);
    // Created in the team project by the member: only the team can see it.
    const { setHomeProject } = await import('@/lib/server/projects/store');
    const wf = { id: 'wf_t6e_team', name: 'T6E team flow', nodes: [], connections: [] } as unknown as Workflow;
    setHomeProject('workflow', wf.id, teamId);
    store.saveWorkflow(wf);
    ids.workflow = wf.id;
  });

  for (const legacy of [false, true]) {
    it(`a signed-in user lists the tools and sees only what their projects allow (${legacy ? '2025-11-25' : '2026-07-28'})`, async () => {
      const call = async (user: { id: string }) => {
        const client = await connect(`${INSTANCE}/api/mcp`, instanceRoute as never, await gatewayHeaders(user), legacy);
        expect(client.getNegotiatedProtocolVersion()).toBe(legacy ? '2025-11-25' : '2026-07-28');
        const names = (await client.listTools()).tools.map((t) => t.name);
        const listed = (await client.callTool({ name: 'list_workflows', arguments: {} })) as { content: Array<{ text: string }> };
        await client.close();
        return { names, text: listed.content.map((c) => c.text).join('') };
      };
      const asMember = await call(member);
      const asOutsider = await call(outsider);
      expect(asMember.names.length).toBeGreaterThan(0);
      expect(asMember.text).toContain('T6E team flow');
      expect(asOutsider.text).not.toContain('T6E team flow');
    });
  }

  it('refuses an anonymous gateway call and a forged secret, and still takes the access token directly', async () => {
    const anonymous = await instanceRoute.POST(new Request(`${INSTANCE}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-landflow-gateway': SECRET }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }));
    expect(anonymous.status).toBe(403);
    const forged = await instanceRoute.POST(new Request(`${INSTANCE}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-landflow-gateway': 'nope', 'x-landflow-caller-sub': member.id }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }));
    expect([401, 403]).toContain(forged.status);
    const none = await instanceRoute.POST(new Request(`${INSTANCE}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    expect(none.status).toBe(401);
  });
});

describe('/mcp/<path> through the gateway', () => {
  beforeAll(async () => {
    const { setHomeProject } = await import('@/lib/server/projects/store');
    const { credentials } = await import('@/lib/server/credentials/vault');
    const wf = mcpWorkflow('wf_t6e_trig', 'T6E trigger', 'team/t6e');
    setHomeProject('workflow', wf.id, teamId);
    store.saveWorkflow(wf);
    const bearer = credentials.create({ name: 'T6E trigger token', type: 'core.httpBearerAuth', data: { token: 'trigger-secret' } });
    store.saveWorkflow(mcpWorkflow('wf_t6e_bearer', 'T6E bearer', 'team/bearer', { authentication: 'bearerAuth' }, { httpBearerAuth: { id: bearer.id, name: bearer.name } }));
  });

  it('lets a user with run access in (both eras) and refuses one without', async () => {
    for (const legacy of [false, true]) {
      const client = await connect(`${INSTANCE}/mcp/team/t6e`, triggerRoute as never, await gatewayHeaders(member), legacy);
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['Calculator']);
      const sum = (await client.callTool({ name: 'Calculator', arguments: { expression: '6*7' } })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(sum.isError).toBeFalsy();
      expect(sum.content[0].text).toContain('42');
      await client.close();
    }
    const executions = store.listExecutions({ workflowId: 'wf_t6e_trig' });
    expect(executions.length).toBeGreaterThan(0);
    await expect(connect(`${INSTANCE}/mcp/team/t6e`, triggerRoute as never, await gatewayHeaders(outsider), false)).rejects.toThrow(/403|may not run/);
  });

  it('an anonymous gateway call follows the trigger’s own auth: open passes, bearer says the gateway cannot forward it', async () => {
    const anonymous = { 'x-landflow-gateway': SECRET };
    const open = await connect(`${INSTANCE}/mcp/team/t6e`, triggerRoute as never, anonymous, false).catch((e: Error) => e);
    // The team workflow has no trigger auth, so an anonymous caller is let through as the trigger always did.
    expect(open).toBeInstanceOf(Client);
    await (open as InstanceType<typeof Client>).close();
    const response = await triggerRoute.POST(new Request(`${INSTANCE}/mcp/team/bearer`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...anonymous }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }), { params: Promise.resolve({ path: ['team', 'bearer'] }) } as never);
    const text = await response.text();
    expect(response.status, text).toBe(401);
    expect(text).toMatch(/gateway cannot forward/);
  });
});

// ---- approvals -----------------------------------------------------------------------------------------------

describe('consumeApproved: concurrent consumers', () => {
  const call = (n: string) => ({ pluginId: 'race', tool: 'race_delete', args: { id: n }, caller: 'apiKey:u1' }) as never;
  const seed = (db: ReturnType<typeof mcpDb>, id: string, n: string) =>
    db.upsert('mcp_approvals', {
      id,
      plugin_id: 'race',
      tool: 'race_delete',
      args_hash: argumentsHash({ id: n } as never),
      caller: 'apiKey:u1',
      caller_user_id: null,
      summary: 'race',
      credentials: '[]',
      status: 'approved',
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      decided_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    } as never);

  it('on SQLite exactly one of two concurrent consumers gets the approval', async () => {
    const db = mcpDb();
    seed(db, 'mcpa_race1', 'one');
    const results = await Promise.all([consumeApproved(call('one')), consumeApproved(call('one'))]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(db.get<{ status: string }>('SELECT status FROM mcp_approvals WHERE id = ?', 'mcpa_race1')?.status).toBe('used');
    expect(await consumeApproved(call('one'))).toBeUndefined();
  });

  it('with a Postgres sink two mains racing for one approval: the guarded UPDATE picks one; with two approvals each gets one', async () => {
    const sink = new Map<string, { status: string }>();
    // Two "mains": each has its own local copy (all approved) and a `direct` that applies the guarded UPDATE to the shared sink.
    const main = (rows: string[]) => {
      const local = new Map(rows.map((id) => [id, { ...(mcpDb().get('SELECT * FROM mcp_approvals WHERE id = ?', id) as Record<string, unknown>) }]));
      return {
        kind: 'postgres',
        flush: async () => {},
        all: () => [...local.values()].filter((r) => r.status === 'approved'),
        upsert: (_t: string, row: Record<string, unknown>) => void local.set(String(row.id), row),
        direct: async (fn: (client: { query: (sql: string, params: unknown[]) => Promise<{ rowCount: number }> }) => unknown) =>
          fn({
            query: async (_sql, params) => {
              const row = sink.get(String(params[1]));
              if (!row || row.status !== 'approved') return { rowCount: 0 };
              row.status = 'used';
              return { rowCount: 1 };
            },
          }),
      } as never;
    };
    const db = mcpDb();
    seed(db, 'mcpa_pg1', 'two');
    sink.set('mcpa_pg1', { status: 'approved' });
    const one = await Promise.all([consumeApproved(call('two'), main(['mcpa_pg1'])), consumeApproved(call('two'), main(['mcpa_pg1']))]);
    expect(one.filter(Boolean)).toHaveLength(1);
    expect(sink.get('mcpa_pg1')?.status).toBe('used');

    seed(db, 'mcpa_pg2', 'three');
    seed(db, 'mcpa_pg3', 'three');
    sink.set('mcpa_pg2', { status: 'approved' });
    sink.set('mcpa_pg3', { status: 'approved' });
    const two = await Promise.all([consumeApproved(call('three'), main(['mcpa_pg2', 'mcpa_pg3'])), consumeApproved(call('three'), main(['mcpa_pg2', 'mcpa_pg3']))]);
    expect(two.filter(Boolean)).toHaveLength(2);
    expect(new Set(two.map((r) => r?.id)).size).toBe(2);
  });
});
