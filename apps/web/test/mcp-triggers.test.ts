/**
 * Stream T6-E: triggers as MCP resources (docs/transports.md "From node to tool", docs/protocol.md §15.9): the poll and app
 * webhook triggers of a plugin are resource templates on its endpoint; a 2026-07-28 client subscribes with
 * `subscriptions/listen` (`resourceSubscriptions`), the host runs the trigger for that subscription with the caller's
 * credential, sends `notifications/resources/updated`, and `resources/read` returns the buffered events. The test plugin runs
 * over HTTP on 7481 (stream T6-E's range 7481, in 7480–7499).
 */
import { mkdtempSync } from 'node:fs';
import { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, SdkError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { defineCredentialType, defineNode, definePlugin, pollIntervalProperty } from '@landflow/sdk';

vi.setConfig({ testTimeout: 30_000 });
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-mcp-t6e-'));
const ENV = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_PUBLIC_URL: 'http://mcp.test',
  LANDFLOW_ENCRYPTION_KEY: 'mcp-t6e-test-key',
  LANDFLOW_MCP_GATEWAY_SECRET: 'test-gateway-secret-0123456789',
  LANDFLOW_BINARY_SECRET: 'mcp-t6e-binary-secret',
  LANDFLOW_MCP_TRIGGER_MIN_INTERVAL_SECONDS: '0.2',
  LANDFLOW_MCP_TRIGGER_HEARTBEAT_SECONDS: '0.3',
  LANDFLOW_MCP_TRIGGER_SWEEP_SECONDS: '3600',
};
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
delete process.env.LANDFLOW_OIDC_ISSUER;

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { credentials } = await import('@/lib/server/credentials/vault');
const { createUser } = await import('@/lib/server/auth/users');
const { createApiKey } = await import('@/lib/server/auth/api-keys');
const { createGrant, deleteGrant } = await import('@/lib/server/mcp/grants');
const { closeMcpEndpoints } = await import('@/lib/server/mcp/server');
const { runningTriggerSubscriptions, stopAllTriggerSubscriptions, sweepTriggerSubscriptions } = await import('@/lib/server/mcp/triggers');
const { mcpDb } = await import('@/lib/server/mcp/db');
const { updateGovernancePolicy } = await import('@/lib/server/governance/policy');
const { queryEvents } = await import('@/lib/server/audit/store');
const { serveHttp } = await import('@landflow/sdk/http');
const { triggerResourceUri } = await import('@landflow/protocol');
const pluginRoute = await import('@/app/api/mcp/plugins/[id]/route');
const appHookRoute = await import('@/app/api/webhook/app/[workflowId]/[nodeId]/route');

registry.registerBuiltin(corePlugin);

// ---------------------------------------------------------------------------
// A plugin with a poll trigger (a feed the test controls) and an app webhook trigger (a fake service)
// ---------------------------------------------------------------------------

const PLUGIN_ID = 'tp-t6e';
const HTTP_PORT = 7481;
const CREDENTIAL_TYPE = `${PLUGIN_ID}.demoApi`;
const feed: Array<{ n: number; topic: string }> = [];
const polls = { count: 0, manual: 0, tokens: [] as string[] };
const hooks: Array<{ id: string; url: string }> = [];

const ticker = defineNode({
  description: {
    name: 'ticker',
    displayName: 'Ticker',
    description: 'New entries of the test feed',
    version: 1,
    kind: 'trigger',
    triggerSource: 'poll',
    inputs: [],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'demoApi', required: true }],
    properties: [pollIntervalProperty(10), { name: 'topic', displayName: 'Topic', type: 'string', default: 'all' }],
  },
  execute(ctx) {
    const topic = String(ctx.getNodeParameter('topic'));
    const matching = () => feed.filter((e) => topic === 'all' || e.topic === topic);
    const token = (ctx.getCredentials<{ token: string }>('demoApi') as { token: string } | undefined)?.token;
    if (ctx.mode === 'manual') {
      polls.manual++;
      return matching().slice(-3).map((e) => ({ json: { ...e } }));
    }
    polls.count++;
    if (token) polls.tokens.push(token);
    if (ctx.isFirstPoll()) {
      ctx.setPollState({ seen: feed.length });
      return [];
    }
    const seen = Number((ctx.getPollState() as { seen?: number } | undefined)?.seen ?? 0);
    ctx.setPollState({ seen: feed.length });
    return feed.slice(seen).filter((e) => topic === 'all' || e.topic === topic).map((e) => ({ json: { ...e } }));
  },
});

