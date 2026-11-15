/**
 * Agents on kagent through the LLM gateway (docs/llm-gateway.md, "Agents outside Landflow"): deploying mints one virtual key
 * per agent and runtime against a fake LiteLLM, the ModelConfig and the Secret point at the gateway, a redeploy reuses the
 * key, and removing the agent blocks it (never deletes). Without a cluster URL, an admin key or a served model, the
 * manifests are exactly what they are without a gateway.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentConfig, KagentStatus } from '@/lib/shared/agents';
import type { KubeObject } from '@/lib/server/kagent/kube';
import { startFakeLiteLlm, type FakeLiteLlm } from './fake-litellm';

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { agentStore } = await import('@/lib/server/agents/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { database } = await import('@/lib/server/db');
const { deployToKagent, removeFromKagent, kagentStatus } = await import('@/lib/server/kagent/deploy');
const { forgetServedModels, runtimeKeyRows } = await import('@/lib/server/llm-gateway/runtime-keys');
const { hashKey } = await import('@/lib/server/llm-gateway/client');
const { onRuntimeKeyChanged } = await import('@/lib/server/llm-gateway/events');
const { LITELLM_IDS } = await import('@/lib/shared/llm-gateway');

/** A Kubernetes API in memory: server-side apply, get, list, delete (as test/kagent.test.ts fakes it). */
async function startFakeKube() {
  const objects = new Map<string, KubeObject>();
  const body = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let text = '';
      req.on('data', (chunk) => (text += chunk));
      req.on('end', () => resolve(text));
    });
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://kube');
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== 'Bearer kube-token') return send(401, { message: 'Unauthorized' });
    const match = /^\/apis?\/(?:[^/]+\/)?[^/]+\/namespaces\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) return send(404, { message: 'not found' });
    const [, namespace, plural, name] = match;
    const key = `${plural}/${namespace}/${name}`;
    if (req.method === 'PATCH') {
      const applied = JSON.parse(await body(req)) as KubeObject;
      const previous = objects.get(key);
      objects.set(key, { ...previous, ...applied, metadata: { ...previous?.metadata, ...applied.metadata } } as KubeObject);
      return send(200, objects.get(key));
    }
    if (req.method === 'DELETE') return objects.delete(key) ? send(200, { status: 'Success' }) : send(404, { message: 'not found' });
    if (!name) return send(200, { items: [...objects.entries()].filter(([k]) => k.startsWith(`${plural}/${namespace}/`)).map(([, v]) => v) });
    const found = objects.get(key);
    return found ? send(200, found) : send(404, { message: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { objects, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const CLUSTER_URL = 'http://litellm.cluster.test:4000';
let kube: Awaited<ReturnType<typeof startFakeKube>>;
let litellm: FakeLiteLlm;
let cluster: { id: string; name: string };
const saved: Record<string, string | undefined> = {};
const ENV = ['LANDFLOW_LLM_GATEWAY_URL', 'LANDFLOW_LLM_GATEWAY_ADMIN_KEY', 'LANDFLOW_LLM_GATEWAY_CLUSTER_URL'];

const CONFIG: Partial<AgentConfig> = {
  name: 'Text formatter',
  description: 'Turns text into URL slugs',
  model: { provider: 'ollama', model: 'qwen3-coder:30b', baseUrl: 'http://host.docker.internal:11434' },
  instructions: 'You format text.',
  tools: [{ id: 't1', type: 'node', name: 'Echo', description: 'Echo the input', nodeType: 'core.noOp', parameters: {} }],
};

function publishedAgent(extra: Partial<AgentConfig> = {}) {
  const agent = agentStore.create({ ...CONFIG, ...extra });
  return agentStore.publish(agent.id)!;
}
const withLimit = (dailyCostLimit: number) => ({ settings: { dailyCostLimit } as AgentConfig['settings'] });
const held = (kind: string, name: string) => kube.objects.get(`${kind}/kagent/${name}`);

beforeAll(async () => {
  registry.registerBuiltin(corePlugin);
  kube = await startFakeKube();
  litellm = await startFakeLiteLlm();
  cluster = credentials.create({
    name: 'kind kagent',
    type: 'core.kagentApi',
    data: { server: kube.url, token: 'kube-token', namespace: 'kagent', harness: 'landflow-kagent', controllerUrl: 'http://kagent.test:8083', landflowUrl: 'http://landflow.test:3000' },
  });
  for (const name of ENV) saved[name] = process.env[name];
});
afterAll(async () => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  await kube.close();
  await litellm.close();
});
beforeEach(() => {
  kube.objects.clear();
  for (const [name, spec] of [['landflow-kagent', { kagent: {} }], ['landflow-claude', { claude: {} }]] as const) {
    kube.objects.set(`harnesses/kagent/${name}`, { apiVersion: 'api.kagent.dev/v1alpha3', kind: 'Harness', metadata: { name, namespace: 'kagent' }, spec });
  }
  process.env.LANDFLOW_LLM_GATEWAY_URL = litellm.origin;
  process.env.LANDFLOW_LLM_GATEWAY_ADMIN_KEY = litellm.masterKey;
  process.env.LANDFLOW_LLM_GATEWAY_CLUSTER_URL = CLUSTER_URL;
  forgetServedModels();
  litellm.requests.length = 0;
});
afterEach(() => forgetServedModels());

const generated = () => litellm.requests.filter((r) => r.path === '/key/generate');

describe('a virtual key per agent', () => {
  it('mints a key for an Ollama agent on kagent’s own runtime and points the ModelConfig at the gateway', async () => {
    const agent = publishedAgent(withLimit(2));
    const changed: string[] = [];
    const stop = onRuntimeKeyChanged((id) => void changed.push(id));
    const { unavailable, status } = await deployToKagent(agent.id, { credential: cluster });
    stop();
    expect(unavailable).toEqual([]);
    expect(generated()).toHaveLength(1);
    expect(generated()[0].body).toMatchObject({
      key_alias: `landflow-kagent-${agent.id}`,
      models: ['qwen3-coder:30b'],
      max_budget: 2,
      budget_duration: '1d',
      metadata: { spend_logs_metadata: { landflow: 'runtime', runtime: 'kagent', agent: agent.id } },
    });
    const [row] = runtimeKeyRows(agent.id);
    expect(row).toMatchObject({ runtime: 'kagent', key_alias: `landflow-kagent-${agent.id}`, blocked: 0, max_budget: 2, budget_duration: '1d' });
    expect(row.id).toMatch(/^lgk_/);
    const key = credentials.openSecret(row.key_sealed);
    expect(key).toMatch(/^sk-/);
    expect(row.key_sealed).not.toContain(key);
    expect(row.key_hash).toBe(hashKey(key));
    expect(litellm.keys.get(key)?.models).toEqual(['qwen3-coder:30b']);
    expect(held('modelconfigs', 'text-formatter')!.spec).toEqual({
      provider: 'OpenAI',
      model: 'qwen3-coder:30b',
      apiKeySecret: 'text-formatter-landflow',
      apiKeySecretKey: 'api-key',
      openAI: { baseUrl: `${CLUSTER_URL}/v1` },
    });
    expect((held('secrets', 'text-formatter-landflow')!.stringData as Record<string, string>)['api-key']).toBe(key);
    expect(changed).toEqual([agent.id]);
    expect(status.inSync).toBe(true);
  });

  it('gives Claude Code the Anthropic format at the gateway root, and the sandbox the gateway’s origin', async () => {
    const agent = publishedAgent();
    await deployToKagent(agent.id, { credential: cluster, harness: 'landflow-claude' });
    expect(generated()[0].body.key_alias).toBe(`landflow-claude-${agent.id}`);
    const key = credentials.openSecret(runtimeKeyRows(agent.id)[0].key_sealed);
    expect(held('modelconfigs', 'text-formatter')!.spec).toEqual({
      provider: 'Anthropic',
      model: 'qwen3-coder:30b',
      apiKeySecret: 'text-formatter-landflow',
      apiKeySecretKey: 'api-key',
      anthropic: { baseUrl: CLUSTER_URL },
    });
    expect((held('secrets', 'text-formatter-landflow')!.stringData as Record<string, string>)['api-key']).toBe(key);
    expect(held('egresspolicies', 'text-formatter-landflow')!.spec).toEqual({ destinations: [{ origin: CLUSTER_URL }] });
    expect((held('agents', 'text-formatter')!.spec as { egressPolicyRefs: unknown }).egressPolicyRefs).toEqual([{ name: 'text-formatter-landflow' }]);
    expect(LITELLM_IDS.runtimeKeyAlias('claude', agent.id)).toBe(`landflow-claude-${agent.id}`);
  });

  it('reuses the key on a redeploy and updates it when the model or the agent’s cost limit changes', async () => {
    const agent = publishedAgent(withLimit(2));
    await deployToKagent(agent.id, { credential: cluster });
    const [first] = runtimeKeyRows(agent.id);
    await deployToKagent(agent.id);
    expect(generated()).toHaveLength(1);
    expect(litellm.requests.filter((r) => r.path === '/key/update')).toHaveLength(0);
    expect(runtimeKeyRows(agent.id)[0].key_hash).toBe(first.key_hash);

    agentStore.saveDraft(agent.id, { ...withLimit(5), model: { provider: 'ollama', model: 'qwen3.8', baseUrl: 'http://host.docker.internal:11434' } });
    agentStore.publish(agent.id);
    await deployToKagent(agent.id);
    expect(generated()).toHaveLength(1);
    const updates = litellm.requests.filter((r) => r.path === '/key/update');
    expect(updates).toHaveLength(1);
    expect(updates[0].body).toMatchObject({ models: ['qwen3.8'], max_budget: 5, budget_duration: '1d' });
    expect(runtimeKeyRows(agent.id)[0]).toMatchObject({ key_hash: first.key_hash, max_budget: 5 });
    // The status reads the minted key without asking LiteLLM to change anything.
    litellm.requests.length = 0;
    const read: KagentStatus = await kagentStatus(agentStore.get(agent.id)!);
    expect(read.inSync).toBe(true);
    expect(litellm.requests.filter((r) => r.path === '/key/update' || r.path === '/key/generate')).toHaveLength(0);
  });

  it('puts the key on the agent’s project team when LiteLLM has that team', async () => {
    const agent = publishedAgent();
    const { setHomeProject } = await import('@/lib/server/projects/store');
    const project = 'prj_runtime_keys';
    setHomeProject('agent', agent.id, project);
    litellm.teams.set(LITELLM_IDS.team(project), { team_id: LITELLM_IDS.team(project), spend: 0 });
    await deployToKagent(agent.id, { credential: cluster });
    expect(generated()[0].body).toMatchObject({ team_id: LITELLM_IDS.team(project), metadata: { spend_logs_metadata: { project } } });
    expect(runtimeKeyRows(agent.id)[0]).toMatchObject({ team_id: LITELLM_IDS.team(project), project_id: project });
  });

  it('blocks the old runtime’s key when the agent moves to the other runtime', async () => {
    const agent = publishedAgent();
    await deployToKagent(agent.id, { credential: cluster });
    await deployToKagent(agent.id, { harness: 'landflow-claude' });
    const rows = runtimeKeyRows(agent.id);
    expect(rows.map((r) => [r.runtime, r.blocked])).toEqual(expect.arrayContaining([['kagent', 1], ['claude', 0]]));
    const old = rows.find((r) => r.runtime === 'kagent')!;
    expect(litellm.keys.get(credentials.openSecret(old.key_sealed))?.blocked).toBe(true);
  });

  it('blocks and never deletes when the agent is removed, and takes the key up again on a new deploy', async () => {
    const agent = publishedAgent();
    await deployToKagent(agent.id, { credential: cluster });
    const [row] = runtimeKeyRows(agent.id);
    const key = credentials.openSecret(row.key_sealed);
    await removeFromKagent(agent.id);
    expect(litellm.keys.get(key)?.blocked).toBe(true);
    expect(runtimeKeyRows(agent.id)[0].blocked).toBe(1);
    expect(litellm.requests.some((r) => /delete/.test(r.path))).toBe(false);
    expect(litellm.keys.has(key)).toBe(true);

    await deployToKagent(agent.id, { credential: cluster });
    expect(generated()).toHaveLength(1);
    expect(litellm.keys.get(key)?.blocked).toBe(false);
    expect(runtimeKeyRows(agent.id)).toHaveLength(1);
    expect(runtimeKeyRows(agent.id)[0].blocked).toBe(0);
  });
});

describe('without the gateway', () => {
  const direct = (id: string) => {
    expect(held('modelconfigs', 'text-formatter')!.spec).toMatchObject({ provider: 'Ollama', ollama: { host: 'http://host.docker.internal:11434' } });
    expect(runtimeKeyRows(id)).toEqual([]);
    expect((held('secrets', 'text-formatter-landflow')!.stringData as Record<string, string>)['api-key']).toBeUndefined();
  };

  it('keeps today’s manifests, and says why, without a cluster URL', async () => {
    delete process.env.LANDFLOW_LLM_GATEWAY_CLUSTER_URL;
    const agent = publishedAgent();
    const { unavailable } = await deployToKagent(agent.id, { credential: cluster });
    expect(unavailable).toEqual([expect.stringMatching(/^Calls the model directly: .*cluster URL/)]);
    direct(agent.id);
  });

  it('keeps today’s manifests, and says why, without an admin key', async () => {
    delete process.env.LANDFLOW_LLM_GATEWAY_ADMIN_KEY;
    const agent = publishedAgent();
    const { unavailable } = await deployToKagent(agent.id, { credential: cluster });
    expect(unavailable).toEqual([expect.stringMatching(/^Calls the model directly: no admin key: needs LANDFLOW_LLM_GATEWAY_URL and LANDFLOW_LLM_GATEWAY_ADMIN_KEY on the server/)]);
    direct(agent.id);
  });

  it('keeps today’s manifests, and says why, when the gateway does not serve the model', async () => {
    const agent = publishedAgent({ model: { provider: 'ollama', model: 'not-served:1b', baseUrl: 'http://host.docker.internal:11434' } });
    const { unavailable } = await deployToKagent(agent.id, { credential: cluster });
    expect(unavailable).toEqual(['Calls the model directly: the gateway does not serve not-served:1b']);
    expect((held('modelconfigs', 'text-formatter')!.spec as { ollama: { host: string } }).ollama.host).toBe('http://host.docker.internal:11434');
    expect(runtimeKeyRows(agent.id)).toEqual([]);
  });

  it('changes and reports nothing when no gateway is configured at all', async () => {
    delete process.env.LANDFLOW_LLM_GATEWAY_URL;
    const agent = publishedAgent();
    const { unavailable } = await deployToKagent(agent.id, { credential: cluster });
    expect(unavailable).toEqual([]);
    direct(agent.id);
    expect(database().all('SELECT 1 FROM llm_gateway_keys WHERE agent_id = ?', agent.id)).toEqual([]);
  });
});
