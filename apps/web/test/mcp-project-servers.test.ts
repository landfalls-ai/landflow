/**
 * The instance MCP server per project (docs/transports.md, docs/protocol.md §15.3; lib/server/mcp/project-servers.ts,
 * instance-route.ts): /api/mcp/projects/<id> lists and changes only that project's workflows (the instance token, a user's
 * token and the gateway's caller all work), a token issued for a project is scoped wherever it is used, a token for another
 * project is refused, and the gateway sync registers one route per project whose admins turned it on.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-mcp-projects-'));
const INSTANCE = 'http://localhost:3000';
const SECRET = 'test-gateway-secret-0123456789abcdef';
const ENV: Record<string, string> = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_PUBLIC_URL: INSTANCE,
  LANDFLOW_MCP_GATEWAY_SECRET: SECRET,
  LANDFLOW_MCP_GATEWAY_PUBLIC_URL: 'http://127.0.0.1:54000',
};
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
for (const key of ['LANDFLOW_OIDC_ISSUER', 'LANDFLOW_OIDC_DISCOVERY_URL']) delete process.env[key];

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { createUser } = await import('@/lib/server/auth/users');
const { createSession } = await import('@/lib/server/auth/sessions');
const { withAuth } = await import('@/lib/server/auth/context');
const { createTeamProject, setHomeProject, setMember } = await import('@/lib/server/projects/store');
const { setMcpEnabled } = await import('@/lib/server/mcp/instance');
const { issueMcpToken } = await import('@/lib/server/mcp/tokens');
const { McpGatewaySync, MemoryOwnedStore, entryForServer, registryServers } = await import('@/lib/server/mcp/gateway-sync');
const { closeMcpEndpoints } = await import('@/lib/server/mcp/server');
const rootRoute = await import('@/app/api/mcp/route');
const projectRoute = await import('@/app/api/mcp/projects/[id]/route');
const settingsRoute = await import('@/app/api/projects/[id]/mcp/route');
const tokensRoute = await import('@/app/api/mcp/tokens/route');
const prmRoute = await import('@/app/.well-known/oauth-protected-resource/api/mcp/projects/[id]/route');

registry.registerBuiltin(corePlugin);

type Result = { result?: Record<string, unknown>; error?: { message: string } };
const text = (result: Record<string, unknown> | undefined) => ((result?.content as Array<{ text: string }> | undefined)?.[0]?.text ?? '') as string;

async function rpc(url: string, method: string, params: unknown, headers: Record<string, string>, projectId?: string): Promise<{ status: number; body: Result }> {
  const request = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const response = projectId
    ? await (projectRoute.POST as unknown as (r: Request, c: unknown) => Promise<Response>)(request, { params: Promise.resolve({ id: projectId }) })
    : await (rootRoute.POST as unknown as (r: Request) => Promise<Response>)(request);
  const raw = await response.text();
  let body: Result = {};
  try {
    body = JSON.parse(raw.includes('data:') ? raw.split('\n').find((l) => l.startsWith('data:'))!.slice(5) : raw) as Result;
  } catch {}
  return { status: response.status, body };
}

const tool = (url: string, name: string, args: Record<string, unknown>, headers: Record<string, string>, projectId?: string) => rpc(url, 'tools/call', { name, arguments: args }, headers, projectId);

const workflow = (id: string, name: string) => ({ id, name, nodes: [{ id: 'n1', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0] as [number, number], parameters: {} }], connections: [], settings: {} });

describe('the instance MCP server per project', () => {
  const root = `${INSTANCE}/api/mcp`;
  let access = '';
  let alpha: { id: string };
  let beta: { id: string };
  let member: Awaited<ReturnType<typeof createUser>>;
  let outsider: Awaited<ReturnType<typeof createUser>>;

  it('lists, reads, creates and runs only the project’s workflows (instance access token)', async () => {
    const owner = await createUser({ email: 'owner@projects.test', name: 'Owner', role: 'owner', password: 'owner-pass-123' });
    member = await createUser({ email: 'member@projects.test', name: 'Member', role: 'member', password: 'member-pass-123' });
    outsider = await createUser({ email: 'outsider@projects.test', name: 'Outsider', role: 'member', password: 'outsider-pass-123' });
    alpha = createTeamProject({ name: 'Alpha', createdBy: owner.id });
    beta = createTeamProject({ name: 'Beta', createdBy: owner.id });
    setMember(alpha.id, member.id, 'editor');
    setMember(beta.id, member.id, 'viewer');
    for (const [id, name, project] of [['wf_a1', 'Alpha one', alpha.id], ['wf_a2', 'Alpha two', alpha.id], ['wf_b1', 'Beta one', beta.id]] as const) {
      setHomeProject('workflow', id, project);
      store.saveWorkflow(workflow(id, name) as never);
    }
    const on = setMcpEnabled(true);
    access = on.token!;
    const instance = { authorization: `Bearer ${access}` };

    const all = await tool(root, 'list_workflows', {}, instance);
    expect(JSON.parse(text(all.body.result)).workflows.map((w: { id: string }) => w.id).sort()).toEqual(['wf_a1', 'wf_a2', 'wf_b1']);

    const url = `${root}/projects/${alpha.id}`;
    const scoped = await tool(url, 'list_workflows', {}, instance, alpha.id);
    expect(JSON.parse(text(scoped.body.result)).workflows.map((w: { id: string }) => w.id).sort()).toEqual(['wf_a1', 'wf_a2']);

    // Another project's workflow does not exist here.
    const other = await tool(url, 'get_workflow', { id: 'wf_b1' }, instance, alpha.id);
    expect(other.body.result?.isError).toBe(true);
    expect(text(other.body.result)).toMatch(/not found/);
    expect((await tool(url, 'update_workflow', { id: 'wf_b1', name: 'Hijacked' }, instance, alpha.id)).body.result?.isError).toBe(true);
    expect(store.getWorkflow('wf_b1')?.name).toBe('Beta one');
    expect((await tool(url, 'execute_workflow', { id: 'wf_b1' }, instance, alpha.id)).body.result?.isError).toBe(true);
    expect((await tool(url, 'get_workflow', { id: 'wf_a1' }, instance, alpha.id)).body.result?.isError).toBeFalsy();

    // What it creates goes into the project.
    const created = await tool(url, 'create_workflow', { name: 'Made in Alpha', nodes: [{ name: 'Start', type: 'core.manualTrigger' }] }, instance, alpha.id);
    const id = JSON.parse(text(created.body.result)).id as string;
    expect((await import('@/lib/server/projects/store')).homeProjectId('workflow', id)).toBe(alpha.id);
    expect(JSON.parse(text((await tool(url, 'list_workflows', {}, instance, alpha.id)).body.result)).total).toBe(3);

    // Executions: only the project's.
    const ran = await tool(url, 'execute_workflow', { id: 'wf_a1' }, instance, alpha.id);
    expect(JSON.parse(text(ran.body.result)).status).toBe('success');
    await tool(root, 'execute_workflow', { id: 'wf_b1' }, instance);
    const executions = JSON.parse(text((await tool(url, 'list_executions', {}, instance, alpha.id)).body.result)).executions as Array<{ workflowId: string }>;
    expect(executions.length).toBeGreaterThan(0);
    expect(executions.every((e) => e.workflowId === 'wf_a1')).toBe(true);
    const betaRun = JSON.parse(text((await tool(root, 'list_executions', { workflowId: 'wf_b1' }, instance)).body.result)).executions[0].id as string;
    expect((await tool(url, 'get_execution', { id: betaRun }, instance, alpha.id)).body.result?.isError).toBe(true);

    // The server says which project it is for.
    const init = await rpc(url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }, instance, alpha.id);
    expect(JSON.stringify(init.body.result)).toContain('Alpha');
    expect((await rpc(`${root}/projects/nope`, 'tools/list', {}, instance, 'nope')).status).toBe(404);
    expect((await rpc(url, 'tools/list', {}, {}, alpha.id)).status).toBe(401);
  });

  it('accepts a user’s Landflow MCP token; a project token is scoped wherever it is used and refused at another project', async () => {
    const plain = (await issueMcpToken(member, { label: 'all projects' })).token;
    const forAlpha = (await issueMcpToken(member, { label: 'alpha only', projectId: alpha.id })).token;
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
    const ids = async (url: string, token: string, project?: string) => JSON.parse(text((await tool(url, 'list_workflows', {}, bearer(token), project)).body.result)).workflows.map((w: { id: string }) => w.id).sort();

    // The member sees what their projects hold: Alpha (editor) and Beta (viewer).
    expect(await ids(root, plain)).toEqual(expect.arrayContaining(['wf_a1', 'wf_a2', 'wf_b1']));
    expect(await ids(`${root}/projects/${beta.id}`, plain, beta.id)).toEqual(['wf_b1']);
    // A token for Alpha sees only Alpha, at /api/mcp and at Alpha's URL.
    expect(await ids(root, forAlpha)).toEqual(expect.arrayContaining(['wf_a1', 'wf_a2']));
    expect(await ids(root, forAlpha)).not.toContain('wf_b1');
    expect(await ids(`${root}/projects/${alpha.id}`, forAlpha, alpha.id)).not.toContain('wf_b1');
    // ... and is refused at Beta's.
    const refused = await rpc(`${root}/projects/${beta.id}`, 'tools/list', {}, bearer(forAlpha), beta.id);
    expect(refused.status).toBe(403);
    expect(refused.body.error?.message).toMatch(/another project/);

    // A viewer of Beta can read but not change; creating in a project needs the right to create there.
    const beta_ = `${root}/projects/${beta.id}`;
    expect((await tool(beta_, 'update_workflow', { id: 'wf_b1', name: 'Nope' }, bearer(plain), beta.id)).body.result?.isError).toBe(true);
    expect(store.getWorkflow('wf_b1')?.name).toBe('Beta one');
    const create = await withAuth({ principal: { user: member, via: 'mcp' } }, () => tool(beta_, 'create_workflow', { name: 'Viewer made', nodes: [{ name: 'Start', type: 'core.manualTrigger' }] }, bearer(plain), beta.id));
    expect(create.body.result?.isError ?? true).toBeTruthy();
  });

  it('refuses a token scoped to a project the user cannot see, and the REST route issues project tokens', async () => {
    await expect(issueMcpToken(outsider, { label: 'sneaky', projectId: alpha.id })).rejects.toMatchObject({ status: 403 });
    await expect(issueMcpToken(member, { label: 'ghost', projectId: 'nope' })).rejects.toMatchObject({ status: 404 });
    const as = (user: typeof member) => ({ cookie: `landflow_session=${createSession(user, 'password').token}`, 'content-type': 'application/json' });
    const response = await (tokensRoute.POST as unknown as (r: Request) => Promise<Response>)(
      new Request(`${INSTANCE}/api/mcp/tokens`, { method: 'POST', headers: as(member), body: JSON.stringify({ label: 'via rest', projectId: alpha.id }) }),
    );
    expect(response.status).toBe(201);
    expect((await response.json()).record).toMatchObject({ label: 'via rest', projectId: alpha.id, projectName: 'Alpha' });
    const refused = await (tokensRoute.POST as unknown as (r: Request) => Promise<Response>)(
      new Request(`${INSTANCE}/api/mcp/tokens`, { method: 'POST', headers: as(outsider), body: JSON.stringify({ label: 'via rest', projectId: alpha.id }) }),
    );
    expect(refused.status).toBe(403);
  });

  it('serves project metadata (RFC 9728) at the well-known path', async () => {
    const response = await (prmRoute.GET as unknown as (r: Request, c: unknown) => Promise<Response>)(new Request(`${INSTANCE}/.well-known/oauth-protected-resource/api/mcp/projects/${alpha.id}`), { params: Promise.resolve({ id: alpha.id }) });
    const doc = await response.json();
    expect(doc.resource).toBe(`${INSTANCE}/api/mcp/projects/${alpha.id}`);
    const challenge = (await rpc(`${root}/projects/${alpha.id}`, 'tools/list', {}, { authorization: 'Bearer lf_mcp_wrong' }, alpha.id)).status;
    expect(challenge).toBe(401);
  });

  it('registers one gateway route per enabled project and removes it again', async () => {
    const adapter = {
      kind: 'test',
      location: 'memory',
      targets: new Map<string, unknown>(),
      routes: new Map<string, unknown>(),
      async health() {
        return { ok: true };
      },
      async list() {
        return [...this.targets.values()] as never;
      },
      async upsert(target: { name: string; value: unknown }) {
        this.targets.set(target.name, target.value);
      },
      async remove(name: string) {
        this.targets.delete(name);
      },
      async listRoutes() {
        return [...this.routes.values()] as never;
      },
      async upsertRoute(route: { name: string; value: unknown }) {
        this.routes.set(route.name, route.value);
      },
      async removeRoute(name: string) {
        this.routes.delete(name);
      },
    };
    const sync = new McpGatewaySync({
      mode: 'bundled',
      adapter: adapter as never,
      plugins: () => [],
      servers: registryServers,
      store: new MemoryOwnedStore(),
      routes: true,
      secret: () => SECRET,
      hostUrl: () => 'http://127.0.0.1:3000',
      onChanged: () => {},
      purge: null,
    });
    await sync.reconcile();
    const name = entryForServer({ kind: 'project', projectId: alpha.id, label: '' }).name;
    expect([...adapter.routes.keys()].some((n) => n.includes('project'))).toBe(false);

    // The project's admin turns it on through the REST route.
    const admin = await createUser({ email: 'admin@projects.test', name: 'Admin', role: 'admin', password: 'admin-pass-123' });
    const cookie = { cookie: `landflow_session=${createSession(admin, 'password').token}`, 'content-type': 'application/json' };
    const setGateway = (gateway: boolean) =>
      (settingsRoute.PATCH as unknown as (r: Request, c: unknown) => Promise<Response>)(new Request(`${INSTANCE}/api/projects/${alpha.id}/mcp`, { method: 'PATCH', headers: cookie, body: JSON.stringify({ gateway }) }), { params: Promise.resolve({ id: alpha.id }) });
    const patch = await setGateway(true);
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({ gateway: true, path: `/api/mcp/projects/${alpha.id}`, gatewayPath: `/mcp/projects/${name}`, instanceEnabled: true });

    const result = await sync.reconcile();
    expect(result.upserted).toContain(name);
    const target = adapter.targets.get(name) as { mcp: { host: string } };
    expect(target.mcp.host).toBe(`http://127.0.0.1:3000/api/mcp/projects/${encodeURIComponent(alpha.id)}`);
    const route = [...adapter.routes.values()].find((r) => (r as { name: string }).name.includes(name)) as { matches: Array<{ path: { exact: string } }> };
    expect(route.matches[0].path.exact).toBe(`/mcp/projects/${name}`);

    // The gateway caller (a Landflow token resolved to its project) goes through the project route too.
    const through = await rpc(`${root}/projects/${alpha.id}`, 'tools/call', { name: 'list_workflows', arguments: {} }, { 'x-landflow-gateway': SECRET, 'x-landflow-caller-iss': INSTANCE, 'x-landflow-caller-sub': member.id }, alpha.id);
    expect(through.status).toBe(200);
    expect(JSON.parse(text(through.body.result)).workflows.map((w: { id: string }) => w.id)).not.toContain('wf_b1');

    // Off again: the route goes.
    await setGateway(false);
    expect((await sync.reconcile()).removed).toContain(name);
    expect(adapter.targets.has(name)).toBe(false);
    // And with the instance server off, a project's route is not wanted even when flagged.
    setMcpEnabled(false);
    expect((await rpc(`${root}/projects/${alpha.id}`, 'tools/list', {}, { authorization: `Bearer ${access}` }, alpha.id)).status).toBe(403);
  });
});

afterAll(async () => {
  await closeMcpEndpoints();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});
