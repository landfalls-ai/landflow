/**
 * C26-D2: a leader timer keeps the routes' Secret in step with the vault (lib/server/kagent/route-refresh.ts). A changed
 * credential value makes the next tick rewrite the Secret and only the Secret, record the new hash and audit it without the
 * value; an unchanged one costs no cluster call; a credential that can't be read empties its key and shows the route as broken;
 * a tick looks at 50 agents and the next carries on. The cluster is a fake Kubernetes API.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentConfig, KagentStatus } from '@/lib/shared/agents';
import type { KubeObject } from '@/lib/server/kagent/kube';

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { agentStore } = await import('@/lib/server/agents/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { queryEvents } = await import('@/lib/server/audit/store');
const { kagentRouteRefresh, AGENTS_PER_TICK } = await import('@/lib/server/kagent/route-refresh');
const { kagentStatus } = await import('@/lib/server/kagent/deploy');
const { routesHmac } = await import('@/lib/server/kagent/routes');
const kagentRoute = await import('@/app/api/agents/[id]/kagent/route');

/** A Kubernetes API that keeps objects in memory: server-side apply (merged per field), get, list and delete. */
interface FakeKube {
  url: string;
  objects: Map<string, KubeObject>;
  requests: Array<{ method: string; path: string; contentType?: string; authorization?: string }>;
  /** Out of reach: every request fails with 503. */
  down: boolean;
  /** Plurals Landflow may only read (an older access Role): writing one is 403. */
  readOnly: Set<string>;
  /** Called as each object is applied, as kagent's controller would see it. */
  onApply?: (plural: string, object: KubeObject) => void;
  close(): Promise<void>;
}

