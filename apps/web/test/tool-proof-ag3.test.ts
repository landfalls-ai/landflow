/**
 * AG14 (wave ag3): every tool call says what it reached. The credential's name, its type and where it points (never a
 * secret), on the timeline entry, the journal span and the Run an Agent node's tool chunk; a knowledge search names its
 * collection, store and how it searched, and its passages carry their source. Scripted model, a local SMTP server and made-up
 * plugins; nothing leaves this machine.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, LanguageModel, ModelTurn, ToolSpec } from '@landflow/engine';
import { defineNode, definePlugin, type IExecuteContext, type INodeType, type NodeDescriptor } from '@landflow/sdk';
import { MemoryVectorStore } from '@/lib/server/rag/stores';
import { passagesOf, targetLine, safeEndpoint } from '@/lib/shared/tool-target';

vi.setConfig({ testTimeout: 30_000 });
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-tool-proof-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const SMTP_SECRET = 'pw-AG14-secret-xyz';
const GRAFANA_TOKEN = 'glsa_AG14_token_xyz';
const SECRETS = [SMTP_SECRET, GRAFANA_TOKEN, 'admin:pw'];

type Step = (input: { system?: string; messages: AgentMessage[]; tools: ToolSpec[] }) => Partial<ModelTurn>;
const script: Step[] = [];
vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:11434',
  modelOptions: async () => [],
  agentModel: (config: { model?: string } | undefined): LanguageModel => ({
    provider: 'scripted',
    model: config?.model ?? 'scripted-1',
    async generate(input) {
      const step = script.shift();
      if (!step) throw new Error('The script ran out of turns');
      return { text: '', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 }, ...step(input) };
    },
  }),
}));

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { credentials } = await import('@/lib/server/credentials/vault');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession, runAgent } = await import('@/lib/server/agents/runtime');
const { buildToolset, targetOfCall } = await import('@/lib/server/agents/tools');
const { targetOfNode, targetOfKnowledge } = await import('@/lib/server/agents/tool-target');
const { journalOf, journalStore, releaseJournal } = await import('@/lib/server/journal');
const { streamer } = await import('@/lib/server/nodes/agents');
const { plugin: messaging } = await import('../../../plugins/messaging/src/main');
const { plugin: grafana } = await import('../../../plugins/grafana/src/main');
const { startFakeSmtp } = await import('../../../plugins/messaging/test/fake-smtp');

/** A stand-in for the SQLite plugin (it is Go) and a made-up credential type whose secret field is named `url`. */
class Query implements INodeType {
  readonly description: NodeDescriptor = {
    name: 'query',
    displayName: 'Query',
    description: 'Runs a query',
    version: 1,
    kind: 'action',
    credentials: [{ name: 'sqlite', required: true }],
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    usableAsTool: true,
    properties: [],
  };
  async execute(ctx: IExecuteContext) {
    return [ctx.getInputData().map(() => ({ json: { rows: 1 } }))];
  }
}
const standIn = definePlugin({
  info: { id: 'standin', name: 'Stand-in', version: '0.0.1' },
  credentialTypes: [
    { name: 'sqlite', displayName: 'SQLite', properties: [{ name: 'path', displayName: 'Database File', type: 'string', required: true }] },
    { name: 'weird', displayName: 'Weird', properties: [{ name: 'url', displayName: 'URL', type: 'string', required: true, typeOptions: { password: true } }] },
  ],
  nodes: [new Query()],
});

let smtp: Awaited<ReturnType<typeof startFakeSmtp>>;
const made: string[] = [];
const credential = (name: string, type: string, data: Record<string, unknown>) => {
  const c = credentials.create({ name, type, data: data as never });
  made.push(c.id);
  return c;
};

beforeAll(async () => {
  registry.registerBuiltin(corePlugin);
  registry.registerBuiltin(messaging);
  registry.registerBuiltin(grafana);
  registry.registerBuiltin(standIn);
  smtp = await startFakeSmtp({ auth: { user: 'mail', password: SMTP_SECRET }, authMethods: ['PLAIN'] });
});
afterAll(async () => {
  for (const id of made) credentials.delete(id);
  await smtp.close();
});

const node = (id: string, name: string, nodeType: string, creds: Record<string, { id: string; name: string }> | undefined, parameters: Record<string, unknown> = {}) =>
  ({ id, type: 'node', name, description: '', nodeType, parameters, ...(creds && { credentials: creds }) }) as never;

