/**
 * AG18 (wave ag4): the instance MCP server's agent tools. The reads answer what Spotlight's own tools answer (parity); an API
 * key's scopes decide what is listed and callable (reads `workflows:read`, create/update `workflows:write`, test/publish
 * `run`); the writes save a draft, change the draft only, smoke-test it and publish through the eval gate, which has no
 * `skipEval`; a caller who may not update an agent gets "not found". Called through the MCP client over an in-memory
 * transport; the agent's model and the judge are scripted.
 */
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/client';
import type { LanguageModel, ModelTurn } from '@landflow/engine';
import type { ApiKeyScope } from '@/lib/shared/auth';

vi.setConfig({ testTimeout: 30_000 });

const side = vi.hoisted(() => ({ score: 5, reply: 'I triage alerts.', judged: 0 }));
vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:9',
  modelOptions: async () => [],
  agentModel: async (config: { model?: string } | undefined): Promise<LanguageModel> => {
    if (!config?.model) throw new Error('Choose a model for this agent first');
    const usage = { inputTokens: 1, outputTokens: 1 };
    return {
      provider: 'anthropic',
      model: config.model,
      generate: async (input): Promise<ModelTurn> => {
        if ((input.system ?? '').includes('"score"')) {
          side.judged += 1;
          return { text: JSON.stringify({ score: side.score, reasoning: 'scripted judge' }), toolCalls: [], stopReason: 'end_turn', usage };
        }
        return { text: side.reply, toolCalls: [], stopReason: 'end_turn', usage };
      },
    };
  },
}));

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-ag18-mcp-'));
const filesDir = join(dataDir, 'files');
mkdirSync(filesDir, { recursive: true });
cpSync(join(import.meta.dirname, 'spotlight-scenarios', 'fixtures', 'runbooks'), join(filesDir, 'runbooks'), { recursive: true });
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_FILES_DIR: filesDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://mcp.test', LANDFLOW_BUILDER_MODEL: 'anthropic/claude-sonnet-5-5', ANTHROPIC_API_KEY: 'sk-ant-made-up', OLLAMA_URL: 'http://127.0.0.1:9' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { agentStore } = await import('@/lib/server/agents/store');
const { addCase } = await import('@/lib/server/agents/eval-gate');
const { instanceServer } = await import('@/lib/server/mcp/instance-tools');
const { tenantTool, TENANT_TOOL_NAMES } = await import('@/lib/server/assistant/tenant-tools');
const { setHomeProject } = await import('@/lib/server/projects/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { plugin: triage } = await import('../../../plugins/triage/src/main');

beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  registry.registerBuiltin(triage);
});
afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const text = (result: CallToolResult) => ((result.content ?? []) as Array<{ type: string; text?: string }>).filter((p) => p.type === 'text').map((p) => p.text).join('');

async function connect(actor?: typeof TEST_OWNER | { id: string; role: 'member' }, keyScopes?: ApiKeyScope[], scope?: { projectId: string }) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await instanceServer(actor, scope, keyScopes).connect(serverSide);
  const client = new Client({ name: 'ag18-test', version: '1.0.0' });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    try {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      return { failed: Boolean(result.isError), raw: text(result), data: result.isError ? undefined : (() => { try { return JSON.parse(text(result)); } catch { return undefined; } })() };
    } catch (caught) {
      return { failed: true, raw: (caught as Error).message, data: undefined };
    }
  };
  const names = async () => (await client.listTools()).tools.map((t) => t.name);
  return { client, call, names };
}

const CONFIG = {
  name: 'Mcp triager',
  description: 'Reads an alert and says what to do',
  model: { provider: 'anthropic' as const, model: 'claude-sonnet-5-5' },
  instructions: 'Input: an alert. Steps: 1. Read it. Output: one line. Hand over when: unsure.',
};

