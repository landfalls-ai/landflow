/**
 * AG20: what Spotlight reads of a run (`runLog`, and `get_run_log` on the instance MCP server): each node's status,
 * its error with the HTTP status and the body's first 400 characters, clipped items, the plugin's lines, and an agent's
 * tool calls in order. Never a secret; another user's run is "not found".
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import { startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-run-log-ag4-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_OUTBOUND_ALLOW: '127.0.0.1,localhost', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { agentStore } = await import('@/lib/server/agents/store');
const { createUser } = await import('@/lib/server/auth/users');
const { ensurePersonalProject, setHomeProject } = await import('@/lib/server/projects/store');
const { runLog } = await import('@/lib/server/assistant/run-log');
const { instanceServer } = await import('@/lib/server/mcp/instance-tools');

registry.registerBuiltin(corePlugin);
const fake = await startFakeModels({
  reply: (_provider, body) => {
    const last = body.messages?.at(-1);
    if (last?.role === 'tool' || (Array.isArray(last?.content) && last.content.some((p: { type?: string }) => p.type === 'tool_result'))) return { text: 'The calculator failed, so I could not do the sum.' };
    const tool = body.tools?.[0];
    const name = tool?.function?.name ?? tool?.name;
    return name ? { toolCalls: [{ id: 'call_1', name, arguments: { expression: '6 *' } }] } : { text: 'ok' };
  },
});

const TOKEN = 'tok-ag20-secret-9f8e7d6c';
let receiver: Server;
const received: string[] = [];
receiver = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    received.push(raw);
    const fields = Object.keys(JSON.parse(raw || '{}'));
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `Bad Request: the JSON body needs a non-empty string field "report_text" (got fields: ${fields.join(', ')})` }));
  });
});
await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
const port = (receiver.address() as AddressInfo).port;

afterAll(async () => {
  await fake.close();
  receiver.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const alice = await createUser({ email: 'alice@run-log-ag4.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
const bob = await createUser({ email: 'bob@run-log-ag4.test', name: 'Bob', role: 'member', password: 'bob-password-1' });
const actorOf = (user: { id: string; role: 'owner' | 'admin' | 'member' }) => ({ id: user.id, role: user.role });

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
const edge = (source: string, target: string, type: 'main' | 'ai_tool' = 'main') => ({ id: `${source}-${target}`, type, source, target, sourceIndex: 0, targetIndex: 0 });

function mine(wf: Workflow) {
  store.saveWorkflow(wf);
  setHomeProject('workflow', wf.id, ensurePersonalProject(alice.id)!);
  return wf;
}

const reportFlow = (): Workflow =>
  mine({
    id: 'wf_report_ag20',
    name: 'Post the report',
    nodes: [
      node('Start', 'core.manualTrigger'),
      node('Shape', 'core.set', { mode: 'manual', fields: { values: [{ name: 'report', type: 'string', value: 'North 4,150' }, { name: 'token', type: 'string', value: TOKEN }] } }),
      node('Post report', 'core.httpRequest', { method: 'POST', url: `http://127.0.0.1:${port}/reports/sales`, bodyType: 'json', body: { report: '{{ $json.report }}' }, headers: { header: [{ name: 'x-api-key', value: TOKEN }] } }),
    ],
    connections: [edge('Start', 'Shape'), edge('Shape', 'Post report')],
  });

describe('runLog', () => {
  it('reads the failing HTTP node: its status, the body naming the field, the items on both sides, and no secret', async () => {
    const wf = reportFlow();
    const record = await runWorkflow({ workflow: wf, mode: 'manual', startNodeId: 'Start' });
    expect(record.status).toBe('error');
    const log = await runLog(actorOf(alice), { workflowId: wf.id, executionId: record.executionId });
    expect(log).toMatchObject({ executionId: record.executionId, status: 'error', failed: 'Post report' });
    const post = log!.nodes.find((n) => n.name === 'Post report')!;
    expect(post.status).toBe('error');
    expect(post.error?.httpCode).toBe(400);
    expect(post.error?.message).toBe('HTTP 400');
    expect(post.error?.description).toContain('report_text');
    expect(post.error?.description).toContain('got fields: report');
    expect(post.input?.[0]).toMatchObject({ report: 'North 4,150' });
    expect(log!.nodes.find((n) => n.name === 'Shape')?.output?.[0]).toMatchObject({ report: 'North 4,150' });
    expect(JSON.stringify(log)).not.toContain(TOKEN);
    expect(JSON.stringify(log)).not.toContain('x-api-key');
  });

  it('reads the latest execution of the workflow when no id is given', async () => {
    const wf = reportFlow();
    await runWorkflow({ workflow: wf, mode: 'manual', startNodeId: 'Start' });
    const second = await runWorkflow({ workflow: wf, mode: 'manual', startNodeId: 'Start' });
    const log = await runLog(actorOf(alice), { workflowId: wf.id });
    expect(log?.executionId).toBe(second.executionId);
  });

  it('answers "not found" for a run the user cannot read', async () => {
    const wf = reportFlow();
    const record = await runWorkflow({ workflow: wf, mode: 'manual', startNodeId: 'Start' });
    expect(await runLog(actorOf(bob), { workflowId: wf.id, executionId: record.executionId })).toBeUndefined();
    expect(await runLog(actorOf(bob), { workflowId: wf.id })).toBeUndefined();
    expect(await runLog(actorOf(alice), { workflowId: 'wf_other', executionId: record.executionId })).toBeUndefined();
  });

  it('lists a Run an Agent step\'s tool calls in order, the failing one with its error and input, and the reply', async () => {
    const agent = agentStore.create({ name: 'Calc desk', instructions: 'Use the calculator.', model: { provider: 'ollama', model: 'agent-own-model', baseUrl: fake.url.replace(/\/v1$/, '') } });
    agentStore.publish(agent.id);
    const wf = mine({
      id: 'wf_agent_log_ag20',
      name: 'Agent log',
      nodes: [node('Start', 'core.manualTrigger'), node('Agent', 'core.messageAgent', { agentId: agent.id, message: 'What is 6*?', conversation: 'new' }), node('Calculator', 'core.calculatorTool')],
      connections: [edge('Start', 'Agent'), edge('Calculator', 'Agent', 'ai_tool')],
    });
    const record = await runWorkflow({ workflow: wf, mode: 'manual', startNodeId: 'Start' });
    const log = await runLog(actorOf(alice), { workflowId: wf.id, executionId: record.executionId });
    const step = log!.nodes.find((n) => n.name === 'Agent')!;
    expect(step.agent).toMatchObject({ id: agent.id, name: 'Calc desk' });
    expect(step.agent?.reply?.length).toBeLessThanOrEqual(401);
    expect(step.agent?.reply).toContain('calculator failed');
    expect(step.agentCalls?.[0]).toMatchObject({ tool: 'Calculator', status: 'error', input: { expression: '6 *' } });
    expect(step.agentCalls?.[0].error).toBeTruthy();
  });
});

describe('get_run_log over MCP', () => {
  const connect = async (user: typeof alice, keyScopes?: Array<'executions:read' | 'workflows:read'>) => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await instanceServer(actorOf(user), undefined, keyScopes).connect(serverSide);
    const client = new Client({ name: 'run-log-test', version: '1.0.0' });
    await client.connect(clientSide);
    return client;
  };
  const textOf = (result: unknown) => ((result as { content: Array<{ text: string }> }).content[0]?.text ?? '');

  it('answers the same JSON as runLog for the same actor', async () => {
    const wf = reportFlow();
    const record = await runWorkflow({ workflow: wf, mode: 'manual', startNodeId: 'Start' });
    const client = await connect(alice, ['executions:read']);
    const answer = await client.callTool({ name: 'get_run_log', arguments: { workflowId: wf.id, executionId: record.executionId } });
    expect(JSON.parse(textOf(answer))).toEqual(JSON.parse(JSON.stringify(await runLog(actorOf(alice), { workflowId: wf.id, executionId: record.executionId }))));
    const other = await (await connect(bob, ['executions:read'])).callTool({ name: 'get_run_log', arguments: { workflowId: wf.id, executionId: record.executionId } });
    expect(textOf(other)).toMatch(/not found/i);
  });

  it('is refused for a key without executions:read', async () => {
    const wf = reportFlow();
    const client = await connect(alice, ['workflows:read']);
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('get_run_log');
    await expect(client.callTool({ name: 'get_run_log', arguments: { workflowId: wf.id } })).rejects.toThrow(/disabled/);
    expect((await (await connect(alice, ['executions:read'])).listTools()).tools.map((t) => t.name)).toContain('get_run_log');
  });
});
