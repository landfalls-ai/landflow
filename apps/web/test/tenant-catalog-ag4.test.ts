/**
 * AG18 (wave ag4): Spotlight knows the tenant through tools. The catalog functions answer the contract's shapes for
 * what the caller may read (drafts included, plugins and credential needs, document counts), the chat's tool loop and the
 * architect call them as steps of the trace (never as usage), the roster lists drafts after published agents, and no
 * answer holds a secret. Scripted models and in-process plugins; nothing leaves this machine.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateInput, LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import { defineNode, definePlugin } from '@landflow/sdk';
import { agentLine, credentialNeedLine, TENANT_READ_TOOLS, type CatalogAgent, type CatalogToolNode, type KnowledgeListing } from '@/lib/shared/tenant-catalog';
import type { NodeTypeInfo } from '@/lib/shared/types';

vi.setConfig({ testTimeout: 30_000 });

// The build plan's one model call is scripted: the route's own roster read is what this file looks at.
const planned = vi.hoisted(() => ({ agents: [] as Array<{ name: string; published?: boolean }> }));
vi.mock('@/lib/server/assistant/build-plan', async (original) => ({
  ...(await original<typeof import('@/lib/server/assistant/build-plan')>()),
  planFlow: vi.fn(async (_prompt: string, input: { agents?: Array<{ name: string; published?: boolean }> }) => {
    planned.agents = input.agents ?? [];
    return { plan: { steps: [] }, alternatives: [] };
  }),
}));

const SMTP_PASSWORD = 'pw-ag18-smtp-made-up';
const DB_PASSWORD = 'pw-ag18-salesdb-made-up';
const SECRETS = [SMTP_PASSWORD, DB_PASSWORD];

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-ag18-catalog-'));
const filesDir = join(dataDir, 'files');
mkdirSync(filesDir, { recursive: true });
cpSync(join(import.meta.dirname, 'spotlight-scenarios', 'fixtures', 'runbooks'), join(filesDir, 'runbooks'), { recursive: true });
const ENV = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_FILES_DIR: filesDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_BUILDER_MODEL: 'anthropic/claude-sonnet-5-5',
  ANTHROPIC_API_KEY: 'sk-ant-made-up-for-the-test',
  OLLAMA_URL: 'http://127.0.0.1:9',
};
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { agentStore } = await import('@/lib/server/agents/store');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { database } = await import('@/lib/server/db');
const { indexFolder } = await import('@/lib/server/agents/knowledge');
const { withAuth } = await import('@/lib/server/auth/context');
const { enableTestAuth, TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { plugin: triage } = await import('../../../plugins/triage/src/main');
const { plugin: messaging } = await import('../../../plugins/messaging/src/main');
const catalog = await import('@/lib/server/assistant/tenant-catalog');
const { tenantTool, TENANT_TOOL_NAMES } = await import('@/lib/server/assistant/tenant-tools');
const { AGENT_PRACTICES } = await import('@/lib/server/assistant/agent-practices');
const { runChat, TOOLS } = await import('@/lib/server/assistant/chat');
const { runArchitect } = await import('@/lib/server/assistant/architect');
const { roster } = await import('@/lib/server/assistant/roster');
const { describeAgents } = await import('@/lib/shared/agent-brief');
const planRoute = await import('@/app/api/ai/build/plan/route');

const SECOND = { id: 'usr_second_ag18', role: 'member' as const };
let types: NodeTypeInfo[];
let s1: string;
let draftOnly: string;

const KNOWLEDGE = { id: 'tl_k', type: 'knowledge' as const, name: 'search_runbooks', description: 'Search the runbooks', store: 'sqlite' as const, collection: 'runbooks', embeddings: { provider: 'none' as const, model: 'bm25' } };

beforeAll(async () => {
  enableTestAuth(TEST_OWNER);
  registry.registerBuiltin(corePlugin);
  registry.registerBuiltin(triage);
  registry.registerBuiltin(messaging);
  // A plugin that is offline: its node is listed nowhere.
  registry.registerBuiltin(
    definePlugin({
      info: { id: 'sleeper', name: 'Sleeper', version: '0.0.1', language: 'typescript' },
      nodes: [defineNode({ description: { name: 'wake', displayName: 'Wake IP addresses', description: 'Wakes IP addresses', version: 1, kind: 'action', inputs: ['main'], outputs: ['main'], properties: [] }, async execute() { return [[{ json: {} }]]; } })],
    }),
  );
  const real = registry.nodeTypes.bind(registry);
  vi.spyOn(registry, 'nodeTypes').mockImplementation(() => real().map((t) => (t.pluginId === 'sleeper' ? { ...t, available: false } : t)));
  types = registry.nodeTypes().filter((t) => t.available);

  const smtp = credentials.create({ name: 'Mailpit SMTP', type: 'messaging.smtp', data: { host: '127.0.0.1', port: 51193, secure: false, disableStartTls: true, user: 'mail', password: SMTP_PASSWORD } });
  credentials.create({ name: 'Sales DB', type: 'core.postgres', data: { host: '127.0.0.1', port: 5432, database: 'sales', user: 'app', password: DB_PASSWORD, ssl: 'disable' } });
  await indexFolder(KNOWLEDGE, 'runbooks');

  const triaged = agentStore.create({
    name: 'Alert triager',
    description: 'Reads an alert, finds the runbook and emails the on-call',
    instructions: 'Input: an alert. Steps: 1. Extract. Output: three lines. Hand over when: no runbook matches.',
    model: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    tools: [
      { id: 'tl_1', type: 'node', name: 'send_email', description: 'Email the on-call', nodeType: 'messaging.emailSend', parameters: {}, credentials: { smtp: { id: smtp.id, name: 'Mailpit SMTP' } }, requireApproval: true },
      { id: 'tl_2', type: 'node', name: 'extract_iocs', description: 'Pull IPs out', nodeType: 'triage.extractIocs', parameters: {} },
      KNOWLEDGE,
    ],
  });
  s1 = triaged.id;
  agentStore.publish(s1);
  draftOnly = agentStore.create({ name: 'Draft helper', description: 'Not published yet', instructions: 'Help.' }).id;
  const flow: Workflow = { id: 'wf_triage_ag18', name: 'Alert desk', nodes: [{ id: 'n1', name: 'Triage', type: 'core.messageAgent', typeVersion: 1, position: [0, 0], parameters: { agentId: s1, message: 'x' } }], connections: [] };
  store.saveWorkflow(flow);
});
afterAll(() => {
  vi.restoreAllMocks();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const asJson = async (name: string, args: Record<string, unknown> = {}, actor: typeof TEST_OWNER | typeof SECOND | undefined = TEST_OWNER) => JSON.parse((await tenantTool(name, args, { actor })).text);

describe('list_agents', () => {
  beforeEach(() => enableTestAuth(TEST_OWNER));
  it('lists a published agent and a draft-only one, with plugin, asks first, credential, knowledge and where it runs', async () => {
    const list = (await asJson('list_agents')) as CatalogAgent[];
    const triager = list.find((a) => a.id === s1)!;
    expect(triager).toMatchObject({ name: 'Alert triager', published: 1, draftDiffers: false, model: 'anthropic/claude-sonnet-5-5', knowledge: ['runbooks'], usedBy: { count: 1, names: ['Alert desk'] } });
    const email = triager.tools.find((t) => t.name === 'send_email')!;
    expect(email).toEqual({ name: 'send_email', kind: 'node', nodeType: 'messaging.emailSend', plugin: 'Messaging', asksFirst: true, credential: 'Mailpit SMTP' });
    const iocs = triager.tools.find((t) => t.name === 'extract_iocs')!;
    expect(iocs).toMatchObject({ plugin: 'Alert Triage' });
    expect(iocs.asksFirst).toBeUndefined();
    const draft = list.find((a) => a.id === draftOnly)!;
    expect(draft.published).toBeUndefined();
    expect(draft.draftDiffers).toBe(false);
    expect(agentLine(triager)).toContain('send_email (asks first)');
  });

  it('shows the draft changes of a published agent, and narrows by a query', async () => {
    agentStore.saveDraft(s1, { description: 'Reads an alert and emails the on-call, with changes' });
    expect((await asJson('list_agents', { query: 'runbook' })).map((a: CatalogAgent) => a.id)).toEqual([s1]);
    expect(((await asJson('list_agents')) as CatalogAgent[]).find((a) => a.id === s1)!.draftDiffers).toBe(true);
    agentStore.saveDraft(s1, { description: 'Reads an alert, finds the runbook and emails the on-call' });
  });

  it('answers a second user only what they may read', async () => {
    const answer = await tenantTool('list_agents', {}, { actor: SECOND });
    expect(answer.text).toBe('There are no agents yet.');
    expect((await tenantTool('get_agent', { id: s1 }, { actor: SECOND })).ok).toBe(false);
  });

  it('get_agent reads one by id or name with its instructions and tool parameters', async () => {
    const byId = await asJson('get_agent', { id: s1 });
    expect(byId.instructions).toContain('Hand over when');
    expect(byId.toolParameters.map((t: { name: string }) => t.name)).toEqual(['send_email', 'extract_iocs']);
    expect((await asJson('get_agent', { id: 'alert triager' })).id).toBe(s1);
  });
});

describe('list_tool_nodes', () => {
  it('ranks Extract IOCs first for IP addresses in an alert, and says what Send Email needs', async () => {
    const found = (await asJson('list_tool_nodes', { query: 'IP addresses and domains in an alert' })) as CatalogToolNode[];
    expect(found[0]!.nodeType).toBe('triage.extractIocs');
    expect(found[0]!.plugin).toBe('Alert Triage');
    const send = ((await asJson('list_tool_nodes', { query: 'send an email' })) as CatalogToolNode[]).find((n) => n.nodeType === 'messaging.emailSend')!;
    expect(send.writes).toBe(true);
    expect(send.plugin).toBe('Messaging');
    expect(send.credentials).toEqual([expect.objectContaining({ type: 'messaging.smtp', required: true, yours: ['Mailpit SMTP'] })]);
    expect(credentialNeedLine(send)).toContain('yours: Mailpit SMTP');
    expect(found.find((n) => n.nodeType === 'triage.extractIocs')!.writes).toBe(false);
  });

  it('lists nothing of a plugin that is offline', async () => {
    expect(((await asJson('list_tool_nodes', { query: 'IP addresses' })) as CatalogToolNode[]).some((n) => n.pluginId === 'sleeper')).toBe(false);
    expect(((await asJson('list_tool_nodes')) as CatalogToolNode[]).some((n) => n.pluginId === 'sleeper')).toBe(false);
  });
});

describe('knowledge, models, credentials and practices', () => {
  it('lists runbooks with 4 documents, keyword search and the folder it came from', async () => {
    const listing = (await asJson('list_knowledge_bases')) as KnowledgeListing;
    expect(listing.bases).toEqual([expect.objectContaining({ collection: 'runbooks', documents: 4, search: 'keyword', indexedFrom: 'runbooks', usedBy: ['Alert triager'] })]);
    expect(listing.folders).toEqual([{ path: 'runbooks', files: 4 }]);
    expect(listing.newSearch).toBe('keyword');
  });

  it('lists the builder model first, marked as the default', async () => {
    const models = await asJson('list_models');
    expect(models[0]).toMatchObject({ model: 'anthropic/claude-sonnet-5-5', isDefault: true });
    expect(models.filter((m: { isDefault: boolean }) => m.isDefault)).toHaveLength(1);
  });

  it('lists credentials by name and type only', async () => {
    expect(await asJson('list_credentials')).toEqual([{ name: 'Mailpit SMTP', type: 'messaging.smtp' }, { name: 'Sales DB', type: 'core.postgres' }]);
  });

  it('keeps the practices equal to the documented block', () => {
    const doc = readFileSync(join(import.meta.dirname, '..', '..', '..', 'docs', 'platform', 'agent-best-practices.md'), 'utf8');
    const block = doc.slice(doc.indexOf('<!-- practices:start -->') + '<!-- practices:start -->'.length, doc.indexOf('<!-- practices:end -->')).trim();
    expect(AGENT_PRACTICES.trim()).toBe(block);
  });

  it('holds no secret in any answer', async () => {
    for (const name of TENANT_TOOL_NAMES) {
      const text = (await tenantTool(name, { id: s1, query: 'email' }, { actor: TEST_OWNER })).text;
      for (const secret of SECRETS) expect(text).not.toContain(secret);
    }
    expect(TENANT_READ_TOOLS).toEqual(expect.arrayContaining([...TENANT_TOOL_NAMES]));
  });
});

/** A scripted model that records what it was asked. */
function scripted(turns: Array<Partial<ModelTurn>>) {
  const calls: GenerateInput[] = [];
  const model: LanguageModel = {
    provider: 'test',
    model: 'scripted',
    async generate(input) {
      calls.push({ ...input, messages: [...input.messages] });
      const next = turns.shift();
      if (!next) throw new Error('No scripted turn left');
      return { text: '', toolCalls: [], stopReason: 'stop', ...next };
    },
  };
  return { model, calls };
}
const usageRows = () => database().all<{ n: number }>('SELECT COUNT(*) AS n FROM ai_usage')[0]!.n;
const flow = (): Workflow => ({ id: 'wf_ag18', name: 'Flow', nodes: [{ id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }], connections: [] });

