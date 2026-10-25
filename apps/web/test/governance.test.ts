/**
 * Governance allow-lists (lib/server/governance/policy.ts): node types by id or plugin (allow or block), "block Code
 * nodes", HTTP Request hosts and MCP server URLs. Enforced at save (warnings), publish (refused), run time (the node
 * fails with a clear error) for manual, trigger-started and agent runs, in the node creator's list and in imports.
 * With every rule off, nothing changes.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { Agent, AgentConfig } from '@/lib/shared/agents';
import type { NodeTypeInfo } from '@/lib/shared/types';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-governance-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off', LANDFLOW_PUBLIC_URL: 'http://gov.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { publishedVersionId } = await import('@/lib/server/publications');
const policy = await import('@/lib/server/governance/policy');
const { endpointFrom } = await import('@/lib/server/mcp/client');
const { buildTools, buildToolset } = await import('@/lib/server/agents/tools');
const { queryEvents } = await import('@/lib/server/audit/store');
const governanceRoute = await import('@/app/api/settings/governance/route');
const nodeTypesRoute = await import('@/app/api/node-types/route');
const workflowsRoute = await import('@/app/api/workflows/route');
const workflowRoute = await import('@/app/api/workflows/[id]/route');
const publishRoute = await import('@/app/api/workflows/[id]/publish/route');
const importRoute = await import('@/app/api/workflows/import/route');
const webhookRoute = await import('@/app/api/webhook/[...path]/route');

registry.registerBuiltin(corePlugin);

let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const OFF = { nodes: { mode: 'off', types: [], plugins: [], blockCode: false }, http: { mode: 'off', hosts: [] }, mcp: { mode: 'off', urls: [] } } as const;
afterEach(() => {
  policy.updateGovernancePolicy(structuredClone(OFF) as never);
});

const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const req = (method: string, url: string, body?: unknown) =>
  new Request(`http://gov.test${url}`, { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
const setPolicy = async (patch: Record<string, unknown>) => {
  const response = await governanceRoute.PATCH(req('PATCH', '/api/settings/governance', patch));
  expect(response.status).toBe(200);
  return response;
};

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, x = 0): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [x, 0], parameters });
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, type: 'main' as const, source, target, sourceIndex: 0, targetIndex: 0 });
const setNode = (id = 'Set') => node(id, 'core.set', { mode: 'manual', includeOtherFields: false, fields: { values: [{ name: 'v', type: 'string', value: 'x' }] } }, 200);
const codeNode = (id = 'Code') => node(id, 'core.code', { jsCode: 'return [{ json: { ran: true } }];' }, 400);

function manualWorkflow(id: string, nodes: WorkflowNode[]): Workflow {
  const all = [node('Start', 'core.manualTrigger'), ...nodes];
  return { id, name: id, nodes: all, connections: all.slice(1).map((n, i) => edge(all[i].name, n.name)) };
}

const nodeError = (record: { runData?: Record<string, Array<{ error?: { message: string; description?: string } }>> }, name: string) => record.runData?.[name]?.[0]?.error;

describe('patterns', () => {
  it('match node types, plugins, hosts (globs, ports, CIDR) and MCP URLs', () => {
    expect(policy.globRegExp('core.*').test('core.httpRequest')).toBe(true);
    expect(policy.globRegExp('core.http*').test('core.set')).toBe(false);
    expect(policy.hostMatches('*.example.com', 'api.example.com')).toBe(true);
    expect(policy.hostMatches('*.example.com', 'example.com')).toBe(false);
    expect(policy.hostMatches('example.com:8443', 'example.com', '8443')).toBe(true);
    expect(policy.hostMatches('example.com:8443', 'example.com', '443')).toBe(false);
    expect(policy.hostMatches('10.0.0.0/8', '10.20.30.40')).toBe(true);
    expect(policy.hostMatches('10.0.0.0/8', '11.0.0.1')).toBe(false);
    const p = { ...structuredClone(OFF), mcp: { mode: 'allow' as const, urls: ['https://mcp.example.com/*', 'tools.internal'] } } as never;
    expect(policy.mcpUrlBlocked('https://mcp.example.com/sse', p)).toBeUndefined();
    expect(policy.mcpUrlBlocked('http://tools.internal:9000/mcp', p)).toBeUndefined();
    expect(policy.mcpUrlBlocked('https://evil.example.org/mcp', p)).toMatch(/not on this instance’s list of allowed MCP servers/);
  });

  it('decides node types: allow-list, block-list by type or plugin, and Code nodes', () => {
    const base = structuredClone(OFF) as never as Parameters<typeof policy.nodeTypeBlocked>[1] & object;
    expect(policy.nodeTypeBlocked('core.code', base)).toBeUndefined();
    expect(policy.nodeTypeBlocked('core.code', { ...base, nodes: { ...base.nodes, blockCode: true } })?.rule).toBe('code');
    const allow = { ...base, nodes: { mode: 'allow' as const, types: ['core.manualTrigger', 'core.set'], plugins: ['messaging'], blockCode: false } };
    expect(policy.nodeTypeBlocked('core.set', allow)).toBeUndefined();
    expect(policy.nodeTypeBlocked('messaging.telegram', allow)).toBeUndefined();
    expect(policy.nodeTypeBlocked('core.httpRequest', allow)?.message).toMatch(/not on this instance’s list of allowed nodes/);
    const block = { ...base, nodes: { mode: 'block' as const, types: ['core.http*'], plugins: ['shell'], blockCode: false } };
    expect(policy.nodeTypeBlocked('core.httpRequest', block)?.rule).toBe('node');
    expect(policy.nodeTypeBlocked('shell.exec', block)?.rule).toBe('plugin');
    expect(policy.nodeTypeBlocked('core.set', block)).toBeUndefined();
  });
});

describe('save, publish and the node creator', () => {
  it('changes nothing with every rule off', async () => {
    const created = await workflowsRoute.POST(req('POST', '/api/workflows', manualWorkflow('wf_off', [codeNode()])));
    const body = (await created.json()) as { workflow: Workflow; policyWarnings?: unknown };
    expect(body.policyWarnings).toBeUndefined();
    expect((await publishRoute.POST(req('POST', `/api/workflows/${body.workflow.id}/publish`), params({ id: body.workflow.id }))).status).toBe(200);
  });

  it('warns at save, refuses to publish, hides blocked nodes from the node creator', async () => {
    await setPolicy({ nodes: { blockCode: true } });
    expect(queryEvents({ action: ['settings.update'] }, { limit: 1 }).events[0]).toMatchObject({ target: { id: 'governance' }, details: { blockCode: true } });
    const created = await workflowsRoute.POST(req('POST', '/api/workflows', manualWorkflow('wf_code', [codeNode()])));
    expect(created.status).toBe(201);
    const body = (await created.json()) as { workflow: Workflow; policyWarnings: Array<{ nodeName: string; rule: string }> };
    expect(body.policyWarnings).toEqual([expect.objectContaining({ nodeName: 'Code', rule: 'code', nodeType: 'core.code' })]);

    const publish = await publishRoute.POST(req('POST', `/api/workflows/${body.workflow.id}/publish`), params({ id: body.workflow.id }));
    expect(publish.status).toBe(422);
    expect(((await publish.json()) as { error: string }).error).toMatch(/can’t be published: “Code”: Code nodes are blocked/);
    expect(publishedVersionId(body.workflow.id)).toBeUndefined();

    // Disabled nodes don't count.
    const put = await workflowRoute.PUT(req('PUT', `/api/workflows/${body.workflow.id}`, { ...body.workflow, nodes: body.workflow.nodes.map((n) => (n.type === 'core.code' ? { ...n, disabled: true } : n)) }), params({ id: body.workflow.id }));
    expect(((await put.json()) as { policyWarnings?: unknown }).policyWarnings).toBeUndefined();
    expect((await publishRoute.POST(req('POST', `/api/workflows/${body.workflow.id}/publish`), params({ id: body.workflow.id }))).status).toBe(200);

    const types = ((await (await nodeTypesRoute.GET(req('GET', '/api/node-types'))).json()) as { nodeTypes: NodeTypeInfo[] }).nodeTypes;
    expect(types.find((t) => t.type === 'core.code')?.blocked).toMatch(/Code nodes are blocked/);
    expect(types.find((t) => t.type === 'core.set')?.blocked).toBeUndefined();
  });

  it('refuses an `active: true` save of a workflow the policy blocks (older clients)', async () => {
    await setPolicy({ nodes: { mode: 'block', types: ['core.code'] } });
    const created = await workflowsRoute.POST(req('POST', '/api/workflows', { ...manualWorkflow('wf_legacy', [codeNode()]), active: true }));
    const body = (await created.json()) as { workflow: Workflow; activationRefused?: string };
    expect(body.workflow.active).toBeFalsy();
    expect(body.activationRefused).toMatch(/can’t be published/);
    expect(publishedVersionId(body.workflow.id)).toBeUndefined();
  });

  it('reports blocked nodes when importing n8n workflows', async () => {
    await setPolicy({ http: { mode: 'block', hosts: ['*.blocked.example'] } });
    const n8n = {
      name: 'From n8n',
      nodes: [
        { id: 'a', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'b', name: 'Fetch', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [200, 0], parameters: { url: 'https://api.blocked.example/v1', method: 'GET' } },
      ],
      connections: { Start: { main: [[{ node: 'Fetch', type: 'main', index: 0 }]] } },
    };
    const response = await importRoute.POST(req('POST', '/api/workflows/import', { data: n8n }));
    expect(response.status).toBe(201);
    const { report, policyWarnings } = (await response.json()) as { report: { blocked?: Array<{ name: string; reason: string }> }; policyWarnings?: unknown[] };
    expect(report.blocked).toEqual([{ name: 'Fetch', type: 'core.httpRequest', reason: expect.stringMatching(/api\.blocked\.example are blocked/) }]);
    expect(policyWarnings).toHaveLength(1);
  });
});

describe('run time', () => {
  it('fails a blocked node with a clear error (manual run), and lets the rest of the instance run', async () => {
    const workflow = store.saveWorkflow(manualWorkflow('wf_run_block', [setNode(), codeNode()]));
    await setPolicy({ nodes: { mode: 'block', types: ['core.code'] } });
    const record = await runWorkflow({ workflow, mode: 'manual' });
    expect(record.status).toBe('error');
    expect(nodeError(record as never, 'Code')).toMatchObject({ message: 'Blocked by policy: core.code is blocked on this instance', description: expect.stringContaining('Settings → Governance') });
    expect(nodeError(record as never, 'Set')).toBeUndefined();

    await setPolicy({ nodes: { mode: 'off' } });
    expect((await runWorkflow({ workflow, mode: 'manual' })).status).toBe('success');
  });

  it('checks the HTTP Request node’s resolved URL on every call', async () => {
    const workflow = store.saveWorkflow(manualWorkflow('wf_http', [node('Set', 'core.set', { mode: 'manual', includeOtherFields: false, fields: { values: [{ name: 'u', type: 'string', value: `${base}/data` }] } }, 200), node('Fetch', 'core.httpRequest', { method: 'GET', url: '={{ $json.u }}' }, 400)]));
    expect((await runWorkflow({ workflow, mode: 'manual' })).status).toBe('success');
    await setPolicy({ http: { mode: 'allow', hosts: ['*.example.com'] } });
    const blocked = await runWorkflow({ workflow, mode: 'manual' });
    expect(nodeError(blocked as never, 'Fetch')?.message).toBe('Blocked by policy: HTTP requests to 127.0.0.1 are not allowed on this instance');
    await setPolicy({ http: { mode: 'allow', hosts: ['127.0.0.0/8'] } });
    expect((await runWorkflow({ workflow, mode: 'manual' })).status).toBe('success');
  });

  it('blocks trigger-started runs of a published workflow when the policy changes later', async () => {
    const workflow = store.saveWorkflow({ id: 'wf_hook', name: 'Hooked', nodes: [node('Hook', 'core.webhook', { path: 'gov-hook', method: 'POST', respond: 'lastNode' }), setNode()], connections: [edge('Hook', 'Set')] });
    expect((await publishRoute.POST(req('POST', `/api/workflows/${workflow.id}/publish`), params({ id: workflow.id }))).status).toBe(200);
    const call = () => webhookRoute.POST(new Request('http://gov.test/api/webhook/gov-hook', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }), params({ path: ['gov-hook'] }));
    expect((await call()).status).toBe(200);
    await setPolicy({ nodes: { mode: 'block', types: ['core.set'] } });
    const refused = await call();
    expect(refused.status).toBeGreaterThanOrEqual(400);
    const [latest] = store.listExecutions({ workflowId: workflow.id, limit: 1 });
    expect(latest.status).toBe('error');
    expect(store.getExecution(latest.id)?.error?.message).toMatch(/Blocked by policy: core\.set is blocked/);
  });

  it('blocks agents: node tools fail and MCP servers outside the allow-list are unavailable', async () => {
    const config = {
      name: 'Gov agent',
      skills: [],
      memory: { crossSession: false },
      tools: [
        { type: 'node', id: 'tool_set', name: 'Greet', description: 'Greets', nodeType: 'core.set', parameters: { mode: 'manual', includeOtherFields: false, fields: { values: [{ name: 'text', type: 'string', value: 'hi' }] } } },
        { type: 'mcp', id: 'tool_mcp', name: 'Remote', parameters: { endpointUrl: 'https://mcp.untrusted.example/mcp' } },
      ],
    } as unknown as AgentConfig;
    const agent = { ...config, id: 'ag_gov', createdAt: '', updatedAt: '', history: [] } as unknown as Agent;
    await setPolicy({ nodes: { mode: 'block', types: ['core.set'] }, mcp: { mode: 'allow', urls: ['https://mcp.trusted.example/*'] } });
    const [tool] = buildTools(agent, config).tools;
    await expect(tool.invoke({}, { agent, runId: 'run_gov', depth: 0, maxDepth: 1 } as never)).rejects.toThrow(/Blocked by policy: core\.set is blocked/);
    const { unavailable } = await buildToolset(agent, config);
    expect(unavailable).toEqual([expect.stringMatching(/^Remote: Blocked by policy: The MCP server https:\/\/mcp\.untrusted\.example\/mcp is not on/)]);
    // The MCP Client node uses the same check.
    expect(() => endpointFrom({ endpointUrl: 'https://mcp.untrusted.example/mcp' } as never, {})).toThrow(/Blocked by policy/);
    expect(endpointFrom({ endpointUrl: 'https://mcp.trusted.example/sse' } as never, {}).url).toBe('https://mcp.trusted.example/sse');
  });
});
