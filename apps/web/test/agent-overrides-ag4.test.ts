/**
 * AG17 (wave ag4): a Run an Agent node follows its agent. Old per-flow wiring (a chat model, memory, tools) moves into the agent's
 * DRAFT on open (the route) and at the host's start (the pass), is recorded and said, and keeps running until the agent is
 * republished. The route handlers are called directly as the synthetic owner; the agents' model is scripted; the Text Toolkit plugin
 * and the core nodes run in process; credentials are made up.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, LanguageModel, Workflow } from '@landflow/engine';
import { KEEP_WHY, MOVE_NOTE, moveNoticeLines, type AgentMoveResult } from '@/lib/shared/agent-bubbles';

vi.setConfig({ testTimeout: 30_000 });

const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-ag17-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', OLLAMA_URL: 'http://127.0.0.1:9' };
Object.assign(process.env, ENV);

/** The agent's own model: scripted. It records what it was offered and the model it was asked to be. */
const side = vi.hoisted(() => ({ offered: [] as string[][], models: [] as string[], messages: [] as number[], call: undefined as undefined | { match: string; input: Record<string, unknown> } }));
vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:9',
  modelOptions: async () => [],
  agentModel: (config: { provider?: string; model?: string } | undefined): LanguageModel => {
    if (!config?.model) throw new Error('Choose a model for this agent first');
    return {
      provider: 'scripted',
      model: config.model,
      async generate(input) {
        const last = input.messages.at(-1) as AgentMessage | undefined;
        if (last?.role === 'user') {
          side.offered.push(input.tools.map((t) => t.name));
          side.models.push(`${config.provider}/${config.model}`);
          side.messages.push(input.messages.length);
          if (side.call) {
            const name = input.tools.find((t) => new RegExp(side.call!.match, 'i').test(t.name))?.name;
            if (name) return { text: '', toolCalls: [{ id: 'c1', name, input: side.call.input }], stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } };
          }
        }
        return { text: 'Done.', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
  },
}));

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { plugin: textToolkit } = await import('../../../plugins/text-toolkit/src/main');
const { plugin: messaging } = await import('../../../plugins/messaging/src/main');
const { agentStore, configOf } = await import('@/lib/server/agents/store');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
const { store } = await import('@/lib/server/store');
const { database } = await import('@/lib/server/db');
const { credentials } = await import('@/lib/server/credentials/vault');
const { runWorkflow } = await import('@/lib/server/runner');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const flowMoves = await import('@/lib/server/agents/flow-moves');
const movesRoute = await import('@/app/api/workflows/[id]/agent-moves/route');
const agentMovesRoute = await import('@/app/api/agents/[id]/moves/route');