describe('Spotlight and the architect read the tenant as tool steps', () => {
  it('chat: list_agents is a step of the trace, answers the catalog, and writes no usage', async () => {
    const before = usageRows();
    const { model, calls } = scripted([
      { toolCalls: [{ id: 'c1', name: 'list_agents', input: {} }] },
      { toolCalls: [{ id: 'c2', name: 'propose_changes', input: { summary: 'Added a note', ops: [{ op: 'addNode', type: 'core.stickyNote', name: 'Note', parameters: { content: 'x' }, after: 'Start' }] } }] },
      { text: 'Done.' },
    ]);
    const events: Array<{ type: string; name?: string; label?: string; ok?: boolean }> = [];
    await runChat({ messages: [{ role: 'user', content: 'What agents do we have? Then add a note' }], workflow: flow(), model, types, actor: TEST_OWNER, userId: TEST_OWNER.id, trace: true, onEvent: (e) => events.push(e as never) });
    expect(TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining([...TENANT_TOOL_NAMES]));
    expect(events.find((e) => e.type === 'tool' && e.name === 'list_agents')).toMatchObject({ label: 'Looked at 2 agents', ok: true });
    const result = JSON.stringify(calls[1]!.messages);
    expect(result).toContain('Alert triager');
    expect(result).toContain((await tenantTool('list_agents', {}, { actor: TEST_OWNER })).text.slice(0, 60).replace(/"/g, '\\"'));
    expect(usageRows()).toBe(before);
  });

  it('chat without a signed-in actor says to sign in', async () => {
    const { model, calls } = scripted([{ toolCalls: [{ id: 'c1', name: 'list_models', input: {} }] }, { text: 'ok' }]);
    await runChat({ messages: [{ role: 'user', content: 'Which models?' }], workflow: flow(), model, types, onEvent: () => {} });
    expect(JSON.stringify(calls[1]!.messages)).toContain('Sign in to read the tenant.');
  });

  it('the architect answers list_agents and list_knowledge_bases in the contract shape, drafts and counts included', async () => {
    const { model, calls } = scripted([{ toolCalls: [{ id: 'c1', name: 'list_agents', input: {} }, { id: 'c2', name: 'list_knowledge_bases', input: {} }] }, { text: 'Which?' }]);
    const events: Array<{ type: string; name?: string; label?: string }> = [];
    await runArchitect({ messages: [{ role: 'user', content: 'An agent for alerts' }], model, types, actor: TEST_OWNER, onEvent: (e) => events.push(e as never) });
    const last = calls[1]!.messages.at(-1) as { results: Array<{ name: string; content: string }> };
    const agents = JSON.parse(last.results.find((r) => r.name === 'list_agents')!.content) as CatalogAgent[];
    expect(agents.map((a) => a.name).sort()).toEqual(['Alert triager', 'Draft helper']);
    const knowledge = JSON.parse(last.results.find((r) => r.name === 'list_knowledge_bases')!.content) as KnowledgeListing;
    expect(knowledge.bases[0]).toMatchObject({ collection: 'runbooks', documents: 4 });
    expect(events.filter((e) => e.type === 'tool').map((e) => e.label)).toEqual(['Looked at 2 agents', 'Looked at 1 knowledge base']);
  });
});

describe('the roster', () => {
  beforeEach(() => enableTestAuth(TEST_OWNER));
  it('lists the draft-only agent after the published one, and describes model, asks first and knowledge', () => {
    const { agents } = withAuth({ principal: { user: TEST_OWNER, via: 'test' } }, () => roster());
    expect(agents.map((a) => a.id)).toEqual([s1, draftOnly]);
    expect(agents[0]).toMatchObject({ model: 'anthropic/claude-sonnet-5-5', knowledge: ['runbooks'], asksFirst: ['send_email'], usedBy: 1 });
    expect(agents[0]!.published).toBeUndefined();
    expect(agents[1]).toMatchObject({ published: false, version: 0 });
    const text = describeAgents(agents);
    expect(text).toContain('Tools: send_email (asks first), extract_iocs, search_runbooks.');
    expect(text).toContain('Model: claude-sonnet-5-5.');
    expect(text).toContain('Knowledge: runbooks.');
    expect(text).toContain(`(agentId ${draftOnly}, not published)`);
  });

  it('the build plan route says it read the agents, as a step of the trace', async () => {
    const response = await withAuth({ principal: { user: TEST_OWNER, via: 'test' } }, () =>
      planRoute.POST(new Request('http://localhost/api/ai/build/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Email the on-call when an alert comes in', model: 'anthropic/claude-sonnet-5-5' }) })),
    );
    const body = (await response.json()) as { steps?: Array<{ tool: string; label: string }>; error?: string };
    expect(response.status, body.error).toBe(200);
    expect(body.steps).toEqual([{ tool: 'list_agents', label: 'Looked at 2 agents', ok: true }]);
    expect(planned.agents.map((a) => a.name)).toEqual(['Alert triager', 'Draft helper']);
  });
});
