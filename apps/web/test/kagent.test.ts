/**
 * Landflow agents on kagent (docs/a2a.md, "Landflow agents on kagent"; lib/server/kagent): the persona kagent gets is the
 * one the runtime gives the model, deploying writes it with server-side apply to a fake Kubernetes API, publishing writes
 * the new version, an edit made in kagent shows as drift, removing deletes only what Landflow wrote, and the agent's MCP
 * endpoint serves its tools to the token in kagent's Secret and nobody else.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig, KagentHarness, KagentPlugin, KagentStatus } from '@/lib/shared/agents';
import type { KubeObject } from '@/lib/server/kagent/kube';

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { agentStore } = await import('@/lib/server/agents/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { personaPrompt } = await import('@/lib/shared/persona');
const { kagentManifests, kagentName, toolBindings } = await import('@/lib/server/kagent/manifests');
const kagentRoute = await import('@/app/api/agents/[id]/kagent/route');
const publishRoute = await import('@/app/api/agents/[id]/publish/route');
const agentRoute = await import('@/app/api/agents/[id]/route');
const mcpRoute = await import('@/app/api/mcp/agents/[id]/route');
const { marketplace } = await import('@/lib/server/marketplace/service');

/** A Kubernetes API that keeps objects in memory: server-side apply (merged per field), get, list and delete. */
interface FakeKube {
  url: string;
  objects: Map<string, KubeObject>;
  requests: Array<{ method: string; path: string; contentType?: string; authorization?: string }>;
  /** Out of reach: every request fails with 503. */
  down: boolean;
  close(): Promise<void>;
}

async function startFakeKube(): Promise<FakeKube> {
  const objects = new Map<string, KubeObject>();
  const requests: FakeKube['requests'] = [];
  const state: FakeKube = { url: '', objects, requests, down: false, close: () => new Promise((resolve) => server.close(() => resolve())) };
  const body = (req: IncomingMessage) => new Promise<string>((resolve) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => resolve(text));
  });
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://kube');
    requests.push({ method: req.method!, path: url.pathname + url.search, contentType: req.headers['content-type'], authorization: req.headers.authorization });
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (state.down) return send(503, { message: 'unavailable' });
    if (req.headers.authorization !== 'Bearer kube-token') return send(401, { message: 'Unauthorized' });
    // /api/v1/namespaces/<ns>/<plural>[/<name>] or /apis/<group>/<version>/namespaces/<ns>/<plural>[/<name>]
    const match = /^\/apis?\/(?:[^/]+\/)?[^/]+\/namespaces\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) return send(404, { message: 'not found' });
    const [, namespace, plural, name] = match;
    const key = `${plural}/${namespace}/${name}`;
    if (req.method === 'PATCH') {
      expect(req.headers['content-type']).toBe('application/apply-patch+yaml');
      expect(url.searchParams.get('fieldManager')).toBe('landflow');
      const applied = JSON.parse(await body(req)) as KubeObject;
      const previous = objects.get(key);
      const merged = { ...previous, ...applied, metadata: { ...previous?.metadata, ...applied.metadata, generation: ((previous?.metadata.generation as number) ?? 0) + 1 } } as KubeObject;
      objects.set(key, merged);
      return send(200, merged);
    }
    if (req.method === 'DELETE') {
      if (!objects.delete(key)) return send(404, { message: `${key} not found` });
      return send(200, { status: 'Success' });
    }
    if (!name) return send(200, { items: [...objects.entries()].filter(([k]) => k.startsWith(`${plural}/${namespace}/`)).map(([, v]) => v) });
    const found = objects.get(key);
    return found ? send(200, found) : send(404, { message: `${key} not found` });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}

let kube: FakeKube;
let cluster: { id: string; name: string };
const clusterData = () => ({ server: kube.url, token: 'kube-token', namespace: 'kagent', harness: 'landflow-kagent', controllerUrl: 'http://kagent.test:8083', landflowUrl: 'http://landflow.test:3000' });