async function startFakeKube(): Promise<FakeKube> {
  const objects = new Map<string, KubeObject>();
  const requests: FakeKube['requests'] = [];
  const state: FakeKube = { url: '', objects, requests, down: false, readOnly: new Set(), close: () => new Promise((resolve) => server.close(() => resolve())) };
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
    if (req.method !== 'GET' && state.readOnly.has(plural)) return send(403, { message: `${plural} is forbidden` });
    if (req.method === 'PATCH') {
      expect(req.headers['content-type']).toBe('application/apply-patch+yaml');
      expect(url.searchParams.get('fieldManager')).toBe('landflow');
      const applied = JSON.parse(await body(req)) as KubeObject;
      const previous = objects.get(key);
      const merged = { ...previous, ...applied, metadata: { ...previous?.metadata, ...applied.metadata, generation: ((previous?.metadata.generation as number) ?? 0) + 1 } } as KubeObject;
      objects.set(key, merged);
      state.onApply?.(plural, merged);
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
let token: { id: string; name: string };
const FIRST = 'rotating-token-first';
const SECOND = 'rotating-token-second';

beforeAll(async () => {
  registry.registerBuiltin(corePlugin);
  // The data directory is shared by every test file a worker runs: routed deployments another file left would sit in the
  // tick's window of 50 and push this file's own agents out of it.
  for (const listed of agentStore.list()) if (agentStore.get(listed.id)?.kagent?.routes?.length) agentStore.setKagent(listed.id, undefined);
  kube = await startFakeKube();
  cluster = credentials.create({ name: 'kind kagent', type: 'core.kagentApi', data: { server: kube.url, token: 'kube-token', namespace: 'kagent', harness: 'landflow-claude', controllerUrl: 'http://kagent.test:8083', landflowUrl: 'http://landflow.test:3000' } });
});
afterAll(() => kube.close());
beforeEach(() => {
  kube.objects.clear();
  kube.objects.set('harnesses/kagent/landflow-claude', { apiVersion: 'api.kagent.dev/v1alpha3', kind: 'Harness', metadata: { name: 'landflow-claude', namespace: 'kagent' }, spec: { claude: {} } });
  // A token of its own each test, so a test changes only its own.
  token = credentials.create({ name: `Rotating ${Math.random().toString(36).slice(2, 7)}`, type: 'core.httpBearerAuth', data: { token: FIRST } });
  kube.requests.length = 0;
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
const call = async <T,>(handler: unknown, id: string, method = 'GET', body?: unknown): Promise<{ status: number; data: T }> => {
  const response = await (handler as Handler)(new Request(`http://localhost/api/agents/${id}/kagent`, { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), ctx(id));
  return { status: response.status, data: (await response.json()) as T };
};
const CONFIG: Partial<AgentConfig> = { name: 'Rotator', description: 'Rotates', model: { provider: 'ollama', model: 'qwen3-coder:30b', baseUrl: 'http://host.docker.internal:11434' }, instructions: 'x' };
async function deployed(name: string) {
  const agent = agentStore.publish(agentStore.create({ ...CONFIG, name }).id)!;
  const answer = await call<{ status: KagentStatus }>(kagentRoute.PUT, agent.id, 'PUT', { credentialId: cluster.id, harness: 'landflow-claude', routes: [{ credential: { id: token.id, name: token.name }, hosts: ['https://api.example.test'] }] });
  expect(answer.status, JSON.stringify(answer.data)).toBe(200);
  return agent;
}
const secretOf = (name: string) => kube.objects.get(`secrets/kagent/${name}-routes`) as unknown as { data: Record<string, string> };
const value = (name: string, key = 'r0') => Buffer.from(secretOf(name).data[key] ?? '', 'base64').toString();
const writes = () => kube.requests.filter((r) => r.method !== 'GET');

describe('the refresh tick', () => {
  it('rewrites only the Secret with the new value, keeps the hash, and leaves no drift (AS-6)', async () => {
    const agent = await deployed('Rot One');
    const policy = JSON.stringify(kube.objects.get('egresspolicies/kagent/rot-one-routes'));
    credentials.update(token.id, { data: { token: SECOND } });
    kube.requests.length = 0;
    expect(await kagentRouteRefresh.tick()).toBe(1);
    expect(writes().map((r) => r.path.replace(/\?.*/, ''))).toEqual(['/api/v1/namespaces/kagent/secrets/rot-one-routes']);
    expect(value('rot-one')).toBe(SECOND);
    expect(JSON.stringify(kube.objects.get('egresspolicies/kagent/rot-one-routes'))).toBe(policy);
    const stored = agentStore.get(agent.id)!.kagent!;
    expect(stored.routesHash).toBe(routesHmac([{ key: 'r0', header: 'Authorization', prefix: 'Bearer ', hosts: ['https://api.example.test'], value: SECOND, credentialId: token.id, credentialName: token.name }]));
    expect(stored.routesRefreshedAt).toBeDefined();
    const status = await kagentStatus(agentStore.get(agent.id)!);
    expect(status.drift, JSON.stringify(status.drift)).toEqual([]);
    expect(status.inSync).toBe(true);
  });

  it('audits the rewrite with the credential’s name and no value', async () => {
    const agent = await deployed('Rot Two');
    credentials.update(token.id, { data: { token: SECOND } });
    await kagentRouteRefresh.tick();
    const events = queryEvents({ targetId: agent.id, action: ['kagent.route.refreshed'] }).events;
    expect(events).toHaveLength(1);
    expect(events[0].details).toMatchObject({ credentialNames: [token.name] });
    expect(JSON.stringify(events)).not.toMatch(new RegExp(`${FIRST}|${SECOND}`));
  });

  it('makes no cluster call when nothing changed', async () => {
    await deployed('Rot Three');
    kube.requests.length = 0;
    expect(await kagentRouteRefresh.tick()).toBe(0);
    expect(kube.requests).toEqual([]);
  });

  it('empties the key of a deleted credential, shows the route as broken, and audits it', async () => {
    const agent = await deployed('Rot Four');
    credentials.delete(token.id);
    expect(await kagentRouteRefresh.tick()).toBe(1);
    expect(value('rot-four')).toBe('');
    const status = await kagentStatus(agentStore.get(agent.id)!);
    expect(status.routes?.[0].broken).toContain(token.name);
    expect(queryEvents({ targetId: agent.id, action: ['kagent.route.refreshed'] }).events[0].details).toMatchObject({ broken: [token.name] });
    // Settled: the next tick does nothing.
    kube.requests.length = 0;
    expect(await kagentRouteRefresh.tick()).toBe(0);
    expect(kube.requests).toEqual([]);
  });

  it('keeps going when the cluster is down, and writes once it is back', async () => {
    const agent = await deployed('Rot Five');
    credentials.update(token.id, { data: { token: SECOND } });
    kube.down = true;
    await expect(kagentRouteRefresh.tick()).resolves.toBe(0);
    expect(agentStore.get(agent.id)!.kagent!.routesRefreshedAt).toBeUndefined();
    kube.down = false;
    expect(await kagentRouteRefresh.tick()).toBe(1);
    expect(value('rot-five')).toBe(SECOND);
  });

  it('looks at 50 agents a tick and carries on with the rest on the next', async () => {
    // Deployments written straight to the store: routes whose recorded hash is stale, so every one needs a rewrite.
    const count = AGENTS_PER_TICK + 10;
    const ids: string[] = [];
    const base = agentStore.publish(agentStore.create({ ...CONFIG, name: 'Template' }).id)!;
    for (let i = 0; i < count; i++) {
      const agent = agentStore.create({ ...CONFIG, name: `Bulk ${i}` });
      agentStore.setKagent(agent.id, { credential: cluster, name: `bulk-${i}`, harness: 'landflow-claude', version: 1, deployedAt: `2026-11-22T00:00:${String(i).padStart(2, '0')}Z`, routes: [{ credential: { id: token.id, name: token.name }, hosts: ['https://api.example.test'], header: 'Authorization', prefix: 'Bearer ' }], routesHash: 'stale', routesPolicyHash: 'stale' });
      ids.push(agent.id);
    }
    void base;
    // Agents deployed by earlier tests are in the window too (and need nothing), so a tick rewrites up to 50, not exactly 50.
    const first = await kagentRouteRefresh.tick();
    expect(first).toBeLessThanOrEqual(AGENTS_PER_TICK);
    expect(first).toBeGreaterThan(AGENTS_PER_TICK - 10);
    const rest = (await kagentRouteRefresh.tick()) + (await kagentRouteRefresh.tick());
    expect(first + rest).toBe(count);
    expect(ids.map((id) => agentStore.get(id)!.kagent!.routesRefreshedAt).every(Boolean)).toBe(true);
    // Not left in the window of the tests that follow.
    for (const id of ids) agentStore.setKagent(id, undefined);
  });
});

describe('review fixes', () => {
  it('names only the credentials whose value changed', async () => {
    const second = credentials.create({ name: 'Steady', type: 'core.httpBearerAuth', data: { token: 'steady-value' } });
    const agent = agentStore.publish(agentStore.create({ ...CONFIG, name: 'Two Routes' }).id)!;
    const answer = await call<{ status: KagentStatus }>(kagentRoute.PUT, agent.id, 'PUT', { credentialId: cluster.id, harness: 'landflow-claude', routes: [{ credential: { id: token.id, name: token.name }, hosts: ['https://a.example.test'] }, { credential: { id: second.id, name: second.name }, hosts: ['https://b.example.test'] }] });
    expect(answer.status).toBe(200);
    credentials.update(token.id, { data: { token: SECOND } });
    await kagentRouteRefresh.tick();
    const event = queryEvents({ targetId: agent.id, action: ['kagent.route.refreshed'] }).events[0];
    expect(event.details).toMatchObject({ credentialNames: [token.name] });
    expect(JSON.stringify(event.details)).not.toContain('Steady');
  });

  it('marks a route that fails the rules broken and empties its key, without throwing', async () => {
    const agent = agentStore.create({ ...CONFIG, name: 'Tightened' });
    agentStore.setKagent(agent.id, { credential: cluster, name: 'tightened', harness: 'landflow-claude', version: 1, deployedAt: '2026-11-22T00:00:00Z', routes: [{ credential: { id: token.id, name: token.name }, hosts: ['http://10.0.0.5'], header: 'Authorization', prefix: 'Bearer ' }], routesHash: 'stale', routesPolicyHash: 'stale' });
    await expect(kagentRouteRefresh.tick()).resolves.toBeGreaterThanOrEqual(1);
    expect(value('tightened')).toBe('');
    expect((await kagentStatus(agentStore.get(agent.id)!)).routes?.[0].broken).toMatch(/10\.0\.0\.5/);
  });

  it('forgets its hash when a deploy landed while it was writing, so the next tick writes again', async () => {
    const agent = await deployed('Race One');
    credentials.update(token.id, { data: { token: SECOND } });
    kube.onApply = (plural, object) => {
      if (plural !== 'secrets' || object.metadata.name !== 'race-one-routes') return;
      const current = agentStore.get(agent.id)!;
      agentStore.setKagent(agent.id, { ...current.kagent!, deployedAt: '2030-01-01T00:00:00Z' });
    };
    await kagentRouteRefresh.tick();
    kube.onApply = undefined;
    expect(agentStore.get(agent.id)!.kagent!.routesHash).toBeUndefined();
    expect(await kagentRouteRefresh.tick()).toBe(1);
    expect(agentStore.get(agent.id)!.kagent!.routesHash).toBeDefined();
  });

  it('deletes the Secret it wrote when the deploy that landed has no routes', async () => {
    const agent = await deployed('Race Two');
    credentials.update(token.id, { data: { token: SECOND } });
    kube.onApply = (plural, object) => {
      if (plural !== 'secrets' || object.metadata.name !== 'race-two-routes') return;
      const current = agentStore.get(agent.id)!;
      const { routes: _routes, routesHash: _hash, routesPolicyHash: _policy, ...rest } = current.kagent!;
      agentStore.setKagent(agent.id, { ...rest, deployedAt: '2030-01-01T00:00:00Z' });
    };
    await kagentRouteRefresh.tick();
    kube.onApply = undefined;
    expect(kube.objects.get('secrets/kagent/race-two-routes')).toBeUndefined();
  });
});
