/**
 * AG12 (wave ag3): what the canvas's band reads. `GET /api/agents/:id/connections` answers the same list the Run Trace shows
 * (`agentConnections`), from the published version, with the tool ids, "asks first", credential NAMES, the project's default
 * model and withheld tools, a knowledge base's document count, and a Run an Agent node's wired Chat Model and Memory marked as
 * replacing the agent's own. Made-up data; no model, no network.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Workflow } from '@landflow/engine';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-connections-ag3-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { corePlugin } = await import('@/lib/server/nodes');
const { registry } = await import('@/lib/server/plugins/registry');
registry.registerBuiltin(corePlugin);
const { agentStore } = await import('@/lib/server/agents/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { store } = await import('@/lib/server/store');
const { agentConnections, nodeConnections } = await import('@/lib/server/agents/connections');
const { insertDocuments, SqliteVectorStore } = await import('@/lib/server/rag/stores');
const { updateProjectSettings } = await import('@/lib/server/governance/scopes');
const { defaultProjectId } = await import('@/lib/server/projects/store');
const { brandIcon } = await import('@/lib/shared/brand-icons');
const route = await import('@/app/api/agents/[id]/connections/route');
const auth = await import('@/lib/server/auth');

// The instance's owner, so workflows have a home project (the default one).
const owner = await auth.createOwner({ email: 'o@ag12.test', name: 'Owner', password: 'password-123' });
const SMTP_SECRET = 'smtp-pass-ZX81-never-shown';
const ask = async (id: string, query = '') => {
  const response = await route.GET(new Request(`http://localhost:3000/api/agents/${id}/connections${query}`), { params: Promise.resolve({ id }) });
  return { status: response.status, text: await response.text() };
};
const answer = async (id: string, query = '') => {
  const r = await ask(id, query);
  return { status: r.status, ...(JSON.parse(r.text) as { agent: Record<string, any>; connections: Array<Record<string, any>> }) };
};

const smtp = credentials.create({ name: 'Mailpit SMTP', type: 'core.openAiApi', data: { apiKey: SMTP_SECRET, baseUrl: 'http://localhost:51181' } });
const sales = credentials.create({ name: 'Sales DB', type: 'core.openAiApi', data: { apiKey: 'sales-key-never-shown', baseUrl: 'http://localhost:1' } });

const mail = { id: 'tool_mail', type: 'node', name: 'Send Email', description: 'Mail it', nodeType: 'messaging.emailSend', parameters: {}, requireApproval: true, credentials: { smtp: { id: smtp.id, name: 'Mailpit SMTP' } } } as const;
const sql = { id: 'tool_sql', type: 'node', name: 'SQLite', description: 'Query', nodeType: 'databases.sqlite', parameters: { resource: 'query', operation: 'execute' }, credentials: { sqlite: { id: sales.id, name: 'Sales DB' } } } as const;
const kb = { id: 'tool_kb', type: 'knowledge', name: 'runbooks', description: 'Search', store: 'sqlite', collection: 'ag12_runbooks', embeddings: { provider: 'ollama', model: 'nomic-embed-text' } } as const;

const base = { name: 'Alert triager', description: 'Triage', instructions: 'Work.', model: { provider: 'anthropic', model: 'claude-sonnet-5-5' }, memory: { crossSession: true } };
function agent(extra: Record<string, unknown> = {}) {
  return agentStore.create({ ...base, tools: [mail, sql, kb], ...extra } as never);
}

describe('the route', () => {
  it('answers the model, memory, tools with ids, asks-first, credential names and the knowledge base with its documents, and no secret', async () => {
    const a = agent();
    const vectors = new SqliteVectorStore();
    await insertDocuments(vectors, 'ag12_runbooks', [
      { pageContent: 'one', metadata: { documentId: 'd1', fileName: 'RB-101.md' }, embedding: [1, 0, 0] },
      { pageContent: 'two', metadata: { documentId: 'd2', fileName: 'RB-102.md' }, embedding: [0, 1, 0] },
    ]);
    agentStore.publish(a.id);
    const r = await answer(a.id);
    expect(r.status).toBe(200);
    expect(r.agent).toMatchObject({ id: a.id, name: 'Alert triager', published: true, draftDiffers: false });
    const by = (name: string) => r.connections.find((c) => c.name === name)!;
    expect(by('claude-sonnet-5-5')).toMatchObject({ kind: 'model', detail: 'Anthropic', icon: brandIcon('anthropic'), from: 'agent' });
    expect(r.connections.some((c) => c.kind === 'memory' && c.name === 'Remembers across sessions')).toBe(true);
    expect(by('Send Email')).toMatchObject({ toolId: 'tool_mail', asksFirst: true, credential: 'Mailpit SMTP' });
    expect(by('SQLite')).toMatchObject({ toolId: 'tool_sql', credential: 'Sales DB' });
    expect(by('SQLite').asksFirst).toBeUndefined();
    expect(by('ag12_runbooks')).toMatchObject({ kind: 'knowledge', documents: 2, toolId: 'tool_kb' });
    expect(r.connections.filter((c) => c.overriddenBy || c.withheld)).toEqual([]);
    const text = JSON.stringify(r);
    expect(text).not.toContain(SMTP_SECRET);
    expect(text).not.toContain('sales-key-never-shown');
  });

  it('a deleted credential reads "credential missing"', async () => {
    const gone = credentials.create({ name: 'Short lived', type: 'core.openAiApi', data: { apiKey: 'x-never', baseUrl: 'http://localhost:2' } });
    const a = agent({ tools: [{ ...mail, credentials: { smtp: { id: gone.id, name: 'Short lived' } } }] });
    credentials.delete(gone.id);
    expect((await answer(a.id)).connections.find((c) => c.name === 'Send Email')).toMatchObject({ credential: 'credential missing' });
  });

  it('a draft-only agent is not published and shows its draft; a published one that changed shows the published tools and a draft that differs', async () => {
    const draft = agent();
    expect((await answer(draft.id)).agent).toMatchObject({ published: false, draftDiffers: false });
    expect((await answer(draft.id)).connections.map((c) => c.name)).toContain('Send Email');

    const a = agent();
    agentStore.publish(a.id);
    agentStore.saveDraft(a.id, { tools: [sql] } as never);
    const r = await answer(a.id);
    expect(r.agent).toMatchObject({ published: true, draftDiffers: true });
    expect(r.connections.map((c) => c.name)).toContain('Send Email');
  });

  it('the same settings saved in another key order do not differ', async () => {
    const a = agent();
    agentStore.publish(a.id);
    const current = agentStore.get(a.id)!;
    agentStore.saveDraft(a.id, { memory: current.memory, model: current.model, tools: current.tools, name: current.name } as never);
    expect((await answer(a.id)).agent.draftDiffers).toBe(false);
  });

  it('a wired Chat Model and Memory mark the agent’s own as overridden; a wired tool is listed apart', async () => {
    const a = agent();
    agentStore.publish(a.id);
    const workflow = {
      id: 'wf_ag12_wired',
      name: 'Wired',
      nodes: [
        { id: 'n1', type: 'core.messageAgent', name: 'Run Alert triager', position: [0, 0], parameters: { agentId: a.id } },
        { id: 'n2', type: 'core.ollamaChatModel', name: 'Local llama', position: [0, 0], parameters: { model: 'llama3.2' } },
        { id: 'n3', type: 'core.windowBufferMemory', name: 'Short memory', position: [0, 0], parameters: {} },
        { id: 'n4', type: 'core.calculatorTool', name: 'Calculator', position: [0, 0], parameters: {} },
      ],
      connections: [
        { id: 'c1', type: 'ai_languageModel', source: 'n2', sourceIndex: 0, target: 'n1', targetIndex: 0 },
        { id: 'c2', type: 'ai_memory', source: 'n3', sourceIndex: 0, target: 'n1', targetIndex: 0 },
        { id: 'c3', type: 'ai_tool', source: 'n4', sourceIndex: 0, target: 'n1', targetIndex: 0 },
      ],
    } as unknown as Workflow;
    store.saveWorkflow(workflow);
    const r = await answer(a.id, '?workflowId=wf_ag12_wired&nodeId=n1');
    expect(r.connections.find((c) => c.kind === 'model')).toMatchObject({ name: 'claude-sonnet-5-5', overriddenBy: 'Local llama' });
    expect(r.connections.find((c) => c.kind === 'memory')).toMatchObject({ overriddenBy: 'Short memory' });
    expect(r.connections.find((c) => c.name === 'Calculator')).toMatchObject({ kind: 'tool', from: 'flow', nodeType: 'core.calculatorTool' });
    // The agent's own tools do not include the wired one.
    expect(agentStore.get(a.id)!.tools.map((t) => 'name' in t && t.name)).not.toContain('Calculator');
    // Without a node, nothing is overridden.
    expect((await answer(a.id, '?workflowId=wf_ag12_wired')).connections.some((c) => c.overriddenBy)).toBe(false);
  });

  it('a project’s default model, withheld tool kinds and knowledge base show for an agent in its workflows', async () => {
    const a = agent({ model: undefined });
    store.saveWorkflow({ id: 'wf_ag12_project', name: 'P', nodes: [{ id: 'n1', type: 'core.messageAgent', name: 'Run', position: [0, 0], parameters: { agentId: a.id } }], connections: [] } as unknown as Workflow);
    const project = defaultProjectId()!;
    updateProjectSettings(project, {
      defaultModel: { provider: 'ollama', model: 'llama3.2' },
      agentTools: { mode: 'allow', kinds: ['knowledge'] },
      knowledge: { enabled: true, tool: { ...kb, id: 'pk', name: 'project_knowledge', collection: 'ag12_project_kb' } as never },
    });
    const r = await answer(a.id, '?workflowId=wf_ag12_project&nodeId=n1');
    expect(r.connections.find((c) => c.kind === 'model')).toMatchObject({ name: 'llama3.2', from: 'project' });
    expect(r.connections.find((c) => c.name === 'Send Email')!.withheld).toMatch(/does not allow nodes/);
    expect(r.connections.find((c) => c.name === 'ag12_runbooks')!.withheld).toBeUndefined();
    expect(r.connections.find((c) => c.name === 'Project knowledge')).toMatchObject({ kind: 'knowledge', from: 'project' });
    // The same without the workflow: the agent as it is.
    const plain = await answer(a.id);
    expect(plain.connections.some((c) => c.kind === 'model' || c.withheld || c.name === 'Project knowledge')).toBe(false);
    updateProjectSettings(project, { defaultModel: null, knowledge: null, agentTools: { mode: 'off', kinds: [] } });
  });

  it('a workflow or agent that does not exist is 404', async () => {
    const a = agent();
    expect((await ask(a.id, '?workflowId=nope&nodeId=n1')).status).toBe(404);
    expect((await ask('agent_missing')).status).toBe(404);
  });
});

describe('the Run Trace’s path', () => {
  it('nodeConnections keeps what it gave: model and memory dropped when the flow wires them, no marks, the same list as the route’s function', () => {
    const a = agent();
    agentStore.publish(a.id);
    const node = { id: 'n1', type: 'core.messageAgent', name: 'Run', position: [0, 0], parameters: { agentId: a.id } } as never;
    const plain = nodeConnections(node, { model: false, memory: false })!;
    expect(plain.map((c) => c.name).sort()).toEqual(['Remembers across sessions', 'SQLite', 'Send Email', 'ag12_runbooks', 'claude-sonnet-5-5']);
    const wired = nodeConnections(node, { model: true, memory: true })!;
    expect(wired.some((c) => c.kind === 'model' || c.kind === 'memory')).toBe(false);
    expect(plain.some((c) => c.overriddenBy || c.withheld)).toBe(false);
    expect(agentConnections(agentStore.get(a.id)!).map((c) => c.name)).toEqual(plain.map((c) => c.name));
  });
});

describe('who may read', () => {
  it('a member without access to the agent gets 404', async () => {
    const member = await auth.createUser({ email: 'm@ag12.test', name: 'Member', role: 'member', password: 'password-123' });
    const a = agent();
    auth.disableTestAuth();
    try {
      const ownerSession = auth.createSession(owner, 'password').token;
      const memberSession = auth.createSession(member, 'password').token;
      const get = (cookie: string) => route.GET(new Request(`http://localhost:3000/api/agents/${a.id}/connections`, { headers: { cookie: `landflow_session=${cookie}` } }), { params: Promise.resolve({ id: a.id }) });
      expect((await get(ownerSession)).status).toBe(200);
      expect((await get(memberSession)).status).toBe(404);
    } finally {
      auth.enableTestAuth();
    }
  });
});