beforeAll(async () => {
  registry.registerBuiltin(corePlugin);
  kube = await startFakeKube();
  cluster = credentials.create({
    name: 'kind kagent',
    type: 'core.kagentApi',
    data: clusterData(),
  });
});
afterAll(() => kube.close());
/** The cluster's Harnesses: the credential's (kagent's own runtime), one running Claude Code, and one Landflow can't write to. */
const HARNESSES: Array<[string, Record<string, unknown>]> = [
  ['landflow-kagent', { kagent: {} }],
  ['landflow-claude', { claude: {}, env: [{ name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: 'qwen3-coder:30b' }] }],
  ['codex', { codex: {} }],
];
beforeEach(() => {
  kube.objects.clear();
  for (const [name, spec] of HARNESSES) kube.objects.set(`harnesses/kagent/${name}`, { apiVersion: 'api.kagent.dev/v1alpha3', kind: 'Harness', metadata: { name, namespace: 'kagent' }, spec });
  kube.requests.length = 0;
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
const call = async <T,>(handler: unknown, id: string, method = 'GET', body?: unknown): Promise<{ status: number; data: T }> => {
  const response = await (handler as Handler)(new Request(`http://localhost/api/agents/${id}/kagent`, { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), ctx(id));
  return { status: response.status, data: (await response.json()) as T };
};

const CONFIG: Partial<AgentConfig> = {
  name: 'Text formatter',
  description: 'Turns text into URL slugs and changes its case',
  model: { provider: 'ollama', model: 'qwen3-coder:30b', baseUrl: 'http://host.docker.internal:11434', temperature: 0.2 },
  instructions: 'You format text with your tools. Always call a tool instead of formatting the text yourself.',
  skills: [{ id: 's1', name: 'Headlines', whenToUse: 'Use when asked for a headline slug', instructions: 'Slugify the headline, then answer with it.' }],
  tools: [
    { id: 't1', type: 'node', name: 'Echo', description: 'Echo the input', nodeType: 'core.noOp', parameters: {} },
    { id: 't2', type: 'node', name: 'Shout', description: 'Echo it loudly', nodeType: 'core.noOp', parameters: {}, requireApproval: true },
  ],
  memory: { crossSession: true },
};

function publishedAgent(config: Partial<AgentConfig> = CONFIG) {
  const agent = agentStore.create(config);
  return agentStore.publish(agent.id)!;
}

const held = (kind: string, name: string) => kube.objects.get(`${kind}/kagent/${name}`);
/** What kagent holds besides its Harnesses. */
const written = () => [...kube.objects.keys()].filter((key) => !key.startsWith('harnesses/'));

describe('the persona kagent gets', () => {
  it('is the runtime’s system prompt without the run’s time and memory notes', () => {
    const config = agentStore.create(CONFIG);
    const prompt = personaPrompt(config);
    expect(prompt.startsWith(CONFIG.instructions!)).toBe(true);
    expect(prompt).toContain('## Skills');
    expect(prompt).toContain('- Headlines: Use when asked for a headline slug');
    expect(prompt.endsWith('You are “Text formatter”: Turns text into URL slugs and changes its case.')).toBe(true);
    const run = personaPrompt(config, { memory: '## What you remember about this user\n(nothing yet)', now: new Date('2026-10-30T12:00:00Z') });
    expect(run).toBe(
      [CONFIG.instructions, prompt.split('\n\n')[1], '## What you remember about this user\n(nothing yet)', 'You are “Text formatter”: Turns text into URL slugs and changes its case. Current date and time: 2026-10-30T12:00:00.000Z.'].join('\n\n'),
    );
  });

  it('compiles to an AgentTemplate, Agent, ModelConfig, RemoteMCPServer and Secret', () => {
    const agent = agentStore.create(CONFIG);
    const objects = kagentManifests({
      agentId: agent.id,
      config: agent,
      version: 3,
      name: 'text-formatter',
      cluster: { namespace: 'kagent', harness: 'landflow-kagent', landflowUrl: 'http://landflow.test:3000' },
      tools: [
        { name: 'Echo', requireApproval: false },
        { name: 'Shout', requireApproval: true },
      ],
      model: { ollamaHost: 'http://host.docker.internal:11434' },
      token: 'lfk_secret',
      tokenHash: 'abc',
    });
    expect(objects.map((o) => o.kind)).toEqual(['Secret', 'RemoteMCPServer', 'ModelConfig', 'AgentTemplate', 'Agent']);
    const template = objects.find((o) => o.kind === 'AgentTemplate')!;
    expect(template.spec).toEqual({
      description: CONFIG.description,
      modelConfig: { name: 'text-formatter' },
      systemPrompt: personaPrompt(agent),
      tools: toolBindings('text-formatter', [
        { name: 'Echo', requireApproval: false },
        { name: 'Shout', requireApproval: true },
      ]),
    });
    expect((template.spec as { tools: unknown[] }).tools).toEqual([
      { mcp: { server: { kind: 'RemoteMCPServer', name: 'text-formatter' }, tools: ['Echo'] } },
      { mcp: { server: { kind: 'RemoteMCPServer', name: 'text-formatter' }, tools: ['Shout'], requireApproval: true } },
    ]);
    expect(objects.find((o) => o.kind === 'ModelConfig')!.spec).toEqual({ provider: 'Ollama', model: 'qwen3-coder:30b', ollama: { host: 'http://host.docker.internal:11434', options: { temperature: '0.2' } } });
    expect((objects.find((o) => o.kind === 'RemoteMCPServer')!.spec as { url: string }).url).toBe(`http://landflow.test:3000/api/mcp/agents/${agent.id}`);
    expect(objects.find((o) => o.kind === 'Secret')!.stringData).toEqual({ authorization: 'Bearer lfk_secret' });
    expect(objects.every((o) => o.metadata.labels?.['landflow.dev/agent-id'] === agent.id && o.metadata.annotations?.['landflow.dev/agent-version'] === '3')).toBe(true);
    expect(kagentName('Text formatter')).toBe('text-formatter');
    expect(kagentName('  Ünïcode / Agent!! ')).toBe('unicode-agent');
  });
});

describe('deploying to kagent', () => {
  it('needs a published agent and a kagent credential', async () => {
    const draft = agentStore.create(CONFIG);
    expect((await call<{ error: string }>(kagentRoute.PUT, draft.id, 'PUT', { credentialId: cluster.id })).data.error).toMatch(/Publish the agent first/);
    const agent = publishedAgent();
    expect((await call<{ error: string }>(kagentRoute.PUT, agent.id, 'PUT', {})).data.error).toMatch(/kagent cluster credential/);
    const other = credentials.create({ name: 'a bearer', type: 'core.httpBearerAuth', data: { token: 'x' } });
    expect((await call<{ error: string }>(kagentRoute.PUT, agent.id, 'PUT', { credentialId: other.id })).data.error).toMatch(/not a kagent cluster/);
    expect((await call<{ error: string }>(kagentRoute.PUT, agent.id, 'PUT', { credentialId: cluster.id, name: 'Not_A_Name' })).data.error).toMatch(/can’t be a kagent name/);
  });

  it('writes the persona, model and tools with server-side apply, and reads them back in sync', async () => {
    const agent = publishedAgent();
    const { status, data } = await call<{ status: KagentStatus; unavailable: string[] }>(kagentRoute.PUT, agent.id, 'PUT', { credentialId: cluster.id });
    expect(status).toBe(200);
    expect(data.status).toMatchObject({ deployed: true, name: 'text-formatter', namespace: 'kagent', version: 1, inSync: true, drift: [], outdated: false, a2aUrl: 'http://kagent.test:8083/agents/kagent/text-formatter' });
    expect(data.status.systemPrompt).toBe(personaPrompt(agent.published!.config));
    expect(kube.requests.filter((r) => r.method === 'PATCH').map((r) => r.path.split('?')[0].split('/').slice(-2).join('/'))).toEqual([
      'secrets/text-formatter-landflow',
      'remotemcpservers/text-formatter',
      'modelconfigs/text-formatter',
      'agenttemplates/text-formatter',
      'agents/text-formatter',
    ]);
    // Memory needs the person the agent talks to, so kagent gets every tool but `remember`.
    const tools = (held('agenttemplates', 'text-formatter')!.spec as { tools: Array<{ mcp: { tools: string[]; requireApproval?: boolean } }> }).tools;
    expect(tools.map((t) => [t.mcp.tools, Boolean(t.mcp.requireApproval)])).toEqual([
      [['Echo', 'load_skill'], false],
      [['Shout'], true],
    ]);
    expect(held('agents', 'text-formatter')!.spec).toEqual({ template: { ref: { name: 'text-formatter' } }, harnessRef: { name: 'landflow-kagent' } });
    // The token is sealed in Landflow and in clear only in kagent's Secret.
    const saved = agentStore.get(agent.id)!;
    expect(saved.kagent).toMatchObject({ credential: { id: cluster.id }, name: 'text-formatter', version: 1 });
    expect(saved.kagent!.token).toMatch(/^v1\./);
    const token = credentials.openSecret(saved.kagent!.token!);
    expect(held('secrets', 'text-formatter-landflow')!.stringData).toEqual({ authorization: `Bearer ${token}` });
    // Deploying again keeps the token.
    await call(kagentRoute.PUT, agent.id, 'PUT', {});
    expect(credentials.openSecret(agentStore.get(agent.id)!.kagent!.token!)).toBe(token);
  });

  it('writes every new published version, and flags a version kagent didn’t get', async () => {
    const agent = publishedAgent();
    await call(kagentRoute.PUT, agent.id, 'PUT', { credentialId: cluster.id, name: 'formatter' });
    agentStore.saveDraft(agent.id, { instructions: 'You format text. Answer in one word.' });
    const published = await call<{ agent: { published: { version: number } }; kagent: KagentStatus }>(publishRoute.POST, agent.id, 'POST');
    expect(published.data.agent.published.version).toBe(2);
    expect(published.data.kagent).toMatchObject({ inSync: true, version: 2 });
    expect((held('agenttemplates', 'formatter')!.spec as { systemPrompt: string }).systemPrompt.startsWith('You format text. Answer in one word.')).toBe(true);
    expect(held('agenttemplates', 'formatter')!.metadata.annotations?.['landflow.dev/agent-version']).toBe('2');

    // A publish that can't reach kagent is still a publish; the status says kagent has the older version.
    const server = kube.url;
    credentials.update(cluster.id, { data: { server: 'http://127.0.0.1:9' } });
    agentStore.saveDraft(agent.id, { instructions: 'You format text. Answer in two words.' });
    const unreachable = await call<{ agent: { published: { version: number } }; kagent: { error: string } }>(publishRoute.POST, agent.id, 'POST');
    expect(unreachable.data.agent.published.version).toBe(3);
    expect(unreachable.data.kagent.error).toMatch(/can’t be reached/);
    credentials.update(cluster.id, { data: { server } });
    const status = (await call<{ status: KagentStatus }>(kagentRoute.GET, agent.id)).data.status;
    expect(status).toMatchObject({ version: 2, outdated: true, inSync: false, drift: [] });
  });

  it('gets the persona built on the Persona tab, compiled the way the runtime compiles it', async () => {
    const agent = publishedAgent();
    await call(kagentRoute.PUT, agent.id, 'PUT', { credentialId: cluster.id });
    agentStore.saveDraft(agent.id, { persona: { role: 'Formatter for the content team', tones: ['Brief'], never: ['Format text without a tool'] } });
    const published = await call<{ agent: { published: { config: AgentConfig } }; kagent: KagentStatus }>(publishRoute.POST, agent.id, 'POST');
    expect(published.data.kagent).toMatchObject({ inSync: true, version: 2 });
    const systemPrompt = (held('agenttemplates', 'text-formatter')!.spec as { systemPrompt: string }).systemPrompt;
    expect(systemPrompt).toBe(personaPrompt(published.data.agent.published.config));
    expect(systemPrompt.split('\n\n').slice(0, 4)).toEqual([
      '## Who you are\nRole: Formatter for the content team.',
      '## How you talk\nTone: Brief.',
      '## Rules\nNever:\n- Format text without a tool',
      `## Instructions\n${CONFIG.instructions}`,
    ]);
  });

  it('names what was changed in kagent, and a redeploy writes Landflow’s persona again', async () => {
    const agent = publishedAgent();
    await call(kagentRoute.PUT, agent.id, 'PUT', { credentialId: cluster.id, name: 'drifting' });
    const template = held('agenttemplates', 'drifting')!;
    (template.spec as Record<string, unknown>).systemPrompt = 'You are a pirate.';
    ((template.spec as { tools: Array<{ mcp: { requireApproval?: boolean } }> }).tools[1].mcp as Record<string, unknown>).requireApproval = false;
    kube.objects.delete('modelconfigs/kagent/drifting');
    const status = (await call<{ status: KagentStatus }>(kagentRoute.GET, agent.id)).data.status;
    expect(status.inSync).toBe(false);
    expect(status.drift.map((d) => d.field).sort()).toEqual(['ModelConfig', 'systemPrompt', 'tools']);
    expect(status.drift.find((d) => d.field === 'systemPrompt')).toEqual({ field: 'systemPrompt', landflow: personaPrompt(agent.published!.config), kagent: 'You are a pirate.' });
    expect(status.systemPrompt).toBe('You are a pirate.');
    // kagent's own defaults aren't drift.
    (held('agenttemplates', 'drifting')!.spec as Record<string, unknown>).systemPrompt = personaPrompt(agent.published!.config);
    await call(kagentRoute.PUT, agent.id, 'PUT', {});
    (held('modelconfigs', 'drifting')!.spec as Record<string, unknown>).stream = true;
    expect((await call<{ status: KagentStatus }>(kagentRoute.GET, agent.id)).data.status).toMatchObject({ inSync: true, drift: [] });
  });

  it('won’t take over a kagent agent it didn’t write, and removes only its own', async () => {
    kube.objects.set('agenttemplates/kagent/handmade', { apiVersion: 'api.kagent.dev/v1alpha3', kind: 'AgentTemplate', metadata: { name: 'handmade', namespace: 'kagent' }, spec: { systemPrompt: 'Hand-written' } });
    const agent = publishedAgent();
    const refused = await call<{ error: string }>(kagentRoute.PUT, agent.id, 'PUT', { credentialId: cluster.id, name: 'handmade' });
    expect(refused.status).toBe(409);
    expect(refused.data.error).toMatch(/Landflow didn’t write/);

    await call(kagentRoute.PUT, agent.id, 'PUT', { credentialId: cluster.id, name: 'mine' });
    // Renaming moves it: the old resources go.
    await call(kagentRoute.PUT, agent.id, 'PUT', { name: 'mine-too' });
    expect([...kube.objects.keys()].filter((k) => k.endsWith('/mine') || k.endsWith('/mine-landflow'))).toEqual([]);
    expect(held('agents', 'mine-too')).toBeDefined();

    const removed = await call<{ status: KagentStatus }>(kagentRoute.DELETE, agent.id, 'DELETE');
    expect(removed.data.status.deployed).toBe(false);
    expect(agentStore.get(agent.id)!.kagent).toBeUndefined();
    expect(written()).toEqual(['agenttemplates/kagent/handmade']);
  });

  it('deleting the agent removes it from kagent', async () => {
    const agent = publishedAgent();
    await call(kagentRoute.PUT, agent.id, 'PUT', { credentialId: cluster.id, name: 'short-lived' });
    expect(written()).toHaveLength(5);
    await call(agentRoute.DELETE, agent.id, 'DELETE');
    expect(written()).toEqual([]);
  });

  it('removes what a deleted agent left while kagent was out of reach the next time it deploys there', async () => {
    const gone = publishedAgent();
    await call(kagentRoute.PUT, gone.id, 'PUT', { credentialId: cluster.id, name: 'left-behind' });
    kube.down = true;
    try {
      expect((await call(agentRoute.DELETE, gone.id, 'DELETE')).status).toBe(200);
    } finally {
      kube.down = false;
    }
    expect(held('agents', 'left-behind')).toBeDefined();
    const next = publishedAgent();
    await call(kagentRoute.PUT, next.id, 'PUT', { credentialId: cluster.id, name: 'next-one' });
    expect(written().filter((k) => k.includes('left-behind'))).toEqual([]);
    expect(held('agents', 'next-one')).toBeDefined();
  });

  it('refuses an Ollama server kagent can’t reach', async () => {
    const agent = publishedAgent({ ...CONFIG, model: { provider: 'ollama', model: 'qwen3-coder:30b', baseUrl: 'http://127.0.0.1:11434' } });
    const { status, data } = await call<{ error: string }>(kagentRoute.PUT, agent.id, 'PUT', { credentialId: cluster.id, name: 'loopback' });
    expect(status).toBe(400);
    expect(data.error).toMatch(/kagent’s agents can’t reach/);
  });
});

describe('the agent’s MCP endpoint', () => {
  type Rpc = { result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean }; error?: { message: string } };
  async function rpc(id: string, method: string, params: unknown, token?: string, query = ''): Promise<{ status: number; body: Rpc }> {
    const request = new Request(`http://localhost/api/mcp/agents/${id}${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token && { authorization: `Bearer ${token}` }) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const response = await (mcpRoute.POST as unknown as Handler)(request, ctx(id));
    const raw = await response.text();
    let body: Rpc = {};
    try {
      body = JSON.parse(raw.includes('data:') ? raw.split('\n').find((l) => l.startsWith('data:'))!.slice(5) : raw) as Rpc;
    } catch {}
    return { status: response.status, body };
  }

  it('serves the deployed agent’s tools to kagent’s token only', async () => {
    const agent = publishedAgent();
    expect((await rpc(agent.id, 'tools/list', {})).status).toBe(404);
    await call(kagentRoute.PUT, agent.id, 'PUT', { credentialId: cluster.id, name: 'served' });
    const token = credentials.openSecret(agentStore.get(agent.id)!.kagent!.token!);
    expect((await rpc(agent.id, 'tools/list', {})).status).toBe(401);
    expect((await rpc(agent.id, 'tools/list', {}, 'lfk_wrong')).status).toBe(401);

    const listed = await rpc(agent.id, 'tools/list', {}, token);
    expect(listed.body.result?.tools?.map((t) => t.name)).toEqual(['Echo', 'Shout', 'load_skill']);
    const skill = await rpc(agent.id, 'tools/call', { name: 'load_skill', arguments: { name: 'Headlines' } }, token);
    expect(skill.body.result?.content?.[0].text).toContain('Slugify the headline, then answer with it.');
    // kagent paused on Shout already (its binding has requireApproval), so the call runs.
    const shout = await rpc(agent.id, 'tools/call', { name: 'Shout', arguments: { text: 'hi' } }, token);
    expect(shout.body.result?.isError).toBeFalsy();
    expect(shout.body.result?.content?.[0].text).toContain('hi');
    const unknown = await rpc(agent.id, 'tools/call', { name: 'remember', arguments: { text: 'x' } }, token);
    expect(unknown.body.result?.isError).toBe(true);
  });

  it('serves Claude Code’s two servers each their own tools, so none is called past kagent’s pause', async () => {
    const agent = publishedAgent();
    await call(kagentRoute.PUT, agent.id, 'PUT', { credentialId: cluster.id, name: 'split', harness: 'landflow-claude' });
    const token = credentials.openSecret(agentStore.get(agent.id)!.kagent!.token!);
    const names = async (query: string) => (await rpc(agent.id, 'tools/list', {}, token, query)).body.result?.tools?.map((t) => t.name);
    expect(await names('?tools=free')).toEqual(['Echo', 'load_skill']);
    expect(await names('?tools=approval')).toEqual(['Shout']);
    const past = await rpc(agent.id, 'tools/call', { name: 'Shout', arguments: { text: 'hi' } }, token, '?tools=free');
    expect(past.body.result).toMatchObject({ isError: true, content: [{ text: 'The agent “Text formatter” has no tool Shout' }] });
    const approved = await rpc(agent.id, 'tools/call', { name: 'Shout', arguments: { text: 'hi' } }, token, '?tools=approval');
    expect(approved.body.result?.isError).toBeFalsy();
  });

  it('serves the version kagent runs, not a newer one it didn’t get', async () => {
    const agent = publishedAgent();
    await call(kagentRoute.PUT, agent.id, 'PUT', { credentialId: cluster.id, name: 'pinned' });
    const token = credentials.openSecret(agentStore.get(agent.id)!.kagent!.token!);
    const server = kube.url;
    credentials.update(cluster.id, { data: { server: 'http://127.0.0.1:9' } });
    agentStore.saveDraft(agent.id, { tools: [{ id: 't9', type: 'node', name: 'Whisper', description: 'Quietly', nodeType: 'core.noOp', parameters: {} }], skills: [] });
    await call(publishRoute.POST, agent.id, 'POST');
    credentials.update(cluster.id, { data: { server } });
    expect((await rpc(agent.id, 'tools/list', {}, token)).body.result?.tools?.map((t) => t.name)).toEqual(['Echo', 'Shout', 'load_skill']);
  });
});

describe('on Claude Code', () => {
  const PIN: KagentPlugin = { id: 'mattpocock-skills@claude-plugins-official', url: 'https://github.com/mattpocock/skills.git', commit: '49dd158d1076134a641b33efb035946536778336' };
  const DEV: Partial<AgentConfig> = { ...CONFIG, plugins: [PIN.id] };

  it('lists the cluster’s Harnesses with their runtimes', async () => {
    const agent = publishedAgent();
    const listed = await kagentRoute.GET(new Request(`http://localhost/api/agents/${agent.id}/kagent?credentialId=${cluster.id}`), ctx(agent.id));
    const body = (await listed.json()) as { status: KagentStatus; harnesses: KagentHarness[] };
    expect(body.harnesses).toEqual([
      { name: 'codex', runtime: 'codex' },
      { name: 'landflow-claude', runtime: 'claude' },
      { name: 'landflow-kagent', runtime: 'kagent' },
    ]);
    expect(body.status.deployed).toBe(false);
  });

  it('writes the model as Anthropic’s API on Ollama, a server per approval setting, and the plugins at their commits', async () => {
    const pin = vi.spyOn(marketplace, 'claudePlugin').mockResolvedValue(PIN);
    try {
      const agent = publishedAgent(DEV);
      const deployed = await call<{ status: KagentStatus }>(kagentRoute.PUT, agent.id, 'PUT', { credentialId: cluster.id, name: 'dev', harness: 'landflow-claude' });
      expect(deployed.status).toBe(200);
      expect(pin).toHaveBeenCalledWith(PIN.id);
      // Ollama serves the Messages API; Claude Code needs a key, which Ollama ignores, and kagent takes no temperature.
      expect(held('modelconfigs', 'dev')!.spec).toEqual({ provider: 'Anthropic', model: 'qwen3-coder:30b', apiKeySecret: 'dev-landflow', apiKeySecretKey: 'api-key', anthropic: { baseUrl: 'http://host.docker.internal:11434' } });
      expect((held('secrets', 'dev-landflow') as { stringData: Record<string, string> }).stringData['api-key']).toBe('ollama');
      expect(held('remotemcpservers', 'dev')!.spec).toMatchObject({ url: `http://landflow.test:3000/api/mcp/agents/${agent.id}?tools=free` });
      expect(held('remotemcpservers', 'dev-approval')!.spec).toMatchObject({ url: `http://landflow.test:3000/api/mcp/agents/${agent.id}?tools=approval` });
      const template = held('agenttemplates', 'dev')!.spec as Record<string, unknown>;
      expect(template.tools).toEqual([
        { mcp: { server: { kind: 'RemoteMCPServer', name: 'dev' } } },
        { mcp: { server: { kind: 'RemoteMCPServer', name: 'dev-approval' }, requireApproval: true } },
      ]);
      expect(template.plugins).toEqual([{ source: { git: { url: PIN.url, commit: PIN.commit } } }]);
      expect(held('agents', 'dev')!.spec).toEqual({ template: { ref: { name: 'dev' } }, harnessRef: { name: 'landflow-claude' } });
      expect(deployed.data.status).toMatchObject({ inSync: true, harness: { name: 'landflow-claude', runtime: 'claude' }, plugins: [PIN] });
      expect(agentStore.get(agent.id)!.kagent).toMatchObject({ harness: 'landflow-claude', plugins: [PIN] });

      // The status compares with the pins written, without resolving them again; a plugin changed in kagent is drift.
      pin.mockClear();
      (held('agenttemplates', 'dev')!.spec as Record<string, unknown>).plugins = [];
      const status = await call<{ status: KagentStatus }>(kagentRoute.GET, agent.id);
      expect(pin).not.toHaveBeenCalled();
      expect(status.data.status.drift.map((d) => d.field)).toEqual(['plugins']);

      // Publishing writes it again on the same Harness.
      agentStore.saveDraft(agent.id, { instructions: 'Write the test first.' });
      await call(publishRoute.POST, agent.id, 'POST');
      expect(held('agents', 'dev')!.spec).toMatchObject({ harnessRef: { name: 'landflow-claude' } });
      expect((held('agenttemplates', 'dev')!.spec as Record<string, unknown>).plugins).toHaveLength(1);
    } finally {
      pin.mockRestore();
    }
  });

  it('writes the EgressPolicies the agent may reach: the credential’s, its own list, and drift when kagent’s differs', async () => {
    kube.objects.set('egresspolicies/kagent/packages', { apiVersion: 'api.kagent.dev/v1alpha3', kind: 'EgressPolicy', metadata: { name: 'packages', namespace: 'kagent' }, spec: { destinations: [{ origin: 'https://proxy.golang.org' }, { origin: 'https://registry.npmjs.org' }] } });
    kube.objects.set('egresspolicies/kagent/github', { apiVersion: 'api.kagent.dev/v1alpha3', kind: 'EgressPolicy', metadata: { name: 'github', namespace: 'kagent' }, spec: { destinations: [{ origin: 'https://github.com' }] } });
    credentials.update(cluster.id, { data: { ...clusterData(), egressPolicies: 'packages' } });
    const agent = publishedAgent();
    // The cluster's policies are listed for the picker, with their origins.
    const response = await (kagentRoute.GET as unknown as Handler)(new Request(`http://localhost/api/agents/${agent.id}/kagent?credentialId=${cluster.id}`), ctx(agent.id));
    const listed = (await response.json()) as { egressPolicies: Array<{ name: string; origins: string[] }> };
    expect(listed.egressPolicies).toEqual([
      { name: 'github', origins: ['https://github.com'] },
      { name: 'packages', origins: ['https://proxy.golang.org', 'https://registry.npmjs.org'] },
    ]);

    // Without a list of its own, the agent references the credential's.
    const deployed = await call<{ status: KagentStatus }>(kagentRoute.PUT, agent.id, 'PUT', { credentialId: cluster.id, name: 'net' });
    expect(deployed.status).toBe(200);
    expect(held('agents', 'net')!.spec).toMatchObject({ egressPolicyRefs: [{ name: 'packages' }] });
    expect(deployed.data.status).toMatchObject({ inSync: true, egressPolicies: ['packages'] });

    // Its own list replaces it; one kagent doesn't have is refused before anything is written.
    await call(kagentRoute.PUT, agent.id, 'PUT', { egressPolicies: ['packages', 'github'] });
    expect(held('agents', 'net')!.spec).toMatchObject({ egressPolicyRefs: [{ name: 'packages' }, { name: 'github' }] });
    const missing = await call<{ error: string }>(kagentRoute.PUT, agent.id, 'PUT', { egressPolicies: ['pypi'] });
    expect(missing.status).toBe(400);
    expect(missing.data.error).toContain('no EgressPolicy “pypi”');

    // Changed by hand in kagent: drift.
    (held('agents', 'net')!.spec as Record<string, unknown>).egressPolicyRefs = [];
    const status = await call<{ status: KagentStatus }>(kagentRoute.GET, agent.id);
    expect(status.data.status.drift.map((d) => d.field)).toEqual(['egressPolicies']);
    credentials.update(cluster.id, { data: { ...clusterData(), egressPolicies: '' } });
  });

  it('writes each plugin as the image Landflow packed when the credential names its registry', async () => {
    const pin = vi.spyOn(marketplace, 'claudePlugin').mockImplementation(async () => ({ ...PIN }));
    const tree = { tree: [{ path: '.claude-plugin/plugin.json', type: 'blob', size: 22 }] };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      return url.includes('/git/trees/') ? Response.json(tree) : new Response('{"name":"skills"}');
    }));
    const withRegistry = credentials.create({ name: 'kind with registry', type: 'core.kagentApi', data: { ...clusterData(), pluginRegistry: 'http://192.168.1.5:3000/' } });
    try {
      const agent = publishedAgent(DEV);
      const deployed = await call<{ status: KagentStatus }>(kagentRoute.PUT, agent.id, 'PUT', { credentialId: withRegistry.id, name: 'packed', harness: 'landflow-claude' });
      expect(deployed.status).toBe(200);
      const [source] = (held('agenttemplates', 'packed')!.spec as { plugins: Array<{ source: { oci: string } }> }).plugins;
      expect(source.source.oci).toMatch(/^192\.168\.1\.5:3000\/plugins\/claude-plugins-official\/mattpocock-skills@sha256:[0-9a-f]{64}$/);
      expect(agentStore.get(agent.id)!.kagent!.plugins).toEqual([{ ...PIN, oci: source.source.oci }]);
      expect(deployed.data.status).toMatchObject({ inSync: true, drift: [] });
    } finally {
      pin.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('moves back to kagent’s own runtime without the approval server or the plugins', async () => {
    const pin = vi.spyOn(marketplace, 'claudePlugin').mockResolvedValue(PIN);
    try {
      const agent = publishedAgent(DEV);
      await call(kagentRoute.PUT, agent.id, 'PUT', { credentialId: cluster.id, name: 'mover', harness: 'landflow-claude' });
      const moved = await call<{ status: KagentStatus }>(kagentRoute.PUT, agent.id, 'PUT', { harness: 'landflow-kagent' });
      expect(moved.data.status).toMatchObject({ inSync: true, harness: { name: 'landflow-kagent', runtime: 'kagent' } });
      expect(moved.data.status.plugins).toBeUndefined();
      expect(held('remotemcpservers', 'mover-approval')).toBeUndefined();
      expect(held('remotemcpservers', 'mover')!.spec).toMatchObject({ url: `http://landflow.test:3000/api/mcp/agents/${agent.id}` });
      expect((held('agenttemplates', 'mover')!.spec as Record<string, unknown>).plugins).toBeUndefined();
      expect(held('modelconfigs', 'mover')!.spec).toMatchObject({ provider: 'Ollama' });
      // Removing deletes both servers.
      await call(kagentRoute.PUT, agent.id, 'PUT', { harness: 'landflow-claude' });
      expect(held('remotemcpservers', 'mover-approval')).toBeDefined();
      await call(kagentRoute.DELETE, agent.id, 'DELETE');
      expect(written()).toEqual([]);
    } finally {
      pin.mockRestore();
    }
  });

  it('refuses a Harness it can’t write to, a model Claude Code can’t run, and a plugin it can’t resolve', async () => {
    const agent = publishedAgent();
    const codex = await call<{ error: string }>(kagentRoute.PUT, agent.id, 'PUT', { credentialId: cluster.id, harness: 'codex' });
    expect(codex).toMatchObject({ status: 400, data: { error: expect.stringContaining('The Harness “codex” runs Codex, which Landflow doesn’t write agents for') } });
    const missing = await call<{ error: string }>(kagentRoute.PUT, agent.id, 'PUT', { credentialId: cluster.id, harness: 'nope' });
    expect(missing.data.error).toBe('kagent has no Harness “nope” in kagent');

    const openai = publishedAgent({ ...CONFIG, model: { provider: 'openai', model: 'gpt-5' } });
    const refused = await call<{ error: string }>(kagentRoute.PUT, openai.id, 'PUT', { credentialId: cluster.id, harness: 'landflow-claude' });
    expect(refused.data.error).toMatch(/^Claude Code runs Anthropic models, or Ollama ones/);

    const unknown = publishedAgent({ ...CONFIG, plugins: ['ghost@nowhere'] });
    const unresolved = await call<{ error: string }>(kagentRoute.PUT, unknown.id, 'PUT', { credentialId: cluster.id, name: 'ghost', harness: 'landflow-claude' });
    expect(unresolved).toMatchObject({ status: 400, data: { error: 'The plugin ghost@nowhere is in no added marketplace: add “nowhere” on the Marketplace page' } });
    expect(written()).toEqual([]);
    // kagent's own runtime doesn't use plugins, so it doesn't resolve them.
    expect((await call(kagentRoute.PUT, unknown.id, 'PUT', { credentialId: cluster.id, name: 'ghost' })).status).toBe(200);
  });

  it('keeps an agent’s plugins in its config: trimmed, valid and each once', () => {
    const agent = agentStore.create({ ...CONFIG, plugins: [' a@m ', 'a@m', 'no-marketplace', 'b@m'] });
    expect(agent.plugins).toEqual(['a@m', 'b@m']);
    expect(agentStore.saveDraft(agent.id, { plugins: [] })).not.toHaveProperty('plugins');
  });
});