describe('what a plugin tool reached', () => {
  it('a Send Email tool names the credential, its type and where it points', () => {
    const c = credential('Mailpit SMTP', 'messaging.smtp', { host: '127.0.0.1', port: smtp.port, secure: false, user: 'mail', password: SMTP_SECRET });
    const t = targetOfNode('messaging.emailSend', { smtp: { id: c.id, name: c.name } }, {});
    expect(t).toEqual({ name: 'Mailpit SMTP', system: 'SMTP', endpoint: `127.0.0.1:${smtp.port}`, credentialId: c.id });
    expect(targetLine(t)).toBe(`Mailpit SMTP · SMTP 127.0.0.1:${smtp.port}`);
  });

  it('a Grafana credential gives host and port only: no user, password, path or query', () => {
    const c = credential('Local Grafana', 'grafana.grafana_alertmanager_api_token', { url: 'http://admin:pw@127.0.0.1:53183/api/alertmanager/grafana?x=1', token: GRAFANA_TOKEN });
    const t = targetOfNode('grafana.getAlerts', { grafana_alertmanager_api_token: { id: c.id, name: c.name } }, {});
    expect(t.endpoint).toBe('127.0.0.1:53183');
    expect(JSON.stringify(t)).not.toMatch(/admin|pw|glsa|api\/alertmanager|x=1/);
  });

  it('a SQLite file gives its last part; a node with no credential gives the plugin; an HTTP Request gives the host', () => {
    const c = credential('Sales DB', 'standin.sqlite', { path: '/tmp/x/sales.db' });
    expect(targetOfNode('standin.query', { sqlite: { id: c.id, name: c.name } }, {})).toMatchObject({ name: 'Sales DB', system: 'SQLite', endpoint: 'sales.db' });
    expect(targetOfNode('messaging.emailSend', undefined, {})).toMatchObject({ name: 'messaging plugin', plugin: { id: 'messaging' } });
    expect(targetOfNode('core.httpRequest', undefined, { url: 'https://user:tok@api.example.test:8443/v1/x?key=abc' })).toMatchObject({ endpoint: 'api.example.test:8443' });
  });

  it('an HTTP Request whose URL the model gives is read per call, from the call, as a host only', async () => {
    const agent = agentStore.create({ name: 'Fetcher', instructions: '', model: { provider: 'ollama', model: 'scripted-1' }, tools: [node('h1', 'fetch', 'core.httpRequest', undefined, { url: '{{ $fromAI("url") }}' })] });
    const { tools } = await buildToolset(agent, agent);
    const fetch = tools.find((t) => t.name === 'fetch')!;
    expect(targetOfCall(fetch, { url: 'https://user:tok@api.example.test:8443/v1/x?key=abc' })?.endpoint).toBe('api.example.test:8443');
  });

  it('a credential type whose secret field is named url gives no endpoint', () => {
    const c = credential('Weird', 'standin.weird', { url: 'http://secret-host.test:1234/token' });
    const t = targetOfNode('standin.query', { weird: { id: c.id, name: c.name } }, {});
    expect(t.endpoint).toBeUndefined();
    expect(JSON.stringify(t)).not.toContain('secret-host');
  });

  it('the Grafana plugin marks the token as a password', () => {
    const type = registry.credentialType('grafana.grafana_alertmanager_api_token')!;
    expect(type.descriptor.properties.find((p) => p.name === 'token')?.typeOptions?.password).toBe(true);
    expect(credentials.secretFieldsOf('grafana.grafana_alertmanager_api_token')).toContain('token');
    expect(readFileSync(join(__dirname, '../../../plugins/grafana/src/main.ts'), 'utf8')).toMatch(/name: 'token'[\s\S]*?typeOptions: \{ password: true \}/);
  });
});

describe('workflows, agents, MCP and A2A', () => {
  it('each names what it asks', () => {
    expect(targetOfKnowledge({ collection: 'runbooks', store: 'sqlite', embeddings: { provider: 'ollama', model: 'nomic-embed-text' } }, 4)).toMatchObject({ knowledge: { collection: 'runbooks', store: 'SQLite', embeddings: 'ollama/nomic-embed-text', documents: 4 } });
    expect(safeEndpoint('https://mcp.example.test:9000/mcp?token=abc')).toBe('mcp.example.test:9000');
  });
});

