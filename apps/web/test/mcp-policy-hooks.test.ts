/**
 * C14 (P14): the MCP policy hook. The engine seam (T-1), the store and the decision against a fake policy service
 * (T-2), and the hook in the MCP client, the MCP Client node and agents' tools against a local MCP server (T-3).
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { executeWorkflow, inProcessNodeType, type ExecutionEvent, type NodeTypeResolver, type WorkflowConnection, type WorkflowNode } from '@landflow/engine';
import type { Agent, AgentConfig } from '@/lib/shared/agents';
import type { McpPolicyHook } from '@/lib/shared/mcp-policy';
import { startFakeOpenAi, type ChatReply, type FakeServer } from './fake-openai';

const dataDir = mkdtempSync(join(tmpdir(), 'lf-mcp-policy-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { credentials } = await import('@/lib/server/credentials/vault');
const { agentToolsFrom, callMcpTool, closeMcpClients, endpointFrom, getMcpPrompt, listMcpTools, readMcpResource, toolOutput } = await import('@/lib/server/mcp/client');
const { runInNode, activeNode } = await import('@/lib/server/ai-usage/node-context');
const { runInUsageScope, UsageScope } = await import('@/lib/server/ai-usage/scope');
const { createPolicyHook, deletePolicyHook, listPolicyHooks, updatePolicyHook, PolicyHookError } = await import('@/lib/server/mcp/policy-hooks');
const { checkMcpCall, matches, resetPolicyCache } = await import('@/lib/server/mcp/policy-check');
const { signature } = await import('@/lib/server/alerts/channels');
const { queryEvents } = await import('@/lib/server/audit/store');
const { hostMetrics } = await import('@/lib/server/telemetry/metrics');
const { createTranslator } = await import('@/lib/server/journal/translator');
const { buildToolset } = await import('@/lib/server/agents/tools');
const { mcpClientNode } = await import('@/lib/server/nodes/mcp');
const { run } = await import('./helpers');
const { items } = await import('./helpers');

registry.registerBuiltin(corePlugin);

// ---------------------------------------------------------------------------
// A fake policy service and a local MCP server
// ---------------------------------------------------------------------------

interface Seen {
  body: Record<string, unknown>;
  raw: string;
  headers: IncomingMessage['headers'];
}
let policy: Server;
let policyUrl = '';
const seenByPolicy: Seen[] = [];
/** What the fake service answers for a body: a status and a JSON value, or a delay first. */
let answer: (body: Record<string, any>) => { status?: number; json?: unknown; text?: string; delayMs?: number } = () => ({ json: { decision: 'allow' } });

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => resolve(raw));
  });

const mcpCalls: Array<{ tool: string }> = [];
let mcpServer: Server;
let mcpOrigin = '';

function remoteServer() {
  const server = new McpServer({ name: 'issues', version: '1.0.0' });
  for (const name of ['list_issues', 'create_issue', 'delete_issue']) {
    server.registerTool(name, { description: name, inputSchema: z.object({ repo: z.string().optional(), token: z.string().optional() }) }, async () => {
      mcpCalls.push({ tool: name });
      return { content: [{ type: 'text', text: `${name} done` }] };
    });
  }
  server.registerResource('readme', 'file:///readme', { description: 'readme' }, async () => ({ contents: [{ uri: 'file:///readme', text: 'hello' }] }));
  server.registerPrompt('greet', { description: 'greet' }, async () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] }));
  return server;
}
const modern = createMcpHandler(() => remoteServer());