type Handler = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
const call = async (route: unknown, method: string, path: string, params: Record<string, string>, body?: unknown) => {
  const response = await (route as Handler)(new Request(`http://localhost:3000${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) }), { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as Record<string, any> };
};
const post = (id: string, body: unknown = {}, query = '') => call(movesRoute.POST, 'POST', `/api/workflows/${id}/agent-moves${query}`, { id }, body);

const LEGACY = JSON.parse(readFileSync(new URL('./fixtures/legacy-agent-flow.json', import.meta.url), 'utf8')) as Workflow;
const SECRET = 'made-up-password-for-ag17';

let seq = 0;
const model = (name: string) => ({ provider: 'anthropic' as const, model: name });
/** An agent with a published version (made-up model). */
function makeAgent(name = `Utility helper ${++seq}`, config: Record<string, unknown> = {}) {
  const agent = agentStore.create({ name, description: 'decodes and hashes', instructions: 'Help.', model: model('claude-sonnet-5-5'), ...config });
  return agentStore.publish(agent.id)!;
}
/** The legacy fixture with its agent id filled in, under a new id (and optionally a different wiring). */
function saveFlow(agentId: string, patch: (flow: Workflow) => Workflow = (f) => f, name?: string): Workflow {
  const id = `legacy_${++seq}`;
  const base = JSON.parse(JSON.stringify(LEGACY).replace('<AGENT_ID>', agentId)) as Workflow;
  return store.saveWorkflow({ ...patch({ ...base, id, name: name ?? `Legacy ${id}` }), id }, { actor: TEST_OWNER.id });
}
const wire = (flow: Workflow, node: Record<string, unknown>, type: 'ai_tool' | 'ai_languageModel' | 'ai_memory' | 'ai_embedding', target = 'n-agent'): Workflow => ({
  ...flow,
  nodes: [...flow.nodes, { typeVersion: 1, position: [0, 300], parameters: {}, ...node } as never],
  connections: [...flow.connections, { id: `c-${node.id}`, type, source: node.id as string, sourceIndex: 0, target, targetIndex: 0 }],
});
const withoutSlug = (flow: Workflow): Workflow => ({ ...flow, nodes: flow.nodes.filter((n) => n.id !== 'n-slug'), connections: flow.connections.filter((c) => c.source !== 'n-slug') });
const draftTools = (agentId: string) => agentStore.get(agentId)!.tools;
const rows = () => database().all<Record<string, unknown>>('SELECT * FROM agent_flow_moves ORDER BY id');
const owner = { id: TEST_OWNER.id, role: TEST_OWNER.role } as never;

beforeAll(async () => {
  // The workflows' owner for the start pass (a saved flow's creator, else the instance owner).
  const { createOwner } = await import('@/lib/server/auth/users');
  await createOwner({ email: 'owner@landflow.test', name: 'Owner', password: 'landflow-dev-only' });
  registry.registerBuiltin(corePlugin);
  registry.registerBuiltin(textToolkit);
  registry.registerBuiltin(messaging);
});
beforeEach(() => {
  for (const w of store.listWorkflows()) store.deleteWorkflow(w.id);
  for (const row of rows()) database().delete('agent_flow_moves', { id: row.id as string });
  side.offered.length = 0;
  side.models.length = 0;
  side.messages.length = 0;
  side.call = undefined;
  vi.restoreAllMocks();
});

describe('on open (R1–R5, R8, R9, R12)', () => {
  it('moves Slugify into the draft, keeps Window Memory, says it in the notice’s three lines, and a dry run changes nothing', async () => {
    const agent = makeAgent('Utility helper');
    const flow = saveFlow(agent.id);
    const before = { agent: JSON.stringify(agentStore.get(agent.id)), flow: JSON.stringify(store.getWorkflow(flow.id)) };

    const dry = await post(flow.id, { updatedAt: flow.updatedAt }, '?dryRun=1');
    expect(dry.status).toBe(200);
    expect((dry.body as AgentMoveResult).dryRun).toBe(true);
    expect((dry.body as AgentMoveResult).moved.map((m) => m.name)).toEqual(['Slugify']);
    expect(JSON.stringify(agentStore.get(agent.id))).toBe(before.agent);
    expect(JSON.stringify(store.getWorkflow(flow.id))).toBe(before.flow);
    expect(rows()).toHaveLength(0);

    const publishedBefore = JSON.stringify(agentStore.get(agent.id)!.published);
    const res = await post(flow.id, { updatedAt: flow.updatedAt });
    const result = res.body as AgentMoveResult;
    expect(res.status).toBe(200);
    expect(result.moved).toHaveLength(1);
    expect(result.moved[0]).toMatchObject({ name: 'Slugify', outcome: 'moved', as: 'tool', agentName: 'Utility helper', by: TEST_OWNER.id });
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]).toMatchObject({ name: 'Window Memory', outcome: 'kept', why: KEEP_WHY.memory });

    // The agent's DRAFT has Slugify as a node tool the way it ran (no ask, it writes nothing); the published version is untouched.
    const tool = draftTools(agent.id).find((t) => t.type === 'node');
    expect(tool).toMatchObject({ type: 'node', nodeType: 'text-toolkit.slugify', name: 'slugify', requireApproval: false });
    expect(result.moved[0]!.why).toBeUndefined();
    // Wave ag4 carryover (live pass E1): the draft's instructions say the moved tool is its job too (a job list made it refuse).
    const draft = agentStore.get(agent.id)!;
    const instructions = String((draft as unknown as { instructions?: unknown }).instructions ?? (draft as unknown as { draft?: { instructions?: unknown } }).draft?.instructions ?? '');
    expect(instructions).toContain('Also your job: slugify (');
    expect(JSON.stringify(agentStore.get(agent.id)!.published)).toBe(publishedBefore);
    expect(agentStore.get(agent.id)!.published!.config.tools).toHaveLength(0);

    // The flow: no Slugify, no ai_tool edge; Window Memory and its edge stay.
    const saved = store.getWorkflow(flow.id)!;
    expect(saved.nodes.map((n) => n.id).sort()).toEqual(['n-agent', 'n-memory', 'n-trigger']);
    expect(saved.connections.some((c) => c.type === 'ai_tool')).toBe(false);
    expect(saved.connections.some((c) => c.type === 'ai_memory')).toBe(true);
    expect(result.updatedAt).toBe(saved.updatedAt);

    // Two rows: the snapshot and the version before.
    const recorded = rows();
    expect(recorded).toHaveLength(2);
    const moved = recorded.find((r) => r.outcome === 'moved')!;
    expect(JSON.parse(moved.snapshot as string).nodes[0]).toMatchObject({ id: 'n-slug', type: 'text-toolkit.slugify' });
    expect(JSON.parse(moved.snapshot as string).connections[0]).toMatchObject({ id: 'c-slug', type: 'ai_tool' });
    expect(moved.version_before).toBeTruthy();
    expect(moved.id).toBe(`${flow.id}:n-slug`);

    // The notice, in the README's words.
    expect(moveNoticeLines([...result.moved, ...result.kept], result.agents)).toEqual([
      'Moved into Utility helper, not published yet: Slugify (tool).',
      `Kept in this flow: Window Memory. ${KEEP_WHY.memory}`,
      'Utility helper has changes not published: the editor’s tests use them; publish Utility helper, then this workflow, to put them live.',
    ]);
  });

  it('is idempotent (R10): the same POST again, and two start passes over three legacy flows, write nothing', async () => {
    const agent = makeAgent();
    const flow = saveFlow(agent.id);
    await post(flow.id, { updatedAt: flow.updatedAt });
    const snapshot = () => JSON.stringify({ agent: agentStore.get(agent.id), flow: store.getWorkflow(flow.id), rows: rows() });
    const first = snapshot();
    const again = await post(flow.id, { updatedAt: store.getWorkflow(flow.id)!.updatedAt });
    expect((again.body as AgentMoveResult).moved).toEqual([]);
    expect((again.body as AgentMoveResult).kept.map((k) => k.name)).toEqual(['Window Memory']);
    expect((again.body as AgentMoveResult).updatedAt).toBeUndefined();
    expect(snapshot()).toBe(first);

    const a = makeAgent();
    for (let i = 0; i < 3; i++) saveFlow(a.id);
    await flowMoves.startPass();
    const meta = database().get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'agents.flowOverrides.migrated');
    expect(meta).toBeTruthy();
    const drafts = vi.spyOn(agentStore, 'saveDraft');
    const saves = vi.spyOn(store, 'saveWorkflow');
    const writes = vi.spyOn(database(), 'upsert');
    const after = JSON.stringify(rows());
    await flowMoves.startPass();
    expect(drafts).not.toHaveBeenCalled();
    expect(saves).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(JSON.stringify(rows())).toBe(after);
    expect(database().get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'agents.flowOverrides.migrated')).toEqual(meta);
    // One Slugify in the draft, not three: the first moved, the others are "same".
    expect(draftTools(a.id).filter((t) => t.type === 'node')).toHaveLength(1);
    expect(rows().filter((r) => r.agent_id === a.id && r.outcome === 'same')).toHaveLength(2);
  });
});

describe('models (R3)', () => {
  const modelNode = (id: string, name: string) => ({ id, name: `Model ${id}`, type: 'core.anthropicChatModel', parameters: { model: name } });

  it('two flows wiring different models into one agent: both stay, naming the other’s, resolvable; one flow alone moves; same does nothing; resolve moves', async () => {
    const agent = makeAgent();
    const a = saveFlow(agent.id, (f) => wire(withoutSlug(f), modelNode('m1', 'claude-haiku-5-5'), 'ai_languageModel'));
    const b = saveFlow(agent.id, (f) => wire(withoutSlug(f), modelNode('m2', 'claude-opus-5-5'), 'ai_languageModel'));
    const ra = (await post(a.id, { updatedAt: a.updatedAt })).body as AgentMoveResult;
    const rb = (await post(b.id, { updatedAt: b.updatedAt })).body as AgentMoveResult;
    expect(ra.kept.find((k) => k.slot === 'model')).toMatchObject({ outcome: 'kept', resolvable: 'useEverywhere' });
    expect(ra.kept.find((k) => k.slot === 'model')!.why).toBe(KEEP_WHY.modelConflict('claude-opus-5-5 in ' + b.name));
    expect(rb.kept.find((k) => k.slot === 'model')!.why).toContain('claude-haiku-5-5');
    expect(agentStore.get(agent.id)!.model!.model).toBe('claude-sonnet-5-5');
    expect(store.getWorkflow(a.id)!.nodes.some((n) => n.id === 'm1')).toBe(true);

    // A person's choice: use Haiku everywhere.
    const picked = (await post(a.id, { updatedAt: store.getWorkflow(a.id)!.updatedAt, subNodeIds: ['m1'], resolve: { m1: 'useEverywhere' } })).body as AgentMoveResult;
    expect(picked.moved[0]).toMatchObject({ name: 'Model m1', as: 'model', outcome: 'moved' });
    expect(agentStore.get(agent.id)!.model!.model).toBe('claude-haiku-5-5');
    expect(agentStore.get(agent.id)!.published!.config.model!.model).toBe('claude-sonnet-5-5');
    expect(store.getWorkflow(a.id)!.nodes.some((n) => n.id === 'm1')).toBe(false);
  });

  it('one flow alone moves (with the everywhere note when another flow runs the agent); the same model as the draft’s is "same"', async () => {
    const agent = makeAgent();
    const other = saveFlow(agent.id, withoutSlug); // another flow that runs the agent
    const flow = saveFlow(agent.id, (f) => wire(withoutSlug(f), modelNode('m1', 'claude-haiku-5-5'), 'ai_languageModel'));
    const moved = (await post(flow.id, { updatedAt: flow.updatedAt })).body as AgentMoveResult;
    expect(moved.moved[0]).toMatchObject({ outcome: 'moved', as: 'model', why: MOVE_NOTE.everywhere(1) });
    expect(agentStore.get(agent.id)!.model!.model).toBe('claude-haiku-5-5');
    expect(other.id).toBeTruthy();
    const same = saveFlow(agent.id, (f) => wire(withoutSlug(f), modelNode('m3', 'claude-haiku-5-5'), 'ai_languageModel'));
    const s = (await post(same.id, { updatedAt: same.updatedAt })).body as AgentMoveResult;
    expect(s.moved[0]).toMatchObject({ outcome: 'same', as: 'model' });
    expect(store.getWorkflow(same.id)!.nodes.some((n) => n.id === 'm3')).toBe(false);
  });
});

describe('tools and knowledge (R5)', () => {
  it('two flows with the same Slugify: one moved, the other same (one tool in the draft); a different tool with a clashing name is renamed', async () => {
    const agent = makeAgent();
    const one = saveFlow(agent.id);
    const two = saveFlow(agent.id);
    await post(one.id, { updatedAt: one.updatedAt });
    const r = (await post(two.id, { updatedAt: two.updatedAt })).body as AgentMoveResult;
    expect(r.moved[0]).toMatchObject({ outcome: 'same', as: 'tool' });
    expect(draftTools(agent.id).filter((t) => t.type === 'node')).toHaveLength(1);

    const clash = saveFlow(agent.id, (f) => wire(withoutSlug(f), { id: 'n-slug2', name: 'Slugify', type: 'text-toolkit.slugify', parameters: { separator: '_' } }, 'ai_tool'));
    const c = (await post(clash.id, { updatedAt: clash.updatedAt })).body as AgentMoveResult;
    expect(c.moved[0]).toMatchObject({ outcome: 'moved', why: MOVE_NOTE.renamed('slugify_2') });
    expect(draftTools(agent.id).filter((t) => t.type === 'node').map((t) => (t as { name: string }).name)).toEqual(['slugify', 'slugify_2']);
  });

  it('a Send Email sub-node moves with the "doesn’t ask" note and requireApproval false', async () => {
    const agent = makeAgent();
    const flow = saveFlow(agent.id, (f) => wire(withoutSlug(f), { id: 'n-mail', name: 'Send Email', type: 'messaging.emailSend', parameters: { toEmail: 'oncall@landflow.test' } }, 'ai_tool'));
    const r = (await post(flow.id, { updatedAt: flow.updatedAt })).body as AgentMoveResult;
    expect(r.moved[0]).toMatchObject({ outcome: 'moved', why: MOVE_NOTE.noAsk });
    expect(draftTools(agent.id).find((t) => t.type === 'node')).toMatchObject({ nodeType: 'messaging.emailSend', requireApproval: false });
  });

  it('a vector store in retrieve-as-tool mode moves as a knowledge tool; its embeddings leave with it; both are in the snapshot', async () => {
    const agent = makeAgent();
    const flow = saveFlow(agent.id, (f) =>
      wire(wire(withoutSlug(f), { id: 'n-vs', name: 'Runbooks', type: 'core.vectorStoreSqlite', parameters: { mode: 'retrieve-as-tool', collection: 'runbooks', topK: 3 } }, 'ai_tool'), { id: 'n-emb', name: 'Embeddings', type: 'core.embeddingsOllama', parameters: { model: 'nomic-embed-text' } }, 'ai_embedding', 'n-vs'),
    );
    const r = (await post(flow.id, { updatedAt: flow.updatedAt })).body as AgentMoveResult;
    expect(r.moved[0]).toMatchObject({ outcome: 'moved', as: 'knowledge' });
    expect(draftTools(agent.id).find((t) => t.type === 'knowledge')).toMatchObject({ store: 'sqlite', collection: 'runbooks', topK: 3, embeddings: { provider: 'ollama', model: 'nomic-embed-text' } });
    const saved = store.getWorkflow(flow.id)!;
    expect(saved.nodes.some((n) => n.id === 'n-vs' || n.id === 'n-emb')).toBe(false);
    expect(saved.connections.some((c) => c.target === 'n-vs')).toBe(false);
    const snap = JSON.parse(rows().find((x) => x.outcome === 'moved')!.snapshot as string);
    expect(snap.nodes.map((n: { id: string }) => n.id).sort()).toEqual(['n-emb', 'n-vs']);
  });

  it('a node type the host does not know stays with the plugin-offline why and retry, and moves on the next pass once it is known', async () => {
    const agent = makeAgent();
    const flow = saveFlow(agent.id, (f) => wire(withoutSlug(f), { id: 'n-ghost', name: 'Ghost', type: 'ghost-plugin.thing' }, 'ai_tool'));
    const r = (await post(flow.id, { updatedAt: flow.updatedAt })).body as AgentMoveResult;
    expect(r.kept.find((k) => k.name === 'Ghost')).toMatchObject({ outcome: 'kept', why: KEEP_WHY.pluginOffline('ghost-plugin'), retry: true });
    expect(store.getWorkflow(flow.id)!.nodes.some((n) => n.id === 'n-ghost')).toBe(true);
    // Back online: the same flow, a lookup that knows it now.
    const known = { ...flowMoves.liveLookup(owner), resolve: (type: string) => (type === 'ghost-plugin.thing' ? { descriptor: { name: 'thing', displayName: 'Ghost', description: 'x', version: 1, kind: 'action', usableAsTool: true, inputs: [], outputs: [], properties: [] } as never } : registry.resolve(type)) };
    const next = flowMoves.moveFlowOverrides(flow.id, owner, { by: 'migration' }, known as never);
    expect(next.moved[0]).toMatchObject({ name: 'Ghost', outcome: 'moved' });
    expect(draftTools(agent.id).some((t) => t.type === 'node' && t.nodeType === 'ghost-plugin.thing')).toBe(true);
  });

  it('something an agent can’t hold as a tool stays with why', async () => {
    const agent = makeAgent();
    const flow = saveFlow(agent.id, (f) => wire(withoutSlug(f), { id: 'n-calc', name: 'Calculator', type: 'core.calculatorTool' }, 'ai_tool'));
    const r = (await post(flow.id, { updatedAt: flow.updatedAt })).body as AgentMoveResult;
    expect(r.kept.find((k) => k.name === 'Calculator')).toMatchObject({ outcome: 'kept', why: KEEP_WHY.notATool });
  });
});

describe('credentials (R6)', () => {
  it('a credential the agent’s owner may not use stays (access, retry); the same tool with another credential than the agent’s stays (names only, resolvable); no secret anywhere', async () => {
    const mine = credentials.create({ name: 'Mail one', type: 'messaging.smtp', data: { host: 'localhost', port: 25, password: SECRET } });
    const theirs = credentials.create({ name: 'Mail two', type: 'messaging.smtp', data: { host: 'localhost', port: 25, password: SECRET } });
    const mailNode = (cred: { id: string; name: string }) => ({ id: 'n-mail', name: 'Send Email', type: 'messaging.emailSend', parameters: { toEmail: 'oncall@landflow.test' }, credentials: { smtp: { id: cred.id, name: cred.name } } });
    const agent = makeAgent();
    const flow = saveFlow(agent.id, (f) => wire(withoutSlug(f), mailNode(mine), 'ai_tool'));
    const denied = flowMoves.moveFlowOverrides(flow.id, owner, { by: 'migration' }, { ...flowMoves.liveLookup(owner), credentialUsable: () => false } as never);
    expect(denied.kept.find((k) => k.name === 'Send Email')).toMatchObject({ outcome: 'kept', why: KEEP_WHY.credentialAccess('Mail one'), retry: true });

    const first = (await post(flow.id, { updatedAt: store.getWorkflow(flow.id)!.updatedAt })).body as AgentMoveResult;
    expect(first.moved[0]).toMatchObject({ outcome: 'moved' });
    const second = saveFlow(agent.id, (f) => wire(withoutSlug(f), mailNode(theirs), 'ai_tool'));
    const conflict = (await post(second.id, { updatedAt: second.updatedAt })).body as AgentMoveResult;
    expect(conflict.kept.find((k) => k.name === 'Send Email')).toMatchObject({ outcome: 'kept', why: KEEP_WHY.credentialConflict('Mail one', 'Mail two'), resolvable: 'useEverywhere' });
    expect(JSON.stringify([denied, first, conflict, rows(), (await call(movesRoute.GET, 'GET', `/api/workflows/${flow.id}/agent-moves`, { id: flow.id })).body])).not.toContain(SECRET);
  });
});

describe('access, conflicts and protection (R7, R8)', () => {
  it('an agent the caller can’t update keeps every item (access); without workflow update it is 403', async () => {
    const agent = makeAgent();
    const flow = saveFlow(agent.id);
    const kept = flowMoves.moveFlowOverrides(flow.id, owner, { by: owner.id }, { ...flowMoves.liveLookup(owner), canUpdateAgent: () => false } as never);
    expect(kept.moved).toEqual([]);
    expect(kept.kept.map((k) => k.name).sort()).toEqual(['Slugify', 'Window Memory']);
    expect(kept.kept.find((k) => k.name === 'Slugify')).toMatchObject({ why: KEEP_WHY.access(agent.name), retry: true });
    expect(() => flowMoves.moveFlowOverrides(flow.id, { id: 'usr_nobody', role: 'viewer' } as never, { by: 'x' })).toThrowError(/can.t see|not change|view/i);
    try {
      flowMoves.moveFlowOverrides(flow.id, { id: 'usr_nobody', role: 'viewer' } as never, { by: 'x' });
    } catch (e) {
      expect((e as { status: number }).status).toBe(403);
    }
  });

  it('a stale updatedAt is a 412 and nothing changed; a save that fails after the drafts were written puts them back', async () => {
    const agent = makeAgent();
    const flow = saveFlow(agent.id);
    const before = JSON.stringify({ agent: agentStore.get(agent.id), flow: store.getWorkflow(flow.id), rows: rows() });
    const stale = await post(flow.id, { updatedAt: '2000-01-01T00:00:00.000Z' });
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('workflow_conflict');
    expect(JSON.stringify({ agent: agentStore.get(agent.id), flow: store.getWorkflow(flow.id), rows: rows() })).toBe(before);

    const config = configOf(agentStore.get(agent.id)!);
    vi.spyOn(store, 'saveWorkflow').mockImplementation(() => {
      throw new Error('disk full');
    });
    const res = (await post(flow.id, { updatedAt: flow.updatedAt })).body as AgentMoveResult;
    expect(configOf(agentStore.get(agent.id)!)).toEqual(config);
    expect(res.moved).toEqual([]);
    expect(res.kept.find((k) => k.name === 'Slugify')).toMatchObject({ why: KEEP_WHY.saved, retry: true });
    expect(rows().some((r) => r.outcome === 'moved')).toBe(false);
  });

  it('a protected environment keeps everything with its why', () => {
    const agent = makeAgent();
    const flow = saveFlow(agent.id);
    const r = flowMoves.moveFlowOverrides(flow.id, owner, { by: 'migration' }, { ...flowMoves.liveLookup(owner), protectedEnv: true } as never);
    expect(r.moved).toEqual([]);
    expect(r.kept.find((k) => k.name === 'Slugify')!.why).toBe(KEEP_WHY.protectedEnv);
    expect(store.getWorkflow(flow.id)!.nodes.some((n) => n.id === 'n-slug')).toBe(true);
  });

  it('a Run a Team node’s wiring stays in the flow (run-team.ts has no overlay yet); an expression id and an AI Agent node are untouched', async () => {
    const lead = makeAgent('Lead');
    const team = agentTeamStore.create({ name: 'Crew', goal: 'g', members: [{ id: 'm_lead', kind: 'agent', agentId: lead.id, title: 'Lead' }] });
    agentTeamStore.publish(team.id);
    const teamFlow = saveFlow(lead.id, (f) => ({ ...f, nodes: f.nodes.map((n) => (n.id === 'n-agent' ? { ...n, type: 'core.runTeam', parameters: { teamId: team.id, message: 'x' } } : n)) }));
    const r = (await post(teamFlow.id, { updatedAt: teamFlow.updatedAt })).body as AgentMoveResult;
    expect(r.moved).toEqual([]);
    expect(store.getWorkflow(teamFlow.id)!.nodes.some((n) => n.id === 'n-slug')).toBe(true);
    expect(draftTools(lead.id)).toHaveLength(0);

    const other = makeAgent('Other');
    const expr = saveFlow(other.id, (f) => ({ ...f, nodes: f.nodes.map((n) => (n.id === 'n-agent' ? { ...n, parameters: { agentId: '={{ $json.agent }}' } } : n)) }));
    const ai = saveFlow(other.id, (f) => ({ ...f, nodes: f.nodes.map((n) => (n.id === 'n-agent' ? { ...n, type: 'core.aiAgent', parameters: {} } : n)) }));
    for (const f of [expr, ai]) {
      const res = (await post(f.id, { updatedAt: f.updatedAt })).body as AgentMoveResult;
      expect(res.moved).toEqual([]);
      expect(res.kept).toEqual([]);
      expect(store.getWorkflow(f.id)!.nodes.some((n) => n.id === 'n-slug')).toBe(true);
    }
    expect(draftTools(other.id)).toHaveLength(0);
  });
});

describe('it keeps running until the agent is republished (R11)', () => {
  const run = (flow: Workflow) => runWorkflow({ workflow: flow, mode: 'manual', startNodeId: 'n-trigger', triggerItems: [{ json: {} }] });
  const offeredSlug = () => (side.offered.at(-1) ?? []).filter((n) => /slugify/i.test(n)).length;

  it('offers Slugify exactly once before the move, while pending (the overlay) and after Publish; the memory holds the conversation in all three', async () => {
    const agent = makeAgent('Utility helper');
    const flow = saveFlow(agent.id);
    side.call = { match: 'slugify', input: { text: 'Wave AG4' } };
    expect((await run(flow)).status).toBe('success');
    expect(offeredSlug()).toBe(1);
    const beforeMove = side.offered.length;

    const res = (await post(flow.id, { updatedAt: flow.updatedAt })).body as AgentMoveResult;
    expect(res.moved).toHaveLength(1);
    const moved = store.getWorkflow(flow.id)!;
    expect((await run(moved)).status).toBe('success');
    expect(offeredSlug()).toBe(1);
    expect(side.offered.at(-1)!.filter((n) => /slugify/i.test(n))).toHaveLength(1);

    agentStore.publish(agent.id);
    expect((await run(moved)).status).toBe('success');
    expect(offeredSlug()).toBe(1);
    // The flow's memory: later runs see the earlier conversation (more messages in the model's input than a fresh one's).
    expect(side.offered.length).toBeGreaterThan(beforeMove);
    expect(side.messages.at(-1)!).toBeGreaterThan(side.messages[0]!);

    // Withdrawn: a person removes it from the draft: the flow follows the agent.
    agentStore.saveDraft(agent.id, { tools: [] });
    agentStore.unpublish(agent.id);
    agentStore.publish(agent.id);
    side.call = undefined;
    await run(moved);
    expect(offeredSlug()).toBe(0);
  });

  it('a moved model is the run’s model while pending', async () => {
    const agent = makeAgent();
    const flow = saveFlow(agent.id, (f) => wire(withoutSlug(f), { id: 'm1', name: 'Model', type: 'core.anthropicChatModel', parameters: { model: 'claude-haiku-5-5' } }, 'ai_languageModel'));
    const res = (await post(flow.id, { updatedAt: flow.updatedAt })).body as AgentMoveResult;
    expect(res.moved[0]).toMatchObject({ as: 'model', outcome: 'moved' });
    await run(store.getWorkflow(flow.id)!);
    expect(side.models.at(-1)).toBe('anthropic/claude-haiku-5-5');
  });

  it('no overlay on a pinned node (a production copy), on a graph that still wires the sub-node, or when the config already has the tool', async () => {
    const agent = makeAgent();
    const flow = saveFlow(agent.id);
    await post(flow.id, { updatedAt: flow.updatedAt });
    const fresh = agentStore.get(agent.id)!;
    const config = configOf(fresh.published!);
    const base = { wired: new Set<string>(), config };
    expect(flowMoves.pendingFor(flow.id, 'n-agent', fresh, { ...base, pinned: 1 })).toBeUndefined();
    expect(flowMoves.pendingFor(flow.id, 'n-agent', fresh, { ...base, wired: new Set(['n-slug']) })).toBeUndefined();
    expect(flowMoves.pendingFor(flow.id, 'n-agent', fresh, { ...base, config: configOf(fresh) })).toBeUndefined();
    expect(flowMoves.pendingFor(flow.id, 'n-agent', fresh, base)?.tools).toHaveLength(1);
  });
});

describe('readable later (R9)', () => {
  it('the routes answer the rows with their state: pending, then live after Publish', async () => {
    const agent = makeAgent();
    const flow = saveFlow(agent.id);
    await post(flow.id, { updatedAt: flow.updatedAt });
    const byFlow = await call(movesRoute.GET, 'GET', `/api/workflows/${flow.id}/agent-moves`, { id: flow.id });
    expect(byFlow.body.moves.map((m: { name: string; outcome: string }) => [m.name, m.outcome]).sort()).toEqual([['Slugify', 'moved'], ['Window Memory', 'kept']]);
    expect(byFlow.body.moves.find((m: { name: string }) => m.name === 'Slugify').state).toBe('pending');
    agentStore.publish(agent.id);
    const byAgent = await call(agentMovesRoute.GET, 'GET', `/api/agents/${agent.id}/moves`, { id: agent.id });
    expect(byAgent.body.moves.find((m: { name: string }) => m.name === 'Slugify')).toMatchObject({ state: 'live', workflowId: flow.id, agentName: agent.name });
    expect((await call(movesRoute.GET, 'GET', '/api/workflows/nope/agent-moves', { id: 'nope' })).status).toBe(404);
    expect((await call(agentMovesRoute.GET, 'GET', '/api/agents/nope/moves', { id: 'nope' })).status).toBe(404);
  });

  it('the node’s notice names the bubbles and "this flow only"', async () => {
    const node = corePlugin.nodes.find((n) => n.description.name === 'messageAgent')!;
    const notice = node.description.properties.find((p) => p.name === 'notice')!.displayName;
    expect(notice).toMatch(/bubbles under this node/);
    expect(notice).toMatch(/runs in this flow only/);
  });
});