describe('parity with Spotlight’s own tools', () => {
  it('every read tool answers what tenantTool answers for the same actor', async () => {
    agentStore.create({ ...CONFIG, name: 'Parity agent' });
    const { call, names } = await connect(TEST_OWNER);
    expect(await names()).toEqual(expect.arrayContaining([...TENANT_TOOL_NAMES, 'create_agent', 'update_agent', 'test_agent', 'publish_agent']));
    const id = agentStore.list()[0]!.id;
    const cases: Array<[string, Record<string, unknown>]> = [['list_agents', {}], ['get_agent', { id }], ['list_tool_nodes', { query: 'IP addresses' }], ['list_knowledge_bases', {}], ['list_models', {}], ['list_credentials', {}], ['read_agent_practices', {}]];
    for (const [name, args] of cases) {
      const mcp = await call(name, args);
      expect(mcp.failed, `${name}: ${mcp.raw}`).toBe(false);
      expect(mcp.raw).toBe((await tenantTool(name, args, { actor: TEST_OWNER })).text);
    }
    // No actor (the instance access token): the instance's view, the same list.
    const instance = await connect(undefined);
    expect((await instance.call('list_agents')).raw).toBe((await tenantTool('list_agents', {}, {})).text);
  });
});

describe('API-key scopes', () => {
  it('a workflows:read key sees the read tools only', async () => {
    const { call, names } = await connect(TEST_OWNER, ['workflows:read']);
    const listed = await names();
    expect(listed).toEqual(expect.arrayContaining([...TENANT_TOOL_NAMES]));
    for (const write of ['create_agent', 'update_agent', 'test_agent', 'publish_agent']) expect(listed).not.toContain(write);
    const refused = await call('create_agent', { config: CONFIG });
    expect(refused.failed).toBe(true);
    expect(agentStore.list().some((a) => a.name === CONFIG.name)).toBe(false);
  });

  it('create and update need workflows:write; test and publish need run', async () => {
    const write = await (await connect(TEST_OWNER, ['workflows:write'])).names();
    expect(write).toEqual(expect.arrayContaining(['create_agent', 'update_agent']));
    expect(write).not.toContain('publish_agent');
    expect(write).not.toContain('test_agent');
    expect(write).not.toContain('list_agents');
    const run = await (await connect(TEST_OWNER, ['run'])).names();
    expect(run).toEqual(expect.arrayContaining(['test_agent', 'publish_agent']));
    expect(run).not.toContain('create_agent');
  });
});