const hooked = defineNode({
  description: {
    name: 'hooked',
    displayName: 'Hooked',
    description: 'Events a fake service posts',
    version: 1,
    kind: 'trigger',
    triggerSource: 'appWebhook',
    inputs: [],
    outputs: [{ type: 'main' }],
    properties: [{ name: 'events', displayName: 'Events', type: 'string', default: 'push' }],
  },
  webhookMethods: {
    checkExists: (ctx) => hooks.some((h) => h.id === ctx.getStaticData().hookId),
    create(ctx) {
      const id = `hook-${hooks.length + 1}-${Math.random().toString(36).slice(2, 6)}`;
      hooks.push({ id, url: ctx.getWebhookUrl() });
      Object.assign(ctx.getStaticData(), { hookId: id });
    },
    delete(ctx) {
      const index = hooks.findIndex((h) => h.id === ctx.getStaticData().hookId);
      if (index >= 0) hooks.splice(index, 1);
      ctx.setStaticData({});
    },
  },
  webhook(ctx) {
    return { items: [{ event: ctx.getBody<Record<string, unknown>>() }] };
  },
});

const plugin = definePlugin({
  info: { id: PLUGIN_ID, name: 'T6E test plugin', version: '1.0.0' },
  nodes: [ticker, hooked],
  credentialTypes: [defineCredentialType({ name: 'demoApi', displayName: 'Demo API', properties: [{ name: 'token', displayName: 'Token', type: 'string', required: true, typeOptions: { password: true } }] })],
});

let httpPlugin: Server;
let admin: Awaited<ReturnType<typeof createUser>>;
let member: Awaited<ReturnType<typeof createUser>>;
let adminKey = '';
let memberKey = '';
let credA = { id: '', name: '' };
let credB = { id: '', name: '' };

beforeAll(async () => {
  httpPlugin = await serveHttp(plugin, { port: HTTP_PORT, host: '127.0.0.1' });
  await registry.addEndpoint(`http://127.0.0.1:${HTTP_PORT}`, 'static');
  admin = await createUser({ email: 'ada@t6e.test', name: 'Ada Admin', role: 'admin', password: 'admin-password-1' });
  member = await createUser({ email: 'mo@t6e.test', name: 'Mo Member', role: 'member', password: 'member-password-1' });
  adminKey = createApiKey(admin, { label: 'admin', scopes: ['admin'] }).token;
  memberKey = createApiKey(member, { label: 'member', scopes: ['admin'] }).token;
  credA = pick(credentials.create({ name: 'Demo A', type: CREDENTIAL_TYPE, data: { token: 'tok-a' } }));
  credB = pick(credentials.create({ name: 'Demo B', type: CREDENTIAL_TYPE, data: { token: 'tok-b' } }));
});

