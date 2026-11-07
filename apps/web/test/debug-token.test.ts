/**
 * Debug tokens (docs/specs/19-debug-token.md; lib/server/auth/debug-tokens.ts, lib/server/mcp/debug-token-server.ts):
 * minted over REST by someone who can read the execution, they open three read-only tools of /api/mcp for that one execution,
 * redacted, audited per call, expiring and revocable, and nothing else on the host accepts them.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-debug-token-'));
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
const { variables } = await import('@/lib/server/variables');
const { credentials } = await import('@/lib/server/credentials/vault');
const { runWorkflow } = await import('@/lib/server/runner');
const { createUser, setUserDisabled } = await import('@/lib/server/auth/users');
const { createSession } = await import('@/lib/server/auth/sessions');
const { createTeamProject, setHomeProject, setMember, removeMember } = await import('@/lib/server/projects/store');
const { setMcpEnabled } = await import('@/lib/server/mcp/instance');
const { closeMcpEndpoints } = await import('@/lib/server/mcp/server');
const { queryEvents } = await import('@/lib/server/audit/store');
const dbt = await import('@/lib/server/auth/debug-tokens');
const { defineNode, definePlugin } = await import('@landflow/sdk');
const mcpRoute = await import('@/app/api/mcp/route');
const mintRoute = await import('@/app/api/executions/[id]/debug-tokens/route');
const revokeRoute = await import('@/app/api/executions/[id]/debug-tokens/[tokenId]/route');
const executionRoute = await import('@/app/api/executions/[id]/route');
const workflowsRoute = await import('@/app/api/workflows/route');
const pluginMcpRoute = await import('@/app/api/mcp/plugins/[id]/route');
const projectMcpRoute = await import('@/app/api/mcp/projects/[id]/route');

afterAll(async () => {
  await closeMcpEndpoints();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const VAR_SECRET = 'vars-secret-value-4242';
const CRED_SECRET = 'credential-secret-value-777';

registry.registerBuiltin(corePlugin);
registry.registerBuiltin(
  definePlugin({
    info: { id: 'dbgtok', name: 'Debug token test', version: '1.0.0', language: 'typescript' },
    nodes: [
      defineNode({
        description: { name: 'writer', displayName: 'Writer', version: 1, kind: 'action', inputs: ['main'], outputs: ['main'], properties: [] },
        async execute() {
          // The password-named key is blanked whatever its value; the other value is a known $vars secret.
          return [[{ json: { url: 'http://page.test', password: 'hunter2', note: `copied ${VAR_SECRET}` } }]];
        },
      }),
      defineNode({
        description: { name: 'boom', displayName: 'Boom', version: 1, kind: 'action', inputs: ['main'], outputs: ['main'], properties: [{ name: 'target', displayName: 'Target', type: 'string', default: '' }] },
        async execute() {
          throw new Error(`401 unauthorized for ${VAR_SECRET} and ${CRED_SECRET}`);
        },
      }),
    ],
  }),
);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Route = (r: Request, c?: unknown) => Promise<Response>;
const asRoute = (handler: unknown) => handler as Route;

const text = (result: Json | undefined) => ((result?.content as Array<{ text: string }> | undefined)?.[0]?.text ?? '') as string;

async function rpc(method: string, params: unknown, headers: Record<string, string>, route: Route = asRoute(mcpRoute.POST), ctx?: unknown): Promise<{ status: number; body: Json; raw: string }> {
  const response = await route(
    new Request(`${INSTANCE}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    ctx,
  );
  const raw = await response.text();
  let body: Json = {};
  try {
    body = JSON.parse(raw.includes('data:') ? raw.split('\n').find((l) => l.startsWith('data:'))!.slice(5) : raw) as Json;
  } catch {}
  return { status: response.status, body, raw };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const callTool = (token: string, name: string, args: Record<string, unknown>) => rpc('tools/call', { name, arguments: args }, bearer(token));
const cookieOf = (user: Parameters<typeof createSession>[0]) => ({ cookie: `landflow_session=${createSession(user, 'password').token}`, 'content-type': 'application/json' });

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
const link = (source: string, target: string) => ({ id: `${source}-${target}`, type: 'main' as const, source, target, sourceIndex: 0, targetIndex: 0 });

describe('debug tokens', () => {
  let owner: Awaited<ReturnType<typeof createUser>>;
  let member: Awaited<ReturnType<typeof createUser>>;
  let outsider: Awaited<ReturnType<typeof createUser>>;
  let alpha: { id: string };
  let beta: { id: string };
  let execA = '';
  let execA2 = '';
  let execB = '';

  const mint = async (user: typeof member, executionId: string, body: Record<string, unknown> = {}) => {
    const response = await asRoute(mintRoute.POST)(new Request(`${INSTANCE}/api/executions/${executionId}/debug-tokens`, { method: 'POST', headers: cookieOf(user), body: JSON.stringify(body) }), { params: Promise.resolve({ id: executionId }) });
    return { status: response.status, body: (await response.json()) as Json };
  };
  const audits = () => queryEvents({ actions: ['mcp.tool.call'] }, { limit: 500 }).events.filter((e) => e.details?.via === 'debug-token' || e.details?.kind === 'debug');
  const listTools = async (token: string) => ((await rpc('tools/list', {}, bearer(token))).body.result?.tools as Array<{ name: string }> | undefined)?.map((t) => t.name).sort();

  it('sets up two projects and three failed executions', async () => {
    owner = await createUser({ email: 'owner@dbg.test', name: 'Owner', role: 'owner', password: 'owner-pass-123' });
    member = await createUser({ email: 'member@dbg.test', name: 'Member', role: 'member', password: 'member-pass-123' });
    outsider = await createUser({ email: 'outsider@dbg.test', name: 'Outsider', role: 'member', password: 'outsider-pass-123' });
    alpha = createTeamProject({ name: 'Alpha', createdBy: owner.id });
    beta = createTeamProject({ name: 'Beta', createdBy: owner.id });
    setMember(alpha.id, member.id, 'editor');
    variables.create({ key: 'API_TOKEN', value: VAR_SECRET });
    const cred = credentials.create({ name: 'Header auth', type: 'core.httpHeaderAuth', data: { name: 'X-Key', value: CRED_SECRET } });
    const ref = { id: cred.id, name: cred.name };
    const flow = (id: string, project: string): Workflow => {
      setHomeProject('workflow', id, project);
      return store.saveWorkflow({
        id,
        name: id,
        nodes: [node('Start', 'core.manualTrigger'), node('Writer', 'dbgtok.writer'), node('Boom', 'dbgtok.boom', { target: '{{ $json.url }} {{ $vars.API_TOKEN }}' }, { credentials: { 'core.httpHeaderAuth': ref } })],
        connections: [link('Start', 'Writer'), link('Writer', 'Boom')],
      } as Workflow);
    };
    const ranA = await runWorkflow({ workflow: flow('wf_dbg_a', alpha.id), mode: 'manual' });
    const ranA2 = await runWorkflow({ workflow: store.getWorkflow('wf_dbg_a')!, mode: 'manual' });
    const ranB = await runWorkflow({ workflow: flow('wf_dbg_b', beta.id), mode: 'manual' });
    [execA, execA2, execB] = [ranA.executionId, ranA2.executionId, ranB.executionId];
    expect([ranA.status, ranA2.status, ranB.status]).toEqual(['error', 'error', 'error']);
    setMcpEnabled(true);
  });

  it('mints for someone who can read the execution, and shows the token once', async () => {
    const minted = await mint(member, execA, { label: 'for claude' });
    expect(minted.status).toBe(201);
    expect(minted.body.token).toMatch(/^lf_dbg_[\w-]{40,}$/);
    expect(minted.body.record).toMatchObject({ executionId: execA, workflowId: 'wf_dbg_a', scopes: ['executions:read', 'trace:read'], createdBy: member.id, label: 'for claude', uses: 0 });
    const ttl = Date.parse(minted.body.record.expiresAt) - Date.parse(minted.body.record.createdAt);
    expect(ttl).toBe(3_600_000);
    expect(minted.body.mcp).toEqual({ enabled: true, path: '/api/mcp' });
    // Listed without the token; the database holds only its hash.
    const listed = await asRoute(mintRoute.GET)(new Request(`${INSTANCE}/api/executions/${execA}/debug-tokens`, { headers: cookieOf(member) }), { params: Promise.resolve({ id: execA }) });
    const body = await listed.text();
    expect(JSON.parse(body).tokens).toHaveLength(1);
    expect(body).not.toContain(minted.body.token);
    expect(JSON.stringify(dbt.listDebugTokens())).not.toContain(minted.body.token);
  });

  it('refuses minting for the wrong people and the wrong values', async () => {
    expect((await mint(outsider, execA)).status).toBe(404); // cannot read the workflow: it does not exist for them
    expect((await mint(member, execB)).status).toBe(404); // another project's execution
    expect((await mint(member, 'ex_missing')).status).toBe(404);
    expect((await mint(member, execA, { ttlSeconds: 30 })).status).toBe(400);
    expect((await mint(member, execA, { ttlSeconds: 86_401 })).status).toBe(400);
    expect((await mint(member, execA, { scopes: ['executions:write'] })).status).toBe(400);
    expect((await mint(member, execA, { scopes: [] })).status).toBe(400);
    expect(() => dbt.mintDebugToken(outsider, { executionId: execA, workflowId: 'wf_dbg_a' })).toThrow(/not found/);
  });

  it('opens exactly three tools for the bound execution, redacted', async () => {
    const { body: { token } } = await mint(member, execA);
    expect(await listTools(token)).toEqual(['explain_failure', 'get_execution', 'get_run_trace']);

    const explained = await callTool(token, 'explain_failure', { id: execA });
    expect(explained.body.result?.isError).toBeFalsy();
    const data = JSON.parse(text(explained.body.result));
    expect(data.failedNode).toMatchObject({ name: 'Boom', type: 'dbgtok.boom' });
    expect(data.error.message).toBe('401 unauthorized for [redacted] and [redacted]');
    expect(data.resolvedParameters.target).toBe('http://page.test [redacted]');
    expect(data.sampleInput.password).toBe('[redacted]');

    const trace = await callTool(token, 'get_run_trace', { id: execA });
    expect(JSON.parse(text(trace.body.result)).events.length).toBeGreaterThan(0);

    const exec = await callTool(token, 'get_execution', { id: execA, includeData: true });
    const full = JSON.parse(text(exec.body.result));
    expect(full).toMatchObject({ id: execA, status: 'error', workflowId: 'wf_dbg_a' });
    expect(JSON.stringify(full.runData)).toContain('http://page.test');

    // Credentials, $vars and secret-named keys are in none of it.
    for (const out of [explained.raw, trace.raw, exec.raw]) {
      expect(out).not.toContain(VAR_SECRET);
      expect(out).not.toContain(CRED_SECRET);
      expect(out).not.toContain('hunter2');
    }
    expect(explained.raw).toContain('[redacted]');
  });

  it('reads no other execution: another run of the same workflow, another project’s run, or one that does not exist', async () => {
    const { body: { token } } = await mint(member, execA);
    const answers = [];
    for (const tool of ['explain_failure', 'get_run_trace', 'get_execution']) {
      for (const id of [execA2, execB, 'ex_missing', '']) {
        const reply = await callTool(token, tool, { id });
        expect(reply.body.result?.isError, `${tool} ${id}`).toBe(true);
        expect(reply.raw).not.toContain('Boom');
        answers.push(id ? text(reply.body.result).replace(id, '<id>') : text(reply.body.result).replace('Execution  not', 'Execution <id> not'));
      }
    }
    // A run that exists answers like one that does not.
    expect([...new Set(answers)], JSON.stringify(answers)).toHaveLength(1);
    // A call without an id is refused too.
    expect((await callTool(token, 'get_execution', {})).body.result?.isError ?? true).toBe(true);
  });

  it('refuses every other tool, at /api/mcp, and changes nothing', async () => {
    const { body: { token } } = await mint(member, execA);
    const before = JSON.stringify(store.workflowSummaries());
    const names = ['list_workflows', 'get_workflow', 'create_workflow', 'update_workflow', 'validate_workflow', 'list_node_types', 'search_node_types', 'get_node_type', 'execute_workflow', 'list_executions', 'get_plugin_logs', 'retry_execution', 'run_node'];
    const args: Record<string, Record<string, unknown>> = {
      get_workflow: { id: 'wf_dbg_a' },
      create_workflow: { name: 'Sneaky', nodes: [{ name: 'Start', type: 'core.manualTrigger' }] },
      update_workflow: { id: 'wf_dbg_a', name: 'Hijacked' },
      validate_workflow: { id: 'wf_dbg_a' },
      get_node_type: { type: 'core.set' },
      search_node_types: { query: 'set' },
      execute_workflow: { id: 'wf_dbg_a' },
      get_plugin_logs: { plugin: 'dbgtok' },
      retry_execution: { id: execA },
      run_node: { workflowId: 'wf_dbg_a', node: 'Writer', input: {} },
    };
    for (const name of names) {
      const reply = await callTool(token, name, args[name] ?? {});
      const refused = reply.body.error !== undefined || reply.body.result?.isError === true;
      expect(refused, `${name}: ${reply.raw.slice(0, 200)}`).toBe(true);
      expect(reply.raw).not.toContain('Sneaky');
    }
    expect(JSON.stringify(store.workflowSummaries())).toBe(before);
    expect(store.getWorkflow('wf_dbg_a')?.name).toBe('wf_dbg_a');
    expect(store.listExecutions({ workflowId: 'wf_dbg_a', limit: 50 })).toHaveLength(2);
  });

  it('is accepted by nothing else: no REST route, no plugin or project MCP endpoint', async () => {
    const { body: { token } } = await mint(member, execA);
    const headers = bearer(token);
    const rest = await asRoute(executionRoute.GET)(new Request(`${INSTANCE}/api/executions/${execA}`, { headers }), { params: Promise.resolve({ id: execA }) });
    expect(rest.status).toBe(401);
    expect(await rest.text()).not.toContain('Boom');
    expect((await asRoute(workflowsRoute.GET)(new Request(`${INSTANCE}/api/workflows`, { headers }))).status).toBe(401);
    // As an API key header too.
    expect((await asRoute(workflowsRoute.GET)(new Request(`${INSTANCE}/api/workflows`, { headers: { 'x-landflow-api-key': token } }))).status).toBe(401);
    // It cannot mint more tokens.
    const again = await asRoute(mintRoute.POST)(new Request(`${INSTANCE}/api/executions/${execA}/debug-tokens`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' }), { params: Promise.resolve({ id: execA }) });
    expect(again.status).toBe(401);
    expect(dbt.listDebugTokens({ executionId: execA }).every((t) => t.createdBy === member.id)).toBe(true);
    // Plugin and project MCP endpoints.
    const plugin = await rpc('tools/list', {}, headers, asRoute(pluginMcpRoute.POST), { params: Promise.resolve({ id: 'core' }) });
    expect(plugin.status).toBe(403);
    const project = await rpc('tools/list', {}, headers, asRoute(projectMcpRoute.POST), { params: Promise.resolve({ id: alpha.id }) });
    expect(project.status).toBe(403);
  });

  it('honours the scopes', async () => {
    const readOnly = (await mint(member, execA, { scopes: ['executions:read'] })).body.token;
    const traceOnly = (await mint(member, execA, { scopes: ['trace:read'] })).body.token;
    expect((await callTool(readOnly, 'get_execution', { id: execA })).body.result?.isError).toBeFalsy();
    expect((await callTool(readOnly, 'explain_failure', { id: execA })).body.result?.isError).toBeFalsy();
    const noTrace = await callTool(readOnly, 'get_run_trace', { id: execA });
    expect(noTrace.body.result?.isError).toBe(true);
    expect(text(noTrace.body.result)).toMatch(/trace:read/);
    expect((await callTool(traceOnly, 'get_run_trace', { id: execA })).body.result?.isError).toBeFalsy();
    const noExec = await callTool(traceOnly, 'get_execution', { id: execA });
    expect(noExec.body.result?.isError).toBe(true);
    expect((await callTool(traceOnly, 'explain_failure', { id: execA })).body.result?.isError).toBe(true);
  });

  it('expires', async () => {
    const past = Date.now() - 2 * 3_600_000;
    const { token, record } = dbt.mintDebugToken(member, { executionId: execA, workflowId: 'wf_dbg_a' }, past);
    expect(Date.parse(record.expiresAt)).toBeLessThan(Date.now());
    expect(dbt.verifyDebugToken(token, past + 1000).ok).toBe(true);
    expect(dbt.verifyDebugToken(token)).toMatchObject({ ok: false, reason: 'expired' });
    const reply = await callTool(token, 'explain_failure', { id: execA });
    expect(reply.status).toBe(401);
    expect(reply.raw).toMatch(/expired/);
    expect(reply.raw).not.toContain('Boom');
    // The refusal is audited against the token.
    expect(audits().some((e) => e.outcome === 'denied' && e.details?.debugId === record.id && e.details?.reason === 'expired')).toBe(true);
  });

  it('is revoked on the next call, by its minter or an admin, and by no one else', async () => {
    const { body: { token, record } } = await mint(member, execA);
    expect((await callTool(token, 'get_execution', { id: execA })).body.result?.isError).toBeFalsy();
    const revoke = (user: typeof member, executionId = execA) =>
      asRoute(revokeRoute.DELETE)(new Request(`${INSTANCE}/api/executions/${executionId}/debug-tokens/${record.id}`, { method: 'DELETE', headers: cookieOf(user) }), { params: Promise.resolve({ id: executionId, tokenId: record.id }) });
    expect((await revoke(outsider)).status).toBe(404);
    expect((await revoke(member, execA2)).status).toBe(404); // the id of another execution
    const done = await revoke(member);
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ revoked: true, record: { revokedAt: expect.any(String), revokedBy: member.id } });
    const after = await callTool(token, 'get_execution', { id: execA });
    expect(after.status).toBe(401);
    expect(after.raw).toMatch(/revoked/);
    expect((await (await revoke(member)).json()).revoked).toBe(false);
    // Another token, revoked by the owner (an admin).
    const second = (await mint(member, execA)).body;
    const byOwner = await asRoute(revokeRoute.DELETE)(new Request(`${INSTANCE}/api/executions/${execA}/debug-tokens/${second.record.id}`, { method: 'DELETE', headers: cookieOf(owner) }), { params: Promise.resolve({ id: execA, tokenId: second.record.id }) });
    expect((await byOwner.json()).revoked).toBe(true);
    expect((await callTool(second.token, 'get_execution', { id: execA })).status).toBe(401);
    // A made-up token.
    expect((await callTool('lf_dbg_nonsense', 'get_execution', { id: execA })).status).toBe(401);
  });

  it('dies with its minter: a deactivated user, or one who lost access to the workflow', async () => {
    const other = await createUser({ email: 'temp@dbg.test', name: 'Temp', role: 'member', password: 'temp-pass-12345' });
    setMember(alpha.id, other.id, 'viewer');
    const { body: { token } } = await mint(other, execA);
    expect((await callTool(token, 'get_execution', { id: execA })).body.result?.isError).toBeFalsy();
    removeMember(alpha.id, other.id);
    const lost = await callTool(token, 'get_execution', { id: execA });
    expect(lost.status).toBe(401);
    expect(lost.raw).toMatch(/no longer allowed/);
    setMember(alpha.id, other.id, 'viewer');
    expect((await callTool(token, 'get_execution', { id: execA })).body.result?.isError).toBeFalsy();
    setUserDisabled(other.id, true);
    expect((await callTool(token, 'get_execution', { id: execA })).status).toBe(401);
  });

  it('lists what the Debug access dialog shows: prefix hint, scopes, expiry, last use and uses, revoked rows included, never the token', async () => {
    const { body: { token, record } } = await mint(member, execA2, { label: 'ui list', scopes: ['trace:read'], ttlSeconds: 900 });
    const read = async (user: typeof member, executionId = execA2) => {
      const response = await asRoute(mintRoute.GET)(new Request(`${INSTANCE}/api/executions/${executionId}/debug-tokens`, { headers: cookieOf(user) }), { params: Promise.resolve({ id: executionId }) });
      const text = await response.text();
      return { text, tokens: (JSON.parse(text) as { tokens: Array<Record<string, unknown>> }).tokens };
    };
    const before = (await read(member)).tokens.find((t) => t.id === record.id)!;
    expect(before).toMatchObject({ hint: token.slice(-4), label: 'ui list', scopes: ['trace:read'], uses: 0 });
    expect(before.lastUsedAt).toBeUndefined();
    expect(Date.parse(before.expiresAt as string) - Date.parse(before.createdAt as string)).toBe(900_000);
    // The token works, and the list shows its use.
    expect((await callTool(token, 'get_run_trace', { id: execA2 })).status).toBe(200);
    const used = (await read(member)).tokens.find((t) => t.id === record.id)!;
    expect(used.uses).toBe(1);
    expect(typeof used.lastUsedAt).toBe('string');
    // Revoked through the route, it stays listed as revoked and is refused at once.
    const done = await asRoute(revokeRoute.DELETE)(new Request(`${INSTANCE}/api/executions/${execA2}/debug-tokens/${record.id}`, { method: 'DELETE', headers: cookieOf(member) }), { params: Promise.resolve({ id: execA2, tokenId: record.id }) });
    expect(done.status).toBe(200);
    const after = await read(member);
    expect(after.tokens.find((t) => t.id === record.id)).toMatchObject({ revokedAt: expect.any(String) });
    expect(after.text).not.toContain(token);
    expect((await callTool(token, 'get_run_trace', { id: execA2 })).status).toBe(401);
    // Someone who cannot read the run sees none of it.
    expect((await read(outsider)).text).toBe('{"error":"Execution not found"}');
  });

  it('stops after its use cap and limits live tokens per execution', async () => {
    const { token, record } = dbt.mintDebugToken(member, { executionId: execA2, workflowId: 'wf_dbg_a' });
    for (let i = 0; i < dbt.DEBUG_TOKEN_MAX_USES; i++) dbt.recordDebugUse(record.id);
    expect(dbt.verifyDebugToken(token)).toMatchObject({ ok: false, reason: 'exhausted' });
    expect((await callTool(token, 'get_execution', { id: execA2 })).status).toBe(401);
    for (let i = 0; i < dbt.DEBUG_TOKEN_MAX_LIVE_PER_EXECUTION; i++) dbt.mintDebugToken(member, { executionId: execA2, workflowId: 'wf_dbg_a' });
    expect(() => dbt.mintDebugToken(member, { executionId: execA2, workflowId: 'wf_dbg_a' })).toThrow(/live debug tokens/);
    expect(dbt.revokeDebugTokensOf(execA2, owner.id)).toBeGreaterThan(0);
    expect(dbt.purgeDebugTokens({ olderThanDays: 0, now: Date.now() + 1000 })).toBeGreaterThan(0);
  });

  it('audits every use, refusals included, without the token in the log', async () => {
    const { body: { token, record } } = await mint(member, execA);
    const mine = () => audits().filter((e) => e.details?.debugId === record.id);
    expect(mine()).toEqual([]);
    await callTool(token, 'explain_failure', { id: execA });
    await callTool(token, 'get_run_trace', { id: execA });
    await callTool(token, 'get_execution', { id: execB });
    await callTool(token, 'list_workflows', {});
    const events = mine();
    const ok = events.filter((e) => e.outcome === 'success');
    expect(ok.map((e) => e.details?.tool).sort()).toEqual(['explain_failure', 'get_run_trace']);
    for (const e of ok) {
      expect(e).toMatchObject({ action: 'mcp.tool.call', actor: { type: 'anonymous' }, target: { type: 'execution', id: execA }, details: { via: 'debug-token', mintedBy: member.id, executionId: execA, workflowId: 'wf_dbg_a' } });
    }
    expect(events.find((e) => e.outcome === 'denied')).toMatchObject({ details: { tool: 'get_execution', reason: 'other execution' } });
    expect(dbt.getDebugToken(record.id)).toMatchObject({ uses: 2 });
    expect(dbt.getDebugToken(record.id)?.lastUsedAt).toBeTruthy();
    expect(JSON.stringify(queryEvents({}, { limit: 1000 }).events)).not.toContain(token);
    // Minting and revoking are audited as well.
    const issued = queryEvents({ actions: ['mcp.token.issue'] }, { limit: 1000 }).events.find((e) => e.action === 'mcp.token.issue' && e.target?.id === record.id);
    expect(issued).toMatchObject({ details: { kind: 'debug', executionId: execA } });
  });
});