describe('the writes', () => {
  it('create_agent saves a draft and answers its id and the smoke state; it is not published', async () => {
    const { call } = await connect(TEST_OWNER);
    const made = await call('create_agent', { config: CONFIG, smokeMessage: 'An alert: disk full on web-01' });
    expect(made.failed, made.raw).toBe(false);
    expect(made.data).toMatchObject({ name: 'Mcp triager', published: false, smoke: { state: 'passed' }, next: 'publish_agent' });
    const saved = agentStore.get(made.data.id)!;
    expect(saved.published).toBeUndefined();
    expect(saved.model?.model).toBe('claude-sonnet-5-5');
    const bare = await call('create_agent', { config: { name: 'No model yet', instructions: 'x' } });
    expect(bare.data.smoke).toMatchObject({ state: 'untested' });
  });

  it('update_agent changes the draft only; test_agent smoke-tests it', async () => {
    const { call } = await connect(TEST_OWNER);
    const id = (await call('create_agent', { config: { ...CONFIG, name: 'Update me' } })).data.id as string;
    await call('publish_agent', { id });
    const updated = await call('update_agent', { id, config: { description: 'Changed in the draft' } });
    expect(updated.data).toMatchObject({ id, published: 1, draftDiffers: true });
    const agent = agentStore.get(id)!;
    expect(agent.description).toBe('Changed in the draft');
    expect(agent.published?.config.description).toBe('Reads an alert and says what to do');
    expect((await call('test_agent', { id, message: 'disk full' })).data.smoke).toMatchObject({ state: 'passed', reply: 'I triage alerts.' });
  });

  it('update_agent refuses a NEW credential the agent’s project may not use, and leaves one the draft already holds', async () => {
    const { call } = await connect(TEST_OWNER);
    const pg = { host: '127.0.0.1', port: 5432, database: 'd', user: 'u', password: 'p', ssl: 'disable' };
    const mine = credentials.create({ name: 'Scope mine', type: 'core.postgres', data: pg });
    const other = credentials.create({ name: 'Scope other', type: 'core.postgres', data: pg });
    const other2 = credentials.create({ name: 'Scope other 2', type: 'core.postgres', data: pg });
    const id = (await call('create_agent', { config: { ...CONFIG, name: 'Scoped' } })).data.id as string;
    setHomeProject('agent', id, 'prj_scope_a');
    setHomeProject('credential', mine.id, 'prj_scope_a');
    setHomeProject('credential', other.id, 'prj_scope_b');
    setHomeProject('credential', other2.id, 'prj_scope_b');
    const withTool = (credential: string, name = 'Scoped') => ({ name, tools: [{ id: 't1', type: 'node', nodeType: 'core.postgres', credentials: { postgres: { id: credential, name: 'x' } } }] });
    expect((await call('update_agent', { id, config: withTool(mine.id) })).data).toMatchObject({ id });
    const refused = await call('update_agent', { id, config: withTool(other.id) });
    expect(refused.failed).toBe(true);
    // A legacy pick (already in the stored draft) stays: the agent can still be edited.
    agentStore.saveDraft(id, withTool(other.id) as never);
    expect((await call('update_agent', { id, config: withTool(other.id, 'Renamed') })).failed).toBe(false);
    expect(agentStore.get(id)!.name).toBe('Renamed');
    expect((await call('update_agent', { id, config: withTool(other2.id, 'Renamed') })).failed).toBe(true);
  });

  it('create_agent refuses a credential outside the project the agent is created in', async () => {
    const { call } = await connect(TEST_OWNER);
    const elsewhere = credentials.create({ name: 'Elsewhere', type: 'core.postgres', data: { host: '127.0.0.1', port: 5432, database: 'd', user: 'u', password: 'p', ssl: 'disable' } });
    setHomeProject('credential', elsewhere.id, 'prj_create_elsewhere');
    const config = { ...CONFIG, name: 'Born scoped', tools: [{ id: 't1', type: 'node', nodeType: 'core.postgres', credentials: { postgres: { id: elsewhere.id, name: 'x' } } }] };
    const refused = await call('create_agent', { config });
    expect(refused.failed).toBe(true);
    expect(refused.raw).toMatch(/can’t use/);
  });

  it('create_agent with no actor (a single-user host) accepts a credential of the default project and refuses one homed elsewhere', async () => {
    const { call } = await connect(undefined);
    const pg = { host: '127.0.0.1', port: 5432, database: 'd', user: 'u', password: 'p', ssl: 'disable' };
    const mine = credentials.create({ name: 'Default project cred', type: 'core.postgres', data: pg });
    const other = credentials.create({ name: 'Other project cred', type: 'core.postgres', data: pg });
    setHomeProject('credential', other.id, 'prj_noactor_elsewhere');
    const tool = (credential: string) => ({ id: 't1', type: 'node', nodeType: 'core.postgres', credentials: { postgres: { id: credential, name: 'x' } } });
    expect((await call('create_agent', { config: { ...CONFIG, name: 'No actor ok', tools: [tool(mine.id)] } })).failed).toBe(false);
    expect((await call('create_agent', { config: { ...CONFIG, name: 'No actor refused', tools: [tool(other.id)] } })).failed).toBe(true);
  });

  it('publish_agent runs the eval gate: a pass publishes, a hold answers the verdict and publishes nothing; there is no skipEval', async () => {
    const { client, call } = await connect(TEST_OWNER);
    const id = (await call('create_agent', { config: { ...CONFIG, name: 'Gated' } })).data.id as string;
    addCase(id, { input: 'Disk full on web-01', expected: 'Points at the runbook' });
    side.score = 1;
    const judgedBefore = side.judged;
    // An extra skipEval is ignored: the gate still ran, and held.
    const held = await call('publish_agent', { id, skipEval: true });
    expect(held.data).toMatchObject({ id, published: false, held: true, verdict: { ok: false } });
    expect(side.judged).toBeGreaterThan(judgedBefore);
    expect(agentStore.get(id)!.published).toBeUndefined();
    side.score = 5;
    const passed = await call('publish_agent', { id });
    expect(passed.data).toMatchObject({ id, published: 1, verdict: { ok: true } });
    expect(agentStore.get(id)!.published?.version).toBe(1);
    const schema = (await client.listTools()).tools.find((t) => t.name === 'publish_agent')!.inputSchema as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {})).toEqual(['id']);
  });

  it('a caller who cannot update the agent gets "not found", for every write', async () => {
    const owner = await connect(TEST_OWNER);
    const id = (await owner.call('create_agent', { config: { ...CONFIG, name: 'Not yours' } })).data.id as string;
    const other = await connect({ id: 'usr_other_ag18', role: 'member' });
    for (const [name, args] of [['update_agent', { id, config: { description: 'x' } }], ['test_agent', { id, message: 'hi' }], ['publish_agent', { id }]] as const) {
      const refused = await other.call(name, args);
      expect(refused.failed).toBe(true);
      expect(refused.raw).toBe(`Agent ${id} not found`);
    }
    expect(agentStore.get(id)!.description).toBe('Reads an alert and says what to do');
    expect((await other.call('get_agent', { id })).raw).toContain('not found');
  });
});

