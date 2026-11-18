/**
 * AG25 (wave ag5): a Run an Agent step the build left with no agent bound is designed after Apply (docs/assistant.md "Agents
 * and teams"): on a brand-new draft with the switch on the agent is designed, created, smoke-tested and published by itself
 * and the step bound; asks first or a saved flow leaves the agent card waiting and creates nothing; Undo takes the agent back.
 * The editor's stores are real; the browser's HTTP client is a spy answering made-up bodies, in the order the requests come.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { NodeTypeInfo } from '@/lib/shared/types';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-ag5-editor-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const wire = vi.hoisted(() => ({ calls: [] as Array<{ method: string; path: string; json?: any }>, needs: [] as Array<{ text: string }>, deleted: true }));
vi.mock('@/lib/client/api', async (original) => ({
  ...(await original<typeof import('@/lib/client/api')>()),
  streamEvents: vi.fn(),
  api: vi.fn(async (path: string, init: { method?: string; json?: any } = {}) => {
    const method = init.method ?? 'GET';
    wire.calls.push({ method, path, json: init.json });
    if (path === '/api/agents/design' && method === 'POST')
      return { agent: { id: 'ag_x', name: 'x', tools: [] }, config: { name: 'Sales summary writer', description: 'Writes the monthly sales summary by region.', model: { provider: 'anthropic', model: 'claude-sonnet-5-5' }, tools: [] }, needs: wire.needs, missing: [], designed: true, cases: [] };
    if (path === '/api/agents/design' && method === 'DELETE') return { deleted: wire.deleted };
    if (path === '/api/agents/import') return { agent: { id: 'ag_new', name: 'Sales summary writer', tools: [] } };
    if (path === '/api/expressions/preview') return { ok: true, value: "Write last month's sales summary by region" };
    if (path.endsWith('/smoke-test')) return { smoke: { state: 'passed', reason: 'it answered' } };
    if (path.endsWith('/eval-gate') && method === 'GET') return { cases: [] };
    if (path.endsWith('/publish')) return { published: true };
    return {};
  }),
}));
vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { useEditor } = await import('@/components/editor/store');
const { useAssistant } = await import('@/components/editor/assistant');
const { useAutonomous } = await import('@/components/editor/autonomous');
const { agentsSettled, takeBackAgents } = await import('@/components/editor/new-agent');
const { designUnboundAgents } = await import('@/components/editor/spotlight/step-agents');
const { noteOpened, useAutonomyFacts } = await import('@/components/editor/spotlight-autonomy');

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

const node = (id: string, name: string, type: string, parameters: Record<string, unknown> = {}) => ({ id, name, type, typeVersion: 1, position: [0, 0] as [number, number], parameters });
const WF = 'wf_sales';
const ASK = "Every weekday at 8:00, have an agent write last month's sales summary by region, then post it.";
const flow: Workflow = {
  id: WF,
  name: 'Sales summary',
  nodes: [node('t', 'Weekdays at 8', 'core.schedule'), node('s', 'Write summary', 'core.messageAgent', { agentId: '', message: "Write last month's sales summary by region" }), node('p', 'Post it', 'core.httpRequest')],
  connections: [
    { id: 'e1', type: 'main', source: 't', sourceIndex: 0, target: 's', targetIndex: 0 },
    { id: 'e2', type: 'main', source: 's', sourceIndex: 0, target: 'p', targetIndex: 0 },
  ],
};
const paths = () => wire.calls.map((c) => `${c.method} ${c.path}`);
const step = () => useEditor.getState().nodes.find((n) => n.id === 's')!;
const cardOf = () => useAssistant.getState().items.flatMap((i) => (i.role === 'assistant' ? i.parts : [])).find((p) => p.kind === 'agentCard');

beforeEach(() => {
  wire.calls.length = 0;
  wire.needs = [];
  wire.deleted = true;
  useAssistant.getState().reset();
  useAutonomous.setState({ on: true });
  useAutonomyFacts.setState({ switchOn: true, workflows: {} });
  useEditor.getState().load(flow, types);
  useAutonomyFacts.setState({ switchOn: true, workflows: {} }); // the editor noted the load as a saved flow: each test says how the workflow was opened
});

describe('an unbound Run an Agent step is designed after Apply', () => {
  it('on a brand-new draft with the switch on: design, create, smoke test and publish, in that order, and the step is bound', async () => {
    noteOpened(WF, 0);
    await designUnboundAgents(['s'], ASK);
    await agentsSettled();
    expect(paths().filter((p) => !p.includes('expressions') && !p.includes('eval-gate'))).toEqual([
      'POST /api/agents/design', // the design (preview), nothing saved
      'POST /api/agents/import', // create
      'POST /api/agents/ag_new/smoke-test',
      'POST /api/agents/ag_new/publish',
    ]);
    expect(wire.calls[0]!.json).toMatchObject({ name: 'Write summary', preview: true, ask: ASK });
    expect(step().data.wf.parameters.agentId).toBe('ag_new');
    const row = useAssistant.getState().agents.find((a) => a.nodeId === 's')!;
    expect(row).toMatchObject({ state: 'published', agentId: 'ag_new', name: 'Sales summary writer' });
    expect(row.summary).toContain('for “Write summary”');
  });

  it('sends what the replaced AI Agent had (instructions, tools, model) to the architect', async () => {
    noteOpened(WF, 0);
    const hints = { 'Write summary': { instructions: 'You write sales summaries.', tools: ['SQLite'], toolNodes: [{ nodeType: 'core.sqliteTool', operation: 'query' }], model: 'anthropic/claude-haiku-5' } };
    await designUnboundAgents(['s'], ASK, hints);
    expect(wire.calls[0]!.json).toMatchObject({ name: 'Write summary', preview: true, instructions: 'You write sales summaries.', tools: ['SQLite'], agentModel: 'anthropic/claude-haiku-5', toolNodes: [{ nodeType: 'core.sqliteTool', operation: 'query' }] });
  });

  it('cuts a long step message and long instructions to what the design route accepts, and the card is still made', async () => {
    noteOpened(WF, 0);
    const long = { ...flow, nodes: flow.nodes.map((n) => (n.id === 's' ? { ...n, parameters: { agentId: '', message: 'Summarise sales by region. '.repeat(60) } } : n)) };
    useEditor.getState().load(long, types);
    useAutonomyFacts.setState({ switchOn: true, workflows: {} });
    noteOpened(WF, 0);
    await designUnboundAgents(['s'], ASK, { 'Write summary': { instructions: 'x'.repeat(6000), tools: [] } });
    await agentsSettled();
    const sent = wire.calls[0]!.json;
    expect(sent.description.length).toBeLessThanOrEqual(500);
    expect(sent.instructions.length).toBeLessThanOrEqual(4000);
    expect(useAssistant.getState().agents.find((a) => a.nodeId === 's')?.state).not.toBe('failed');
  });

  it('on a saved flow the card waits: nothing is created, the step stays unbound', async () => {
    noteOpened(WF, 3);
    await designUnboundAgents(['s'], ASK);
    expect(paths()).toEqual(['POST /api/agents/design']);
    expect(step().data.wf.parameters.agentId).toBe('');
    const card = cardOf();
    expect(card?.kind === 'agentCard' && card.card.state).toBe('designed');
  });

  it('with the switch off the card waits too, and Create binds the step and tests it (never published by itself)', async () => {
    noteOpened(WF, 0);
    useAutonomous.setState({ on: false });
    useAutonomyFacts.setState({ switchOn: false });
    await designUnboundAgents(['s'], ASK);
    expect(paths()).toEqual(['POST /api/agents/design']);
    const item = useAssistant.getState().items.find((i) => i.role === 'assistant' && i.parts.some((p) => p.kind === 'agentCard'))!;
    const { createFromCard } = await import('@/components/editor/spotlight/agent-ask');
    const card = (item.parts.find((p) => p.kind === 'agentCard') as { card: Parameters<typeof createFromCard>[1] }).card;
    await createFromCard(item.id, card);
    expect(step().data.wf.parameters.agentId).toBe('ag_new');
    expect(paths()).toContain('POST /api/agents/ag_new/smoke-test');
    expect(paths()).not.toContain('POST /api/agents/ag_new/publish');
  });

  it('a design that needs something from the person leaves the card waiting even on a brand-new draft', async () => {
    noteOpened(WF, 0);
    wire.needs = [{ text: 'Pick the sales database credential' }];
    await designUnboundAgents(['s'], ASK);
    expect(paths()).toEqual(['POST /api/agents/design']);
    expect(step().data.wf.parameters.agentId).toBe('');
  });

  it('Undo of the build takes the agent that was made back', async () => {
    noteOpened(WF, 0);
    await designUnboundAgents(['s'], ASK);
    await agentsSettled();
    await takeBackAgents(['s'], WF);
    expect(wire.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/agents/design', json: { agentId: 'ag_new', workflowId: WF } });
    expect(useAssistant.getState().agents.find((a) => a.nodeId === 's')?.taken).toEqual({ deleted: true });
  });

  it('a step that already has an agent is left alone', async () => {
    useEditor.getState().updateNode('s', { parameters: { agentId: 'ag_have', message: 'x' } });
    await designUnboundAgents(['s'], ASK);
    expect(wire.calls).toEqual([]);
  });
});
