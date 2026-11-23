/**
 * C34 review: a workflow saved through the API or the MCP tools with nodes but no connections keeps each Decide
 * connection on the output of the same name, and the response says which connections went.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Workflow } from '@landflow/engine';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-decide-save-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { ensureBootstrapped } = await import('@/lib/server/bootstrap');
const { store } = await import('@/lib/server/store');
const { remapOutputConnections } = await import('@/lib/server/mcp/workflows');
const workflowRoute = await import('@/app/api/workflows/[id]/route');

const decide = (options: string) => ({
  source: 'ollama', model: 'nimble:9b', state: '{{ $json }}',
  questions: { question: [{ name: 'topic', type: 'choice', instructions: 'q', options }] }, routeBy: 'topic',
});
const node = (id: string, name: string, type: string, parameters: Record<string, unknown> = {}) => ({ id, name, type, typeVersion: 1, position: [0, 0] as [number, number], parameters });
const workflow = (): Workflow => ({
  id: 'wf_decide_save',
  name: 'Decide save',
  nodes: [node('a', 'Start', 'core.manualTrigger'), node('d', 'Route', 'core.decide', decide('billing\ntechnical\nother')), node('s1', 'Billing', 'core.set'), node('s2', 'Technical', 'core.set'), node('s4', 'Unsure', 'core.set')],
  connections: [
    { id: 'e0', type: 'main', source: 'a', sourceIndex: 0, target: 'd', targetIndex: 0 },
    { id: 'e1', type: 'main', source: 'd', sourceIndex: 0, target: 's1', targetIndex: 0 },
    { id: 'e2', type: 'main', source: 'd', sourceIndex: 1, target: 's2', targetIndex: 0 },
    { id: 'e3', type: 'main', source: 'd', sourceIndex: 3, target: 's4', targetIndex: 0 },
  ],
});
const edges = (w: Pick<Workflow, 'connections'>) => w.connections.filter((c) => c.source === 'd').map((c) => `${c.sourceIndex}>${c.target}`).sort();

beforeAll(async () => {
  await ensureBootstrapped();
  store.saveWorkflow(workflow());
});

describe('remapOutputConnections', () => {
  it('moves the connections of a Decide whose options changed and names what it dropped', () => {
    const before = workflow();
    const nodes = before.nodes.map((n) => (n.id === 'd' ? { ...n, parameters: decide('technical\nother') } : n));
    const result = remapOutputConnections(before, nodes);
    expect(edges(result)).toEqual(['0>s2', '2>s4']);
    expect(result.dropped.join(' ')).toMatch(/“Route”.*“Billing”/);
    expect(result.connections.find((c) => c.id === 'e0')).toBeTruthy();
  });

  it('leaves everything alone when the Decide did not change', () => {
    const before = workflow();
    expect(remapOutputConnections(before, before.nodes)).toEqual({ connections: before.connections, dropped: [] });
  });
});

describe('PUT /api/workflows/:id', () => {
  const put = (body: unknown) => workflowRoute.PUT(new Request('http://t/api/workflows/wf_decide_save', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'wf_decide_save' }) });

  it('keeps each connection on its option when nodes are sent without connections, and reports the dropped ones', async () => {
    const before = workflow();
    const nodes = before.nodes.map((n) => (n.id === 'd' ? { ...n, parameters: decide('sales\nbilling\ntechnical\nother') } : n));
    const response = await put({ name: before.name, nodes });
    expect(response.status).toBe(200);
    const saved = store.getWorkflow('wf_decide_save')!;
    expect(edges(saved)).toEqual(['1>s1', '2>s2', '4>s4'].sort());
  });

  it('reports a connection that went when its option was removed', async () => {
    store.saveWorkflow(workflow());
    const nodes = workflow().nodes.map((n) => (n.id === 'd' ? { ...n, parameters: decide('technical\nother') } : n));
    const body = (await (await put({ name: 'Decide save', nodes })).json()) as { droppedConnections?: string[] };
    expect(body.droppedConnections?.join(' ')).toMatch(/“Billing”/);
    expect(edges(store.getWorkflow('wf_decide_save')!)).toEqual(['0>s2', '2>s4']);
  });

  it('does not touch connections the client sent', async () => {
    store.saveWorkflow(workflow());
    const w = workflow();
    const nodes = w.nodes.map((n) => (n.id === 'd' ? { ...n, parameters: decide('technical\nother') } : n));
    await put({ name: 'Decide save', nodes, connections: w.connections });
    expect(edges(store.getWorkflow('wf_decide_save')!)).toEqual(['0>s1', '1>s2', '3>s4']);
  });
});

describe('the update_workflow MCP tool', () => {
  it('does the same, and get_node_type explains what the outputs follow', async () => {
    store.saveWorkflow(workflow());
    const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');
    const { instanceServer } = await import('@/lib/server/mcp/instance-tools');
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await instanceServer().connect(serverSide);
    const client = new Client({ name: 'decide-save', version: '1.0.0' });
    await client.connect(clientSide);
    try {
      const nodes = workflow().nodes.map((n) => (n.id === 'd' ? { ...n, parameters: decide('technical\nother') } : n));
      const updated = (await client.callTool({ name: 'update_workflow', arguments: { id: 'wf_decide_save', nodes } })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(updated.isError).toBeFalsy();
      expect(JSON.parse(updated.content[0].text).droppedConnections.join(' ')).toMatch(/“Billing”/);
      expect(edges(store.getWorkflow('wf_decide_save')!)).toEqual(['0>s2', '2>s4']);
      const type = (await client.callTool({ name: 'get_node_type', arguments: { type: 'core.decide' } })) as { content: Array<{ text: string }> };
      expect(JSON.parse(type.content[0].text).outputsFollow).toMatch(/one per option of the Choice question named in Route By/);
    } finally {
      await client.close();
    }
  });
});