describe('a knowledge search', () => {
  it('a keyword base and an Ollama base say how they searched; passages take metadata.source, else fileName', async () => {
    const keyword = targetOfKnowledge({ collection: 'runbooks', store: 'memory', embeddings: { provider: 'none' } as never });
    expect(keyword.knowledge?.embeddings).toBe('keyword search (BM25, built in)');
    expect(targetLine(keyword)).toContain('keyword search (BM25, built in)');
    const out = { results: [{ pageContent: 'a', metadata: { source: 'runbooks/disk-full.md', fileName: 'x.md', page: 2 }, score: 0.8123 }, { pageContent: 'b', metadata: { fileName: 'up.pdf' } }, { pageContent: 'c', metadata: {} }] };
    expect(passagesOf(out).map((p) => [p.source, p.page, p.score])).toEqual([['runbooks/disk-full.md', 2, 0.8123], ['up.pdf', undefined, undefined], [undefined, undefined, undefined]]);
    const store = new MemoryVectorStore();
    await store.clear('proof_runbooks');
    await store.add('proof_runbooks', [{ pageContent: 'Disk full: rotate the logs.', metadata: { source: 'runbooks/disk-full.md' }, embedding: [1, 0, 0, 0] }]);
    const agent = agentStore.create({
      name: 'Ops',
      instructions: '',
      model: { provider: 'ollama', model: 'scripted-1' },
      tools: [{ id: 'k1', type: 'knowledge', name: 'search_runbooks', description: 'Runbooks', store: 'memory', collection: 'proof_runbooks', embeddings: { provider: 'ollama', model: 'nomic-embed-text', baseUrl: 'http://127.0.0.1:9' } } as never],
    });
    const { tools } = await buildToolset(agent, agent);
    expect(tools.find((t) => t.name === 'search_runbooks')?.target?.knowledge).toEqual({ collection: 'proof_runbooks', store: 'In-memory', embeddings: 'ollama/nomic-embed-text' });
  });
});

describe('a run: the timeline, the journal and the stream carry the target and no secret', () => {
  it('sends an email through the Mailpit credential', async () => {
    const c = credential('Mailpit SMTP', 'messaging.smtp', { host: '127.0.0.1', port: smtp.port, secure: false, user: 'mail', password: SMTP_SECRET });
    const g = credential('Local Grafana', 'grafana.grafana_alertmanager_api_token', { url: 'http://admin:pw@127.0.0.1:53183/api/alertmanager/grafana?x=1', token: GRAFANA_TOKEN });
    const agent = agentStore.create({
      name: 'Mailer',
      instructions: 'Send the email.',
      model: { provider: 'ollama', model: 'scripted-1' },
      tools: [
        node('t1', 'send_email', 'messaging.emailSend', { smtp: { id: c.id, name: c.name } }, { fromEmail: 'agent@landflow.test', toEmail: 'oncall@landflow.test', subject: 'Disk', text: 'Disk is full' }),
        node('t2', 'get_alerts', 'grafana.getAlerts', { grafana_alertmanager_api_token: { id: g.id, name: g.name } }),
      ],
    });
    const executionId = 'ex_proof_ag14';
    const journal = journalOf(executionId, { workflowId: 'wf_proof' });
    journal.bindSpans((nodeId) => (nodeId === 'agentnode' ? 'node:agentnode:0' : undefined));
    const session = newSession(agent, { source: 'test', userId: 'you', version: 'draft' });
    session.execution = { workflowId: 'wf_proof', executionId, nodeId: 'agentnode' };
    script.push(() => ({ toolCalls: [{ id: 'c1', name: 'send_email', input: {} }] }));
    script.push(() => ({ text: 'Sent.' }));
    const chunks: unknown[] = [];
    const stream = streamer((chunk) => chunks.push(chunk), 0);
    const result = await runAgent({ agent, session, message: 'Email oncall', onEvent: stream });
    releaseJournal(executionId);

    const entry = session.timeline.find((e) => e.type === 'tool');
    const expected = { name: 'Mailpit SMTP', system: 'SMTP', endpoint: `127.0.0.1:${smtp.port}`, credentialId: c.id };
    expect(entry).toMatchObject({ status: 'success', target: expected });
    expect(smtp.mails).toHaveLength(1);
    const span = journalStore.read(executionId).find((e) => e.type === 'span.started' && e.spanId.endsWith('step:c1'));
    expect(span).toMatchObject({ attrs: { tool: 'send_email', target: expected } });
    expect(chunks.filter((c) => (c as { type: string }).type === 'tool')).toEqual(expect.arrayContaining([expect.objectContaining({ tool: expect.objectContaining({ status: 'finished', target: expected }) })]));

    const everything = JSON.stringify([session.timeline, journalStore.read(executionId), chunks, result, session.messages]);
    for (const secret of SECRETS) expect(everything).not.toContain(secret);
  });
});