describe('a project-scoped server (AG18)', () => {
  it('lists and changes only that project’s agents and credentials, for a user and for the instance token', async () => {
    const owner = await connect(TEST_OWNER);
    const inside = (await owner.call('create_agent', { config: { ...CONFIG, name: 'Scoped inside' } })).data.id as string;
    const outside = (await owner.call('create_agent', { config: { ...CONFIG, name: 'Scoped outside' } })).data.id as string;
    setHomeProject('agent', inside, 'prj_ag18_in');
    setHomeProject('agent', outside, 'prj_ag18_out');
    const here = credentials.create({ name: 'Inside cred', type: 'core.postgres', data: { host: '127.0.0.1', port: 5432, database: 'd', user: 'u', password: 'p', ssl: 'disable' } });
    const there = credentials.create({ name: 'Outside cred', type: 'core.postgres', data: { host: '127.0.0.1', port: 5432, database: 'd', user: 'u', password: 'p', ssl: 'disable' } });
    setHomeProject('credential', here.id, 'prj_ag18_in');
    setHomeProject('credential', there.id, 'prj_ag18_out');
    for (const actor of [TEST_OWNER, undefined]) {
      const scoped = await connect(actor, undefined, { projectId: 'prj_ag18_in' });
      const names = ((await scoped.call('list_agents')).data as Array<{ name: string }>).map((a) => a.name);
      expect(names).toContain('Scoped inside');
      expect(names).not.toContain('Scoped outside');
      expect((await scoped.call('get_agent', { id: outside })).failed).toBe(true);
      const creds = ((await scoped.call('list_credentials')).data as Array<{ name: string }>).map((c) => c.name);
      expect(creds).toContain('Inside cred');
      expect(creds).not.toContain('Outside cred');
      for (const [name, args] of [['update_agent', { id: outside, config: { description: 'x' } }], ['test_agent', { id: outside, message: 'hi' }], ['publish_agent', { id: outside }]] as const) {
        const refused = await scoped.call(name, args);
        expect(refused.failed).toBe(true);
        expect(refused.raw).toBe(`Agent ${outside} not found`);
      }
      expect((await scoped.call('update_agent', { id: inside, config: { description: 'ok' } })).failed).toBe(false);
    }
    expect(agentStore.get(outside)!.description).toBe('Reads an alert and says what to do');
  });
});
