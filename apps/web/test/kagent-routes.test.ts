/**
 * C26: secret routes on kagent (docs/a2a.md, "Secret routes"). The rules a person's route must meet (shared with the card),
 * resolving routes against the vault (types, the agent's project, values), the keyed hash, the objects written (a Secret
 * `<name>-routes` and an EgressPolicy with `authentication` per host) and the header-recording upstream the live check uses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeUpstream } from '@landflow/test-fakes/upstream';
import { ROUTE_LIMITS, routeProblem, routesProblem, routeDefaults, type KagentSecretRoute } from '@/lib/shared/kagent-routes';

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { credentials } = await import('@/lib/server/credentials/vault');
const { agentStore } = await import('@/lib/server/agents/store');
const { resolveRoutes, routesHmac, routesHashMatches } = await import('@/lib/server/kagent/routes');
const { routeObjects, routesName } = await import('@/lib/server/kagent/manifests');

const route = (over: Partial<KagentSecretRoute> = {}): KagentSecretRoute => ({ credential: { id: 'c', name: 'Linear' }, hosts: ['https://api.linear.app'], ...over });

describe('the rules for one route', () => {
  it('accepts https DNS origins, with a port', () => {
    expect(routeProblem(route(), 0)).toBeUndefined();
    expect(routeProblem(route({ hosts: ['https://api.example.test:8443', 'https://a.b.example.com'] }), 0)).toBeUndefined();
  });

  it('refuses what is not an https DNS origin and names the route and host (AS-7)', () => {
    for (const host of ['http://api.linear.app', 'https://10.0.0.5', 'https://[::1]', 'https://*.example.com', 'https://api.linear.app/v1', 'https://api.linear.app?x=1', 'https://user:pw@api.linear.app', 'api.linear.app', '', 'https://api.linear.app/']) {
      const problem = routeProblem(route({ hosts: [host] }), 1);
      expect(problem, host).toMatch(/^Route 2: /);
      if (host) expect(problem, host).toContain(host);
    }
    expect(routeProblem(route({ hosts: ['https://*.example.com'] }), 0)).toContain('no wildcards');
    expect(routeProblem(route({ hosts: ['http://10.0.0.5'] }), 0)).toContain('https');
  });

  it('refuses no hosts and more than ten', () => {
    expect(routeProblem(route({ hosts: [] }), 0)).toMatch(/Route 1: .*at least one host/);
    const many = Array.from({ length: ROUTE_LIMITS.hostsPerRoute + 1 }, (_, i) => `https://h${i}.example.com`);
    expect(routeProblem(route({ hosts: many }), 0)).toMatch(/at most 10 hosts/);
  });

  it('refuses a header that is not a token or that the gateway must not set', () => {
    expect(routeProblem(route({ header: 'Host' }), 0)).toContain('Host');
    expect(routeProblem(route({ header: 'content-length' }), 0)).toBeDefined();
    expect(routeProblem(route({ header: 'Cookie' }), 0)).toBeDefined();
    expect(routeProblem(route({ header: 'X Api Key' }), 0)).toContain('header');
    expect(routeProblem(route({ header: 'X-Api-Key', prefix: '' }), 0)).toBeUndefined();
    expect(routeProblem(route({ prefix: 'Bearer\r\nX: y' }), 0)).toContain('prefix');
  });

  it('refuses more than twenty routes, and a host in two routes', () => {
    const many = Array.from({ length: ROUTE_LIMITS.routes + 1 }, (_, i) => route({ hosts: [`https://h${i}.example.com`] }));
    expect(routesProblem(many)).toMatch(/at most 20 routes/i);
    expect(routesProblem(many.slice(0, 20))).toBeUndefined();
    expect(routesProblem([route(), route()])).toMatch(/Route 2: .*api\.linear\.app.*Route 1/);
  });

  it('defaults per credential type (D7)', () => {
    expect(routeDefaults('core.httpBearerAuth')).toEqual({ header: 'Authorization', prefix: 'Bearer ' });
    expect(routeDefaults('core.httpHeaderAuth')).toEqual({ prefix: '' });
  });
});

let bearer: { id: string; name: string };
let headerAuth: { id: string; name: string };
let oauth: { id: string; name: string };
let other: { id: string; name: string };
let agentId: string;
const TOKEN = 'dummy-route-token-1';

beforeAll(async () => {
  registry.registerBuiltin(corePlugin);
  bearer = credentials.create({ name: 'Linear', type: 'core.httpBearerAuth', data: { token: TOKEN } });
  headerAuth = credentials.create({ name: 'Acme key', type: 'core.httpHeaderAuth', data: { name: 'X-API-Key', value: 'dummy-header-value' } });
  oauth = credentials.create({ name: 'Google', type: 'core.openAiApi', data: { apiKey: 'x', baseUrl: 'http://localhost:1' } });
  other = credentials.create({ name: 'Other project', type: 'core.httpBearerAuth', data: { token: 'other-token' } });
  agentId = agentStore.create({ name: 'Router' }).id;
  // This credential lives in a team project the agent's project does not share.
  const { createTeamProject, setHomeProject } = await import('@/lib/server/projects/store');
  setHomeProject('credential', other.id, createTeamProject({ name: 'Elsewhere' }).id);
});

describe('resolving routes against the vault', () => {
  it('reads a Bearer credential as Authorization: Bearer, a Header Auth one as its own header and no prefix', async () => {
    const [a, b] = await resolveRoutes(agentId, [route({ credential: bearer }), route({ credential: headerAuth, hosts: ['https://api.acme.test'] })]);
    expect(a).toMatchObject({ key: 'r0', header: 'Authorization', prefix: 'Bearer ', value: TOKEN, credentialName: 'Linear' });
    expect(b).toMatchObject({ key: 'r1', header: 'X-API-Key', prefix: '', value: 'dummy-header-value' });
  });

  it('takes the person’s header and prefix over the defaults', async () => {
    const [a] = await resolveRoutes(agentId, [route({ credential: bearer, header: 'X-Token', prefix: '' })]);
    expect(a).toMatchObject({ header: 'X-Token', prefix: '' });
  });

  it('refuses a credential type with no static header, naming the types that work (AS-4)', async () => {
    await expect(resolveRoutes(agentId, [route({ credential: oauth })])).rejects.toThrow(/Google.*Bearer Auth.*Header Auth/s);
  });

  it('refuses a credential that was deleted, naming it', async () => {
    await expect(resolveRoutes(agentId, [route({ credential: { id: 'gone', name: 'Old token' } })])).rejects.toThrow(/Old token/);
  });

  it('refuses a credential the agent’s project may not use, naming it (AS-5)', async () => {
    await expect(resolveRoutes(agentId, [route({ credential: other })])).rejects.toThrow(/Other project/);
  });

  it('refuses a value that would split the header', async () => {
    const evil = credentials.create({ name: 'Evil', type: 'core.httpBearerAuth', data: { token: 'a\r\nX-Injected: 1' } });
    await expect(resolveRoutes(agentId, [route({ credential: evil })])).rejects.toThrow(/Evil/);
  });
});

describe('the keyed hash', () => {
  const base = { header: 'Authorization', prefix: 'Bearer ', hosts: ['https://api.linear.app'], credentialName: 'Linear', credentialId: 'c' };
  const one = (value: string, key = 'r0') => ({ ...base, key, value });

  it('changes with a value, not with the order of routes, and holds no part of the value', () => {
    const a = routesHmac([one('v1'), { ...one('w1', 'r1'), hosts: ['https://b.example.com'] }]);
    const reordered = routesHmac([{ ...one('w1', 'r0'), hosts: ['https://b.example.com'] }, one('v1', 'r1')]);
    expect(a).toBe(reordered);
    expect(routesHmac([one('v2'), { ...one('w1', 'r1'), hosts: ['https://b.example.com'] }])).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain('v1');
  });

  it('matches the stored hash through every key of the ring, and no other', () => {
    const hash = routesHmac([one('v1')]);
    expect(routesHashMatches([one('v1')], hash)).toBe(true);
    expect(routesHashMatches([one('v2')], hash)).toBe(false);
    expect(routesHashMatches([one('v1')], undefined)).toBe(false);
  });
});

describe('the objects written', () => {
  const input = { agentId: 'ag_1', version: 2, cluster: { namespace: 'kagent' } };
  const entries = [
    { key: 'r0', header: 'Authorization', prefix: 'Bearer ', hosts: ['https://api.linear.app', 'https://uploads.linear.app'], value: TOKEN, credentialName: 'Linear', credentialId: 'c' },
    { key: 'r1', header: 'X-API-Key', prefix: '', hosts: ['https://api.acme.test'], value: 'dummy-header-value', credentialName: 'Acme key', credentialId: 'd' },
  ];

  it('is a Secret with one key per route and an EgressPolicy with authentication per host (AS-1)', () => {
    const [secret, policy] = routeObjects(input, 'router', entries, 'hmac-1');
    expect(secret).toMatchObject({ apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata: { name: 'router-routes', namespace: 'kagent', labels: { 'landflow.dev/agent-id': 'ag_1', 'app.kubernetes.io/managed-by': 'landflow' } } });
    expect(Object.keys((secret as { data: object }).data)).toEqual(['r0', 'r1']);
    expect(Buffer.from((secret as { data: Record<string, string> }).data.r0, 'base64').toString()).toBe(TOKEN);
    expect(policy).toMatchObject({ kind: 'EgressPolicy', metadata: { name: routesName('router'), annotations: { 'landflow.dev/routes-hmac': 'hmac-1' } } });
    expect((policy.spec as { destinations: unknown[] }).destinations).toEqual([
      { origin: 'https://api.linear.app', authentication: { header: 'Authorization', prefix: 'Bearer ', secretKeyRef: { name: 'router-routes', key: 'r0' } } },
      { origin: 'https://uploads.linear.app', authentication: { header: 'Authorization', prefix: 'Bearer ', secretKeyRef: { name: 'router-routes', key: 'r0' } } },
      { origin: 'https://api.acme.test', authentication: { header: 'X-API-Key', secretKeyRef: { name: 'router-routes', key: 'r1' } } },
    ]);
  });

  it('keeps the value out of the policy and the hash annotation', () => {
    const [, policy] = routeObjects(input, 'router', entries, 'hmac-1');
    const text = JSON.stringify(policy);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('dummy-header-value');
  });

  it('can not collide with another agent’s objects or the hand-made landflow-github ones', () => {
    // `<name>-routes` is a Secret and an EgressPolicy of this agent only; the other kinds an agent “x-routes” owns are named x-routes-landflow or x-routes.
    expect(routesName('router')).toBe('router-routes');
    expect(routesName('router')).not.toBe('landflow-github');
    expect(routesName('router')).not.toBe('github-git');
  });
});

describe('the header-recording upstream', () => {
  const upstream = fakeUpstream();
  beforeAll(() => upstream.start());
  afterAll(() => upstream.stop());

  it('records every request’s headers and answers with them', async () => {
    const answer = await fetch(`${upstream.url}/v1/me`, { headers: { Authorization: 'x', 'X-Other': '1' } });
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as { headers: Record<string, string> }).headers.authorization).toBe('x');
    expect(upstream.state().requests.at(-1)).toMatchObject({ method: 'GET', path: '/v1/me', headers: { authorization: 'x', 'x-other': '1' } });
  });
});