beforeAll(async () => {
  policy = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const raw = await readBody(req);
    const body = JSON.parse(raw || '{}');
    seenByPolicy.push({ body, raw, headers: req.headers });
    const reply = answer(body);
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
    res.end(reply.text ?? JSON.stringify(reply.json ?? {}));
  });
  await new Promise<void>((resolve) => policy.listen(0, '127.0.0.1', resolve));
  policyUrl = `http://127.0.0.1:${(policy.address() as AddressInfo).port}/decide`;

  mcpServer = createServer(async (req, res) => {
    const raw = await readBody(req);
    const request = new Request(`${mcpOrigin}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, ...(raw && { body: raw }) });
    const response = await modern.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => mcpServer.listen(0, '127.0.0.1', resolve));
  mcpOrigin = `http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await closeMcpClients();
  await modern.close();
  mcpServer.closeAllConnections();
  policy.closeAllConnections();
  await Promise.all([new Promise((r) => mcpServer.close(r)), new Promise((r) => policy.close(r))]);
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const clearHooks = () => listPolicyHooks().forEach((h) => deletePolicyHook(h.id));
let secret: { id: string; name: string };

beforeEach(() => {
  clearHooks();
  resetPolicyCache();
  seenByPolicy.length = 0;
  mcpCalls.length = 0;
  answer = () => ({ json: { decision: 'allow' } });
  secret ??= credentials.create({ name: 'Policy key', type: 'core.httpBearerAuth', data: { token: 'hook-signing-key' } });
});
afterEach(() => vi.restoreAllMocks());

const hookInput = (over: Record<string, unknown> = {}) => ({ name: 'Policy', url: policyUrl, auth: 'hmac' as const, credentialId: secret.id, ...over }) as never;
const subject = (tool: string, args: Record<string, unknown> = {}, serverUrl = 'http://mcp.local/mcp') => ({ method: 'tools/call' as const, serverUrl, tool, args });
const audits = (action: string) => queryEvents({ action: [action] }, { limit: 100 }).events;

// ---------------------------------------------------------------------------
// T-1: the engine seam
// ---------------------------------------------------------------------------

describe('the engine seam (T-1)', () => {
  const endpoint = { url: 'http://mcp.local/mcp' } as never;

  it('copies the MCP read-only hint onto the agent tool', () => {
    const tools = agentToolsFrom(endpoint, [
      { name: 'list_x', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } },
      { name: 'make_x', inputSchema: { type: 'object' } },
      { name: 'zap_x', annotations: { readOnlyHint: false }, inputSchema: { type: 'object' } },
    ] as never);
    expect(tools.map((t) => t.readOnlyHint)).toEqual([true, undefined, undefined]);
  });

  it('marks the resource and prompt tools read-only', async () => {
    const { resourceAndPromptTools } = await import('@/lib/server/mcp/client');
    const tools = resourceAndPromptTools(endpoint, ['resources', 'prompts']);
    expect(tools).toHaveLength(4);
    expect(tools.every((t) => t.readOnlyHint === true)).toBe(true);
  });

  it('keeps the engine report on the active node', async () => {
    const seen: unknown[] = [];
    await runInNode({ id: 'n', name: 'N', type: 't', report: (record) => void seen.push(record) }, async () => {
      activeNode()?.report?.({ type: 'check', name: 'policy', status: 'pass' });
    });
    expect(seen).toEqual([{ type: 'check', name: 'policy', status: 'pass' }]);
  });
});

// ---------------------------------------------------------------------------
// T-2: the store
// ---------------------------------------------------------------------------

describe('the store', () => {
  it('creates, changes and removes hooks, auditing each without the credential', () => {
    const hook = createPolicyHook(hookInput({ match: { hosts: ['Mcp.Local'], tools: ['create_*'], methods: ['tools/call'], projects: [] } }), 'usr_1');
    expect(listPolicyHooks().map((h) => h.id)).toEqual([hook.id]);
    expect(hook).toMatchObject({ failureMode: 'open', timeoutMs: 2000, enabled: true, match: { hosts: ['mcp.local'], tools: ['create_*'] } });
    const changed = updatePolicyHook(hook.id, { name: 'Renamed', failureMode: 'closed', match: { tools: ['delete_*'] } }, 'usr_1');
    expect(changed).toMatchObject({ name: 'Renamed', failureMode: 'closed', match: { hosts: ['mcp.local'], tools: ['delete_*'] } });
    // A change names only what it changes: the signing and the credential stay.
    expect(changed).toMatchObject({ auth: 'hmac', credentialId: secret.id, timeoutMs: 2000, enabled: true });
    deletePolicyHook(hook.id, 'usr_1');
    expect(listPolicyHooks()).toEqual([]);
    const created = audits('mcp.policy_hook.create').find((e) => e.target?.id === hook.id)!;
    expect(created.actor.id).toBe('usr_1');
    expect(JSON.stringify(audits('mcp.policy_hook.update').find((e) => e.target?.id === hook.id)!.details)).toContain('Renamed');
    expect(audits('mcp.policy_hook.delete').some((e) => e.target?.id === hook.id)).toBe(true);
    for (const event of [...audits('mcp.policy_hook.create'), ...audits('mcp.policy_hook.update')]) {
      expect(JSON.stringify(event)).not.toContain('hook-signing-key');
      expect(JSON.stringify(event)).not.toContain(secret.id);
    }
  });

  it('refuses a 21st hook, a missing credential, another credential type and a signing hook without a credential', () => {
    for (let i = 0; i < 20; i++) createPolicyHook(hookInput({ name: `h${i}` }));
    expect(() => createPolicyHook(hookInput())).toThrow(expect.objectContaining({ status: 409 }));
    clearHooks();
    const header = credentials.create({ name: 'Header', type: 'core.httpHeaderAuth', data: { name: 'x', value: 'y' } });
    expect(() => createPolicyHook(hookInput({ credentialId: header.id }))).toThrow(/Bearer Auth/);
    expect(() => createPolicyHook(hookInput({ credentialId: 'nope' }))).toThrow(/does not exist/);
    expect(() => createPolicyHook(hookInput({ credentialId: undefined }))).toThrow(/Choose a Bearer Auth credential/);
    expect(createPolicyHook(hookInput({ credentialId: undefined, auth: 'none' })).auth).toBe('none');
    expect(() => updatePolicyHook('ph_missing', {})).toThrow(PolicyHookError);
  });

  it('refuses a private address in the production profile unless it is allowed (AS-8), and fails closed by default there', () => {
    vi.stubEnv('LANDFLOW_PROFILE', 'production');
    try {
      expect(() => createPolicyHook(hookInput())).toThrow(/private address/);
      vi.stubEnv('LANDFLOW_OUTBOUND_ALLOW', '127.0.0.1');
      expect(createPolicyHook(hookInput()).failureMode).toBe('closed');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ---------------------------------------------------------------------------
// T-2: matching
// ---------------------------------------------------------------------------

describe('matching', () => {
  const base = (over: Partial<McpPolicyHook['match']> = {}): McpPolicyHook => ({
    id: 'h', name: 'h', enabled: true, url: policyUrl, auth: 'none', timeoutMs: 1000, failureMode: 'open', createdAt: '', updatedAt: '',
    match: { hosts: [], tools: [], methods: ['tools/call'], projects: [], ...over },
  });

  it('narrows by host, path, tool glob, method and project', () => {
    const s = subject('create_issue', {}, 'http://mcp.local:8080/github/mcp?token=x');
    expect(matches(base(), s, {})).toBe(true);
    expect(matches(base({ hosts: ['*.local'] }), s, {})).toBe(true);
    expect(matches(base({ hosts: ['other.com'] }), s, {})).toBe(false);
    expect(matches(base({ pathPrefix: '/github' }), s, {})).toBe(true);
    expect(matches(base({ pathPrefix: '/slack' }), s, {})).toBe(false);
    expect(matches(base({ tools: ['create_*'] }), s, {})).toBe(true);
    expect(matches(base({ tools: ['create_*'] }), subject('list_issues'), {})).toBe(false);
    expect(matches(base({ methods: ['resources/read'] }), s, {})).toBe(false);
    expect(matches(base({ projects: ['p1'] }), s, { projectId: 'p1' })).toBe(true);
    expect(matches(base({ projects: ['p1'] }), s, { projectId: 'p2' })).toBe(false);
    expect(matches(base({ projects: ['p1'] }), s, {})).toBe(false);
    expect(matches({ ...base(), enabled: false }, s, {})).toBe(false);
  });

  it('does not call a hook narrowed to create_* for list_issues (AS-2)', async () => {
    createPolicyHook(hookInput({ match: { tools: ['create_*'] } }));
    expect(await checkMcpCall(subject('list_issues'), {})).toEqual({ decision: 'allow', hooks: [] });
    expect(seenByPolicy).toHaveLength(0);
    expect((await checkMcpCall(subject('create_issue'), {})).decision).toBe('allow');
    expect(seenByPolicy).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// T-2: the request and the answers
// ---------------------------------------------------------------------------

describe('the request to the service', () => {
  it('sends the call with secrets masked and no credential, signed with the credential (AS-3)', async () => {
    createPolicyHook(hookInput());
    await checkMcpCall(subject('create_issue', { token: 'abc', repo: 'acme/x' }, 'http://user:pw@mcp.local/mcp?key=SECRETQ'), { executionId: 'ex_1', workflowId: 'wf', nodeId: 'n1', userId: 'usr_1', projectId: 'p1' });
    const [seen] = seenByPolicy;
    expect(seen.body).toMatchObject({ method: 'tools/call', tool: 'create_issue', server: { url: 'http://mcp.local/mcp' }, arguments: { token: '••••••', repo: 'acme/x' }, caller: { executionId: 'ex_1', workflowId: 'wf', nodeId: 'n1', userId: 'usr_1' }, projectId: 'p1' });
    expect(seen.body.requestId).toEqual(expect.any(String));
    for (const secretValue of ['hook-signing-key', 'SECRETQ', 'pw', '"abc"', secret.id]) expect(seen.raw).not.toContain(secretValue);
    const timestamp = String(seen.headers['x-landflow-timestamp']);
    expect(seen.headers['x-landflow-signature']).toBe(signature('hook-signing-key', timestamp, seen.raw));
    expect(seen.headers['x-landflow-signature']).toBe(`sha256=${createHmac('sha256', 'hook-signing-key').update(`${timestamp}.${seen.raw}`).digest('hex')}`);
    expect(seen.headers.authorization).toBeUndefined();
  });

  it('sends a bearer token when asked', async () => {
    createPolicyHook(hookInput({ auth: 'bearer' }));
    await checkMcpCall(subject('x'), {});
    expect(seenByPolicy[0].headers.authorization).toBe('Bearer hook-signing-key');
    expect(seenByPolicy[0].headers['x-landflow-signature']).toBeUndefined();
  });

  it('allows, and denies with the reason and rule id, and audits the deny', async () => {
    createPolicyHook(hookInput({ name: 'Finance' }));
    expect(await checkMcpCall(subject('list'), {})).toEqual({ decision: 'allow', hooks: ['Finance'] });
    answer = () => ({ json: { decision: 'deny', reason: 'no deletes on Friday', ruleId: 'no-deletes', extra: 1 } });
    const verdict = await checkMcpCall(subject('delete_issue'), { executionId: 'ex_2', userId: 'usr_9' });
    expect(verdict).toEqual({ decision: 'deny', hook: 'Finance', reason: 'no deletes on Friday', ruleId: 'no-deletes', failed: false });
    const event = audits('mcp.policy.denied')[0];
    expect(event).toMatchObject({ action: 'mcp.policy.denied', outcome: 'denied', actor: { id: 'usr_9' }, target: { type: 'mcp-server', name: 'mcp.local' }, details: { hook: 'Finance', tool: 'delete_issue', ruleId: 'no-deletes', executionId: 'ex_2' } });
  });

  it.each([
    ['a 500', () => ({ status: 500, text: 'boom' })],
    ['bad JSON', () => ({ text: 'not json' })],
    ['an unknown decision', () => ({ json: { decision: 'maybe' } })],
    ['a timeout', () => ({ json: { decision: 'allow' }, delayMs: 800 })],
  ])('treats %s as a failure: closed blocks, open lets it through (AS-4)', async (_label, reply) => {
    answer = reply;
    const hook = createPolicyHook(hookInput({ failureMode: 'closed', timeoutMs: 150 }));
    const closed = await checkMcpCall(subject('x'), { executionId: 'ex_f' });
    expect(closed).toEqual({ decision: 'deny', hook: 'Policy', reason: 'policy service unavailable', failed: true });
    expect(audits('mcp.policy.failed').length).toBeGreaterThan(0);
    updatePolicyHook(hook.id, { failureMode: 'open' });
    expect((await checkMcpCall(subject('x'), { executionId: 'ex_f' })).decision).toBe('allow');
  });

  it('asks several hooks in parallel and names the first deny in order', async () => {
    createPolicyHook(hookInput({ name: 'One' }));
    createPolicyHook(hookInput({ name: 'Two', url: `${policyUrl}?second=1` }));
    createPolicyHook(hookInput({ name: 'Three', url: `${policyUrl}?third=1` }));
    answer = () => ({ json: { decision: 'allow' } });
    expect((await checkMcpCall(subject('x'), {})).decision).toBe('allow');
    expect(seenByPolicy).toHaveLength(3);
    answer = (body) => ({ json: { decision: 'deny', reason: 'r' + String(body.tool) } });
    const verdict = await checkMcpCall(subject('y'), {});
    expect(verdict).toMatchObject({ decision: 'deny', hook: 'One' });
  });

  it('reuses an allow for the same call in one run, never a deny, and nothing without a run (AS-7)', async () => {
    createPolicyHook(hookInput());
    const ctx = { executionId: 'ex_c', workflowId: 'wf' };
    await checkMcpCall(subject('x', { a: 1 }), ctx);
    await checkMcpCall(subject('x', { a: 1 }), ctx);
    expect(seenByPolicy).toHaveLength(1);
    await checkMcpCall(subject('x', { a: 2 }), ctx);
    await checkMcpCall(subject('x', { a: 1 }), { executionId: 'ex_other' });
    expect(seenByPolicy).toHaveLength(3);
    await checkMcpCall(subject('z'), {});
    await checkMcpCall(subject('z'), {});
    expect(seenByPolicy).toHaveLength(5);
    answer = () => ({ json: { decision: 'deny', reason: 'no' } });
    await checkMcpCall(subject('d'), ctx);
    await checkMcpCall(subject('d'), ctx);
    expect(seenByPolicy).toHaveLength(7);
  });

  it('reports a check on the active node and counts decisions by decision and hook only (D3)', async () => {
    createPolicyHook(hookInput({ name: 'Counted', failureMode: 'closed', timeoutMs: 150 }));
    const reports: Array<Record<string, any>> = [];
    const counted = vi.spyOn(hostMetrics().mcpPolicyDecisions, 'add');
    const inNode = (fn: () => Promise<unknown>) => runInNode({ id: 'n', name: 'N', type: 't', report: (r) => void reports.push(r) }, fn);
    await inNode(() => checkMcpCall(subject('a'), {}));
    answer = () => ({ json: { decision: 'deny', reason: 'nope', ruleId: 'r1' } });
    await inNode(() => checkMcpCall(subject('b'), {}));
    answer = () => ({ status: 503 });
    await inNode(() => checkMcpCall(subject('c'), {}));
    expect(reports.map((r) => [r.name, r.status, r.evidence.decision])).toEqual([['policy', 'pass', 'allow'], ['policy', 'warn', 'deny'], ['policy', 'fail', 'failed_closed']]);
    expect(reports[1]).toMatchObject({ type: 'check', subject: 'b', message: expect.stringContaining('nope'), evidence: { hook: 'Counted', ruleId: 'r1' } });
    expect(counted.mock.calls.map((c) => c[1])).toEqual([{ decision: 'allow', hook: 'Counted' }, { decision: 'deny', hook: 'Counted' }, { decision: 'failed_closed', hook: 'Counted' }]);
    const hook = listPolicyHooks()[0];
    updatePolicyHook(hook.id, { failureMode: 'open' });
    reports.length = 0;
    await inNode(() => checkMcpCall(subject('d'), {}));
    expect(reports[0]).toMatchObject({ status: 'warn', evidence: { decision: 'failed_open' } });
  });

  it('takes the caller from the usage scope and the active node', async () => {
    createPolicyHook(hookInput());
    const scope = new UsageScope({ executionId: 'ex_s', workflowId: 'wf_s', agentId: 'ag_s', userId: 'usr_s', projectId: 'p_s' });
    await runInUsageScope(scope, () => runInNode({ id: 'node1', name: 'Node One', type: 't' }, () => checkMcpCall(subject('x'))));
    expect(seenByPolicy[0].body.caller).toEqual({ executionId: 'ex_s', workflowId: 'wf_s', nodeId: 'node1', nodeName: 'Node One', agentId: 'ag_s', userId: 'usr_s' });
    expect(seenByPolicy[0].body.projectId).toBe('p_s');
  });

  it('refuses a private policy address at call time in the production profile (fails per the failure mode)', async () => {
    createPolicyHook(hookInput({ failureMode: 'closed' }));
    vi.stubEnv('LANDFLOW_PROFILE', 'production');
    try {
      const verdict = await checkMcpCall(subject('x'), {});
      expect(verdict).toMatchObject({ decision: 'deny', failed: true });
      expect(seenByPolicy).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ---------------------------------------------------------------------------
// T-2: the check lands on the tool's span
// ---------------------------------------------------------------------------

describe('the Run Trace span', () => {
  it('puts the policy check of a tool sub-run on the tool span', async () => {
    createPolicyHook(hookInput());
    answer = () => ({ json: { decision: 'deny', reason: 'blocked here', ruleId: 'r' } });
    const events: ExecutionEvent[] = [];
    const { defineNode } = await import('@landflow/sdk');
    const main = [{ type: 'main' as const }];
    const base = { description: '', version: 1 };
    const trigger = defineNode({ description: { ...base, name: 'trigger', displayName: 'T', kind: 'trigger', inputs: [], outputs: main, properties: [] }, execute: (ctx) => [ctx.getInputData()] });
    const tool = defineNode({
      description: { ...base, name: 'tool', displayName: 'Tool', kind: 'subnode', supplies: 'ai_tool', inputs: [], outputs: [{ type: 'ai_tool' }], properties: [] },
      supplyData: () => ({ name: 'delete_issue', description: 'd', inputSchema: { type: 'object', properties: {} }, invoke: async () => (await checkMcpCall(subject('delete_issue'), {})).decision }),
    });
    const root = defineNode({
      description: { ...base, name: 'root', displayName: 'Root', kind: 'action', outputs: main, inputs: [...main, { type: 'ai_tool' }], properties: [] },
      async execute(ctx) {
        const [t] = await ctx.getInputConnectionData!<{ invoke: (input: object) => Promise<unknown> }>('ai_tool');
        await t.invoke({});
        return [ctx.getInputData()];
      },
    });
    const nodes = { trigger, tool, root };
    const resolver: NodeTypeResolver = { resolve: (type) => (nodes[type.replace(/^t\./, '') as keyof typeof nodes] ? inProcessNodeType('t', nodes[type.replace(/^t\./, '') as keyof typeof nodes]) : { error: 'unknown' }) };
    const n = (id: string, type: string): WorkflowNode => ({ id, name: id, type: `t.${type}`, typeVersion: 1, position: [0, 0], parameters: {} });
    const c = (source: string, target: string, type: WorkflowConnection['type'] = 'main'): WorkflowConnection => ({ id: `${source}-${target}`, type, source, sourceIndex: 0, target, targetIndex: 0 });
    const workflow = { id: 'wf', name: 'T', nodes: [n('t', 'trigger'), n('r', 'root'), n('tool', 'tool')], connections: [c('t', 'r'), c('tool', 'r', 'ai_tool')] };
    const drafts: Array<Record<string, any>> = [];
    const translator = createTranslator({ workflow, executionId: 'ex_span', startedBy: { id: 'u', name: 'U' }, emit: (d) => drafts.push(d as never) });
    const result = await executeWorkflow({ workflow, resolver, executionId: 'ex_span', mode: 'manual', triggerItems: items({}), aroundNode: runInNode, onEvent: (e) => { events.push(e); translator.feed(e); } });
    expect(result.status).toBe('success');
    const check = drafts.find((d) => d.type === 'check' && d.check.name === 'policy')!;
    expect(check.check).toMatchObject({ status: 'warn', source: 'node' });
    const start = drafts.find((d) => d.type === 'span.started' && d.spanId === check.spanId)!;
    expect(JSON.stringify(start)).toContain('tool');
  });
});

// ---------------------------------------------------------------------------
// T-3: the hook in the MCP client, the MCP Client node and agents
// ---------------------------------------------------------------------------

const textOf = (result: { content?: unknown }) => ((result.content ?? []) as Array<{ type: string; text?: string }>).map((p) => p.text ?? '').join('');
const denyDeletes = () => {
  answer = (body) => (String(body.tool).startsWith('delete_') ? { json: { decision: 'deny', reason: 'deletes are not allowed', ruleId: 'no-deletes' } } : { json: { decision: 'allow' } });
};

describe('the MCP client asks the hook', () => {
  it('blocks a denied call before the server sees it, and passes an allowed one (AS-1)', async () => {
    createPolicyHook(hookInput({ name: 'Guard', match: { hosts: ['127.0.0.1'], tools: ['*'] } }));
    denyDeletes();
    const endpoint = endpointFrom({ endpointUrl: `${mcpOrigin}/mcp` }, {});
    const blocked = await callMcpTool(endpoint, 'delete_issue', { repo: 'a/b' });
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked)).toBe('Blocked by policy Guard: deletes are not allowed');
    expect(mcpCalls).toEqual([]);
    expect(textOf(await callMcpTool(endpoint, 'list_issues', {}))).toBe('list_issues done');
    expect(mcpCalls).toEqual([{ tool: 'list_issues' }]);
  });

  it('gives an agent tool the denial to read, and the server nothing', async () => {
    createPolicyHook(hookInput({ name: 'Guard' }));
    denyDeletes();
    const endpoint = endpointFrom({ endpointUrl: `${mcpOrigin}/mcp` }, {});
    const tools = agentToolsFrom(endpoint, await listMcpTools(endpoint));
    const del = tools.find((t) => t.name === 'delete_issue')!;
    await expect(del.invoke({})).rejects.toThrow('Blocked by policy Guard: deletes are not allowed');
    expect(mcpCalls).toEqual([]);
  });

  it('asks again after an approval: the hook runs inside the tool call and a deny still blocks it (AS-6)', async () => {
    createPolicyHook(hookInput({ name: 'Guard' }));
    denyDeletes();
    const config = { name: 'MCP agent', skills: [], memory: { crossSession: false }, tools: [{ id: 't', type: 'mcp', name: 'Issues', parameters: { endpointUrl: `${mcpOrigin}/mcp` }, requireApproval: true }] } as unknown as AgentConfig;
    const { tools } = await buildToolset({ id: 'ag_a', ...config } as unknown as Agent, config);
    const del = tools.find((t) => t.name === 'delete_issue')!;
    expect(del).toMatchObject({ requireApproval: true });
    await expect(del.invoke({}, {} as never)).rejects.toThrow('Blocked by policy Guard: deletes are not allowed');
    expect(mcpCalls).toEqual([]);
  });

  it('asks about resource reads and prompts only when the hook lists their method', async () => {
    const endpoint = endpointFrom({ endpointUrl: `${mcpOrigin}/mcp` }, {});
    createPolicyHook(hookInput({ name: 'Reads', match: { methods: ['tools/call'] } }));
    expect((await readMcpResource(endpoint, 'file:///readme'))[0]).toMatchObject({ text: 'hello' });
    expect((await getMcpPrompt(endpoint, 'greet')).messages).toHaveLength(1);
    expect(seenByPolicy).toHaveLength(0);
    clearHooks();
    createPolicyHook(hookInput({ name: 'Reads', match: { methods: ['resources/read', 'prompts/get'] } }));
    answer = () => ({ json: { decision: 'deny', reason: 'no reads', ruleId: 'r' } });
    await expect(readMcpResource(endpoint, 'file:///readme')).rejects.toThrow('Blocked by policy Reads: no reads');
    await expect(getMcpPrompt(endpoint, 'greet')).rejects.toThrow('Blocked by policy Reads: no reads');
    expect(seenByPolicy.map((s) => [s.body.method, s.body.uri ?? s.body.prompt])).toEqual([['resources/read', 'file:///readme'], ['prompts/get', 'greet']]);
  });

  it('runs before the MCP Client node’s call and fails the item with the reason (AS-5)', async () => {
    createPolicyHook(hookInput({ name: 'Guard' }));
    denyDeletes();
    const failed = await run(mcpClientNode, { endpointUrl: `${mcpOrigin}/mcp`, tool: 'delete_issue' });
    expect(failed.error?.message).toBe('Blocked by policy Guard: deletes are not allowed');
    expect(mcpCalls).toEqual([]);
    const ok = await run(mcpClientNode, { endpointUrl: `${mcpOrigin}/mcp`, tool: 'list_issues' });
    expect(ok.json()[0]).toMatchObject({ text: 'list_issues done' });
  });

  it('leaves calls alone when no hook is configured', async () => {
    const endpoint = endpointFrom({ endpointUrl: `${mcpOrigin}/mcp` }, {});
    expect(toolOutput(await callMcpTool(endpoint, 'delete_issue', {}))).toBe('delete_issue done');
    expect(seenByPolicy).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// T-3: an AI Agent in a flow, a fake model, the MCP Client Tool
// ---------------------------------------------------------------------------

describe('an AI Agent with the MCP Client Tool', () => {
  let fake: FakeServer;
  beforeAll(async () => {
    fake = await startFakeOpenAi({
      chat: (body: { messages: Array<{ role: string; content?: string }>; tools?: Array<{ function: { name: string } }> }): ChatReply | undefined => {
        const last = body.messages[body.messages.length - 1];
        if (last.role === 'tool') return { message: { role: 'assistant', content: `tool said: ${last.content}` }, finish_reason: 'stop' };
        return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'delete_issue', arguments: '{"repo":"a/b"}' } }] }, finish_reason: 'tool_calls' };
      },
    });
  });
  afterAll(() => fake.close());

  it('hands the model the denial, keeps the run going and shows the check on the tool span (AS-1)', async () => {
    createPolicyHook(hookInput({ name: 'Guard' }));
    denyDeletes();
    const workflowNodes: WorkflowNode[] = [
      { id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'Agent', name: 'Agent', type: 'core.aiAgent', typeVersion: 1, position: [0, 0], parameters: { prompt: 'Delete issue 3' } },
      { id: 'Model', name: 'Model', type: 'core.openAiChatModel', typeVersion: 1, position: [0, 0], parameters: { model: 'gpt-test' } },
      { id: 'MCP', name: 'MCP', type: 'core.mcpClientTool', typeVersion: 1, position: [0, 0], parameters: { endpointUrl: `${mcpOrigin}/mcp` } },
    ];
    const conn = (source: string, target: string, type: WorkflowConnection['type'] = 'main'): WorkflowConnection => ({ id: `${source}-${target}`, type, source, sourceIndex: 0, target, targetIndex: 0 });
    const workflow = { id: 'wf_agent', name: 'Agent', nodes: workflowNodes, connections: [conn('Start', 'Agent'), conn('Model', 'Agent', 'ai_languageModel'), conn('MCP', 'Agent', 'ai_tool')] };
    const resolver: NodeTypeResolver = { resolve: (type) => { const node = corePlugin.nodes.find((x) => x.description.name === type.split('.')[1]); return node ? inProcessNodeType('core', node) : { error: 'unknown' }; } };
    const drafts: Array<Record<string, any>> = [];
    const translator = createTranslator({ workflow, executionId: 'ex_agent', startedBy: { id: 'u', name: 'U' }, emit: (d) => drafts.push(d as never) });
    const result = await executeWorkflow({
      workflow, resolver, executionId: 'ex_agent', mode: 'manual', triggerItems: items({}), aroundNode: runInNode,
      resolveCredentials: (node) => (node.name === 'Model' ? { openAiApi: { baseUrl: fake.url } } : undefined),
      onEvent: (e) => translator.feed(e),
    });
    expect(result.status).toBe('success');
    expect(mcpCalls).toEqual([]);
    const last = fake.requests.filter((r) => r.path === '/v1/chat/completions').at(-1)!.body.messages.at(-1);
    expect(last.content).toContain('Blocked by policy Guard: deletes are not allowed');
    const check = drafts.find((d) => d.type === 'check' && d.check.name === 'policy')!;
    expect(check.check).toMatchObject({ status: 'warn', subject: 'delete_issue', evidence: { hook: 'Guard', ruleId: 'no-deletes' } });
  });
});