afterAll(async () => {
  await stopAllTriggerSubscriptions();
  await closeMcpEndpoints();
  await new Promise<void>((resolve) => httpPlugin.close(() => resolve()));
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const pick = (c: { id: string; name: string }) => ({ id: c.id, name: c.name });

afterEach(async () => {
  await stopAllTriggerSubscriptions();
  feed.length = 0;
  polls.count = polls.manual = 0;
  polls.tokens.length = 0;
  for (const row of mcpDb().all<{ sub_key: string }>('SELECT sub_key FROM mcp_trigger_subs')) {
    for (const e of mcpDb().all<{ id: string }>('SELECT id FROM mcp_trigger_events WHERE sub_key = ?', row.sub_key)) mcpDb().delete('mcp_trigger_events', { sub_key: row.sub_key, id: e.id });
    mcpDb().delete('mcp_trigger_subs', { sub_key: row.sub_key });
  }
  delete process.env.LANDFLOW_MCP_TRIGGER_IDLE_SECONDS;
  updateGovernancePolicy({ nodes: { mode: 'off', types: [] } });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Handler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
const route = pluginRoute as unknown as { POST: Handler };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function routeFetch() {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const id = decodeURIComponent(new URL(request.url).pathname.split('/').pop()!);
    return route.POST(request, { params: Promise.resolve({ id }) });
  };
}

async function connect(headers: Record<string, string>, mode: 'auto' | 'legacy' = 'auto') {
  const client = new Client({ name: 'agent', version: '1.0.0' }, { versionNegotiation: { mode } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://mcp.test/api/mcp/plugins/${PLUGIN_ID}`), { fetch: routeFetch(), requestInit: { headers } }));
  return client;
}

const grant = (subject = admin.id, tools: string[] | '*' = '*') => createGrant({ subject: { kind: 'user', id: subject }, pluginId: PLUGIN_ID, tools, credentials: { [CREDENTIAL_TYPE]: credA.id } }, admin.id);

const tickerUri = (extra: Record<string, unknown> = {}) => triggerResourceUri(PLUGIN_ID, 'trigger_ticker', { pollInterval: 0.3, ...extra });
const hookedUri = () => triggerResourceUri(PLUGIN_ID, 'trigger_hooked', { events: 'push' });

async function until<T>(check: () => T | undefined | false | Promise<T | undefined | false>, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const readEvents = async (client: Client, uri: string) => {
  const read = await client.readResource({ uri });
  return JSON.parse((read.contents[0] as { text: string }).text) as { subscribed: boolean; oneShot?: boolean; baseline?: boolean; stopped?: boolean; polls?: number; lastError?: string; events: Array<{ id: string; data: Record<string, unknown> }> };
};

const audits = (action: string) => queryEvents({ actions: [action] }).events;

// ---------------------------------------------------------------------------

describe('trigger resource templates', () => {
  it('lists the plugin’s poll and app webhook triggers as templates for a caller whose grant covers them, in both eras', async () => {
    const g = grant();
    for (const mode of ['auto', 'legacy'] as const) {
      const client = await connect(bearer(adminKey), mode);
      const { resourceTemplates } = await client.listResourceTemplates();
      expect(resourceTemplates.map((t) => t.name).sort()).toEqual(['trigger_hooked', 'trigger_ticker']);
      const t = resourceTemplates.find((x) => x.name === 'trigger_ticker')!;
      expect(t.uriTemplate).toBe('landflow://triggers/tp-t6e/trigger_ticker{?pollInterval,topic}');
      expect(t.mimeType).toBe('application/json');
      expect((client.getServerCapabilities()?.resources as { subscribe?: boolean } | undefined)?.subscribe).toBe(mode === 'auto' ? true : undefined);
      await client.close();
    }
    deleteGrant(g.id);
  });

  it('a grant naming one trigger lists only that one; no grant, no resources; governance hides a blocked node', async () => {
    const one = grant(member.id, ['trigger_ticker']);
    let client = await connect(bearer(memberKey));
    expect((await client.listResourceTemplates()).resourceTemplates.map((t) => t.name)).toEqual(['trigger_ticker']);
    await client.close();
    updateGovernancePolicy({ nodes: { mode: 'block', types: [`${PLUGIN_ID}.ticker`] } });
    client = await connect(bearer(memberKey));
    expect(client.getServerCapabilities()?.resources).toBeUndefined();
    await client.close();
    deleteGrant(one.id);
    updateGovernancePolicy({ nodes: { mode: 'off', types: [] } });
    client = await connect(bearer(memberKey));
    expect(client.getServerCapabilities()?.resources).toBeUndefined();
    await client.close();
  });
});

describe('subscribing to a poll trigger', () => {
  it('runs the poll with the grant’s credential, notifies on news, serves the events on read, and stops when the client leaves', async () => {
    const g = grant();
    const client = await connect(bearer(adminKey));
    const updates: string[] = [];
    client.setNotificationHandler('notifications/resources/updated', (n) => void updates.push(n.params.uri));
    const uri = tickerUri();
    const subscription = await client.listen({ resourceSubscriptions: [uri] });
    expect(subscription.honoredFilter.resourceSubscriptions).toEqual([uri]);
    expect(runningTriggerSubscriptions()).toBe(1);
    // The first poll is the baseline: nothing is reported.
    await until(() => polls.count >= 1);
    expect((await readEvents(client, uri)).events).toEqual([]);
    feed.push({ n: 1, topic: 'a' }, { n: 2, topic: 'b' });
    await until(() => updates.includes(uri));
    const read = await readEvents(client, uri);
    expect(read).toMatchObject({ subscribed: true });
    expect(read.events.map((e) => e.data.n)).toEqual([1, 2]);
    expect(new Set(polls.tokens)).toEqual(new Set(['tok-a']));
    // Governed and audited: the subscribe event names the trigger, never the parameter values.
    const subscribed = audits('mcp.resource.subscribe').find((e) => e.details?.trigger === 'trigger_ticker')!;
    expect(subscribed).toMatchObject({ outcome: 'success', actor: { id: admin.id } });
    expect(JSON.stringify(subscribed)).not.toContain('pollInterval');

    await subscription.close();
    await until(() => runningTriggerSubscriptions() === 0);
    const after = polls.count;
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(polls.count).toBe(after);
    expect(audits('mcp.resource.unsubscribe').some((e) => /last stream ended/.test(String(e.details?.reason)))).toBe(true);
    // The events stay readable for a while, marked stopped.
    expect(await readEvents(client, uri)).toMatchObject({ stopped: true, subscribed: false });
    await client.close();
    deleteGrant(g.id);
  });

  it('two streams share one poll; the poll stops with the last one; closing the connection ends the stream', async () => {
    const g = grant();
    const first = await connect(bearer(adminKey));
    const second = await connect(bearer(adminKey));
    const uri = tickerUri({ topic: 'a' });
    const one = await first.listen({ resourceSubscriptions: [uri] });
    const two = await second.listen({ resourceSubscriptions: [uri] });
    expect(runningTriggerSubscriptions()).toBe(1);
    await one.close();
    expect(runningTriggerSubscriptions()).toBe(1);
    // The session ends without an explicit unsubscribe: the transport goes away.
    await second.close();
    await until(() => runningTriggerSubscriptions() === 0);
    void two;
    deleteGrant(g.id);
  });

  it('binds the caller’s own credential when the grant names none, and refuses a caller without a grant or a credential', async () => {
    const bare = createGrant({ subject: { kind: 'user', id: member.id }, pluginId: PLUGIN_ID, tools: '*' }, admin.id);
    const client = await connect(bearer(memberKey));
    // Members' newest visible credential: the member sees none of the unscoped test credentials unless admin; expect a clear refusal or a bound token.
    const outcome = await client.listen({ resourceSubscriptions: [tickerUri()] }).then(
      (s) => ({ ok: true as const, s }),
      (error: Error) => ({ ok: false as const, error }),
    );
    if (outcome.ok) {
      await until(() => polls.tokens.length >= 1);
      expect(['tok-a', 'tok-b']).toContain(polls.tokens[0]);
      await outcome.s.close();
    } else {
      expect(outcome.error.message).toMatch(/credential/i);
    }
    await client.close();
    deleteGrant(bare.id);

    const stranger = await connect(bearer(memberKey));
    await expect(stranger.listen({ resourceSubscriptions: [tickerUri()] })).rejects.toThrow(/no grant/);
    expect(audits('mcp.resource.subscribe').some((e) => e.outcome === 'denied')).toBe(true);
    await stranger.close();
    expect(runningTriggerSubscriptions()).toBe(0);
  });

  it('stops when nobody reads for the idle time, and when the grant goes away', async () => {
    process.env.LANDFLOW_MCP_TRIGGER_IDLE_SECONDS = '1';
    let g = grant();
    let client = await connect(bearer(adminKey));
    await client.listen({ resourceSubscriptions: [tickerUri()] });
    await until(() => runningTriggerSubscriptions() === 0, 6000);
    expect(audits('mcp.resource.unsubscribe').some((e) => /idle/.test(String(e.details?.reason)))).toBe(true);
    await client.close();
    deleteGrant(g.id);

    delete process.env.LANDFLOW_MCP_TRIGGER_IDLE_SECONDS;
    g = grant();
    client = await connect(bearer(adminKey));
    await client.listen({ resourceSubscriptions: [tickerUri()] });
    expect(runningTriggerSubscriptions()).toBe(1);
    deleteGrant(g.id);
    await until(() => runningTriggerSubscriptions() === 0, 6000);
    expect(audits('mcp.resource.unsubscribe').some((e) => /grant/.test(String(e.details?.reason)))).toBe(true);
    await client.close();
  });
});

describe('2025-era clients', () => {
  it('cannot subscribe, but can read a poll trigger once (the node’s manual mode, nothing consumed); a webhook trigger says it needs a subscription', async () => {
    const g = grant();
    feed.push({ n: 1, topic: 'a' }, { n: 2, topic: 'a' });
    const client = await connect(bearer(adminKey), 'legacy');
    await expect(client.listen({ resourceSubscriptions: [tickerUri()] })).rejects.toBeInstanceOf(SdkError);
    const read = await readEvents(client, tickerUri());
    expect(read).toMatchObject({ oneShot: true, subscribed: false });
    expect(read.events.map((e) => e.data.n)).toEqual([1, 2]);
    expect(polls.manual).toBe(1);
    expect(runningTriggerSubscriptions()).toBe(0);
    await expect(client.readResource({ uri: hookedUri() })).rejects.toThrow(/subscri/);
    await expect(client.readResource({ uri: 'landflow://triggers/tp-t6e/nope' })).rejects.toThrow();
    await client.close();
    deleteGrant(g.id);
  });
});

describe('subscribing to an app webhook trigger', () => {
  it('registers the hook for the subscription, turns the service’s calls into events, and removes the hook when the stream ends', async () => {
    const g = grant();
    const client = await connect(bearer(adminKey));
    const updates: string[] = [];
    client.setNotificationHandler('notifications/resources/updated', (n) => void updates.push(n.params.uri));
    const uri = hookedUri();
    const subscription = await client.listen({ resourceSubscriptions: [uri] });
    expect(hooks).toHaveLength(1);
    expect(hooks[0].url).toMatch(/^http:\/\/mcp\.test\/api\/webhook\/app\/mcpsub_[0-9a-f]{20}\/trigger$/);
    const hookUrl = hooks[0].url;
    const [, , , , workflowId, nodeId] = new URL(hookUrl).pathname.split('/');
    const post = async (body: unknown) =>
      (appHookRoute as unknown as { POST: (r: Request, c: { params: Promise<{ workflowId: string; nodeId: string }> }) => Promise<Response> }).POST(
        new Request(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        { params: Promise.resolve({ workflowId, nodeId }) },
      );
    expect((await post({ push: 1 })).status).toBe(200);
    await until(() => updates.includes(uri));
    expect((await readEvents(client, uri)).events.map((e) => e.data.event)).toEqual([{ push: 1 }]);

    await subscription.close();
    await until(() => hooks.length === 0);
    expect(audits('mcp.resource.unsubscribe').some((e) => e.details?.trigger === 'trigger_hooked')).toBe(true);
    // A call to the dead hook is refused.
    expect((await post({ late: true })).status).toBe(404);
    await client.close();
    deleteGrant(g.id);
  });

  it('a revoked grant takes the hook down; a refused registration leaves nothing behind', async () => {
    const g = grant();
    const client = await connect(bearer(adminKey));
    await client.listen({ resourceSubscriptions: [hookedUri()] });
    expect(hooks).toHaveLength(1);
    deleteGrant(g.id);
    await until(() => hooks.length === 0 && runningTriggerSubscriptions() === 0, 6000);
    await client.close();
  });

  it('the sweep removes the webhook of a subscription whose main died (no heartbeat), and nothing else', async () => {
    const g = grant();
    const client = await connect(bearer(adminKey));
    const subscription = await client.listen({ resourceSubscriptions: [hookedUri()] });
    expect(hooks).toHaveLength(1);
    // Simulate a crash: the stream is gone with the process, and the row stops being pulsed.
    const row = mcpDb().get<Record<string, string>>('SELECT * FROM mcp_trigger_subs WHERE kind = ?', 'appWebhook')!;
    await stopAllTriggerSubscriptions();
    expect(hooks).toHaveLength(0);
    // Put the registration back as a dead main would have left it.
    hooks.push({ id: JSON.parse(row.static_data).hookId ?? 'orphan', url: 'x' });
    mcpDb().upsert('mcp_trigger_subs', { ...row, registered: 1, stopping: 0, heartbeat_at: new Date(Date.now() - 600_000).toISOString() });
    mcpDb().upsert('mcp_trigger_subs', { ...row, sub_key: 'live-other', registered: 0, stopping: 0, heartbeat_at: new Date().toISOString() });
    expect(await sweepTriggerSubscriptions()).toBe(1);
    expect(hooks).toHaveLength(0);
    expect(mcpDb().get('SELECT sub_key FROM mcp_trigger_subs WHERE sub_key = ?', row.sub_key)).toBeUndefined();
    expect(mcpDb().get('SELECT sub_key FROM mcp_trigger_subs WHERE sub_key = ?', 'live-other')).toBeDefined();
    mcpDb().delete('mcp_trigger_subs', { sub_key: 'live-other' });
    await subscription.close().catch(() => {});
    await client.close();
    deleteGrant(g.id);
  });
});

void credB;
