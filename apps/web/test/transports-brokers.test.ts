/**
 * Host messaging over brokers (lib/server/transports/brokers.ts, broker-provider.ts; docs/transports.md "Host side"),
 * with the in-memory driver registered as a test-only `memory` driver module so a host-side `MessagingClient` and a
 * plugin-side `MessagingServer` talk in-process:
 *
 * - a provider per driver kind, with the module's fields and example URL; without the shared secret every connection
 *   reports an error and nothing crashes;
 * - discovery: an announce on the broker adds `<kind>://<hostConnectionId>/<pluginId>` with source `broker` (the host's
 *   connection id, not the plugin's), the manifest comes over the broker, a withdraw or an expiry takes it offline;
 * - calls: a pinned policy routes Execute over the broker with the deadline, trace context, idempotency key and
 *   `at-least-once` only for idempotent nodes; the span carries the messaging attributes;
 * - fail-over: a provably undelivered call (too large for the broker) goes to another allowed transport once, a timeout
 *   never does, a pinned policy never does;
 * - stats and health in GET /api/plugins and GET /api/transports; Test makes a round trip;
 * - the connection lifecycle: edit reopens, disable closes, delete removes the endpoints.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type ExecuteRequest, type ExecuteResponse, type JsonValue, type PluginManifest } from '@landflow/protocol';
import { buildManifest, defineNode, definePlugin } from '@landflow/sdk';
import { DispatchError, Keyring, MessagingServer, type DispatchContext, type Method } from '@landflow/transports';
import type { DriverModule } from '@landflow/transports/drivers';
import { MemoryBroker, type MemoryConfig } from '@landflow/transports/memory';
import type { PluginSummary } from '@/lib/shared/types';
import type { TransportsResponse } from '@/lib/shared/transports';

vi.setConfig({ testTimeout: 20_000, hookTimeout: 30_000 });
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-brokers-'));
Object.assign(process.env, {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_ENCRYPTION_KEY: 'brokers-test-key',
  LANDFLOW_TRANSPORT_SECRET: 'brokers-test-transport-secret',
  LANDFLOW_REGISTRY_SECRET: 'brokers-test-registry-secret',
  LANDFLOW_EXECUTE_TIMEOUT_MS: '1500',
});

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { transportConnections, TransportConnections } = await import('@/lib/server/transports/connections');
const { transportProviders } = await import('@/lib/server/transports/provider');
const { transportPolicies } = await import('@/lib/server/transports/policy-store');
const { BrokerConnectionManager, brokerConnections, driverModules, roundTrip } = await import('@/lib/server/transports/brokers');
const { BrokerPluginClient, registerBrokerProviders } = await import('@/lib/server/transports/broker-provider');
const { tracePluginRpc } = await import('@/lib/server/telemetry');
const transportsRoute = await import('@/app/api/transports/route');
const pluginsRoute = await import('@/app/api/plugins/route');
type TransportProvider = import('@/lib/server/transports/provider').TransportProvider;
type PluginClient = import('@/lib/server/plugins/clients').PluginClient;

registry.registerBuiltin(corePlugin);

const PLUGIN_ID = 'tb-echo';
const CONNECTION_ID = 'tb-mem';
const ENDPOINT = `memory://${CONNECTION_ID}/${PLUGIN_ID}`;
const SLOW_ENDPOINT = `slow://stub/${PLUGIN_ID}`;
const until = (check: () => void, timeout = 8_000) => vi.waitFor(check, { timeout, interval: 25 });
const summary = () => registry.list().find((p) => p.id === PLUGIN_ID) as PluginSummary | undefined;
const endpointOf = (endpoint: string) => summary()?.endpoints.find((e) => e.endpoint === endpoint);

// One in-process broker (small messages, so a big request is provably undeliverable), shared by the host's clients and the plugin's server.
const broker = new MemoryBroker({ capabilities: { maxMessageBytes: 64 * 1024 } });
const memoryModule: DriverModule<MemoryConfig> = {
  kind: 'memory',
  label: 'Memory (test)',
  capabilities: broker.capabilities,
  fields: [{ name: 'note', label: 'Note', type: 'string', hint: 'Anything; changing it reopens the connection' }],
  exampleUrl: 'memory://local',
  create: () => broker.driver(),
  configFrom: (connectionId, _url, options) => ({ connectionId, ...(typeof options?.prefix === 'string' && { prefix: options.prefix }) }),
};

const plugin = definePlugin({
  info: { id: PLUGIN_ID, name: 'Broker Echo', version: '1.0.0' },
  nodes: [
    defineNode({
      description: { name: 'echo', displayName: 'Echo', description: '', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
      execute: (ctx) => ctx.getInputData(),
    }),
    defineNode({
      description: { name: 'upsert', displayName: 'Upsert', description: 'safe to repeat', version: 1, kind: 'action', idempotent: true, inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
      execute: (ctx) => ctx.getInputData(),
    }),
    defineNode({
      description: { name: 'slow', displayName: 'Slow', description: '', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
      execute: (ctx) => ctx.getInputData(),
    }),
  ],
});
const manifest: PluginManifest = buildManifest(plugin);

/** What the plugin side saw: the delivery mode and idempotency key per Execute, for the delivery-rule checks. */
const seen: Array<{ method: Method; node?: string; context: DispatchContext }> = [];
const dispatch = async (method: Method, body: JsonValue, ctx: DispatchContext): Promise<JsonValue> => {
  const request = body as unknown as ExecuteRequest;
  seen.push({ method, node: method === 'Execute' ? request.node.type : undefined, context: ctx });
  switch (method) {
    case 'GetManifest':
      return manifest as unknown as JsonValue;
    case 'Health':
      return { status: 'ok', uptimeMs: 1, pluginId: PLUGIN_ID, version: '1.0.0' };
    case 'LoadOptions':
      return { options: [{ name: 'A', value: 'a' }] };
    case 'Execute': {
      if (request.node.type.endsWith('.slow')) await new Promise((resolve) => setTimeout(resolve, 3_000));
      const response: ExecuteResponse = { outputs: [request.inputs[0]!.map((item) => ({ json: { ...item.json, via: 'memory', delivery: ctx.delivery } }))] };
      return response as unknown as JsonValue;
    }
    default:
      throw new DispatchError(`unsupported ${method}`, 'bad_request');
  }
};

const startServer = (options: Partial<ConstructorParameters<typeof MessagingServer>[0]> = {}) =>
  MessagingServer.start({
    driver: broker.driver(),
    // What the plugin calls its connection is not what the host calls it: the host registers its own id.
    config: { connectionId: 'plugin-side-name' },
    keyring: Keyring.fromEnv(),
    pluginId: PLUGIN_ID,
    version: '1.0.0',
    manifest,
    dispatch,
    announceIntervalMs: 200,
    ttlSeconds: 2,
    log: () => {},
    ...options,
  });

/** A second, slower transport kind the fail-over can go to: a direct stub answering from the manifest. */
let slowCalls = 0;
const slowProvider: TransportProvider = {
  kind: 'slow',
  label: 'Slow stub',
  direct: true,
  capabilities: { maxMessageBytes: 64 * 1024 * 1024, delivery: ['at-most-once'], latency: 'high', buffering: false },
  health: () => ({ ok: true }),
  createClient: (endpoint): PluginClient => ({
    endpoint,
    transport: 'slow',
    manifest: async () => manifest,
    execute: (request) =>
      tracePluginRpc('Execute', { system: 'slow', endpoint, pluginId: PLUGIN_ID }, async () => {
        slowCalls++;
        return { outputs: [request.inputs[0]!.map((item) => ({ json: { ...item.json, via: 'slow' } }))] };
      }),
    loadOptions: async () => [],
    testCredentials: async () => ({ ok: true }),
    webhookMethod: async () => ({ ok: true }),
    receiveWebhook: async () => ({ status: 200 }) as never,
    health: async () => ({ status: 'ok', uptimeMs: 1, pluginId: PLUGIN_ID, version: '1.0.0' }),
    close: () => {},
  }),
};

const execute = (node: string, json: Record<string, JsonValue> = { a: 1 }, extras?: { signal?: AbortSignal }) => {
  const resolved = registry.resolve(`${PLUGIN_ID}.${node}`);
  if ('error' in resolved) throw new Error(resolved.error);
  return resolved.execute(
    {
      protocol: PROTOCOL_VERSION,
      executionId: 'ex1',
      workflowId: 'wf1',
      mode: 'manual',
      node: { id: 'n1', name: node, type: `${PLUGIN_ID}.${node}`, typeVersion: 1 },
      parameters: {},
      itemParameters: [{}],
      inputs: [[{ json }]],
      idempotencyKey: 'ex1:n1:0',
    },
    extras,
  );
};

const spans = new InMemorySpanExporter();
let server: MessagingServer;

beforeAll(async () => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spans })] }));
  driverModules.register(memoryModule);
  transportProviders.register(slowProvider);
  await registerBrokerProviders();
  await brokerConnections.start(registry);
});

afterAll(async () => {
  await server?.stop().catch(() => {});
  await brokerConnections.stop();
  registry.remove(PLUGIN_ID);
  transportPolicies.remove(PLUGIN_ID);
  trace.disable();
});

describe('broker providers', () => {
  it('registers a provider per driver kind, with the module’s fields and example URL as the placeholder', () => {
    const memory = transportProviders.kinds().find((k) => k.kind === 'memory');
    expect(memory).toMatchObject({ installed: true, direct: false, label: 'Memory (test)', capabilities: { delivery: ['at-most-once', 'at-least-once'], latency: 'low', buffering: true, maxMessageBytes: 64 * 1024 } });
    expect(memory?.fields.map((f) => f.name)).toEqual(['url', 'username', 'password', 'tls', 'note']);
    expect(memory?.fields[0]?.placeholder).toBe('memory://local');
    // A broker kind is installed exactly when a driver module exists for it; the rest stay "driver in a later release".
    const modules = driverModules.kinds();
    for (const kind of transportProviders.kinds().filter((k) => !k.direct)) expect({ kind: kind.kind, installed: kind.installed }).toEqual({ kind: kind.kind, installed: modules.includes(kind.kind) });
    expect(() => new BrokerPluginClient('http://127.0.0.1:7101')).toThrow(/not a brokered endpoint/);
  });

  it('without the shared secret, connections report an error with a clear message and nothing crashes', async () => {
    const connections = new TransportConnections({ env: {} });
    const created = connections.create({ name: 'TMP no secret', kind: 'memory', config: { url: 'memory://x' } });
    const withdrawn: string[] = [];
    const manager = new BrokerConnectionManager({ connections, env: {}, discovery: { addEndpoint: async () => undefined, withdraw: (e) => Boolean(withdrawn.push(e)), removeEndpoint: () => true }, probeIntervalMs: 0 });
    try {
      await manager.start();
      expect(manager.hasSecret).toBe(false);
      expect(manager.health(created.id)).toMatchObject({ state: 'error', message: expect.stringContaining('LANDFLOW_TRANSPORT_SECRET') });
      expect(manager.providerHealth('memory')).toMatchObject({ ok: false, message: expect.stringContaining('LANDFLOW_TRANSPORT_SECRET') });
      expect(manager.clientFor(created.id)).toBeUndefined();
      // A client for an endpoint on it fails provably undelivered, with the reason.
      await expect(new BrokerPluginClient(`memory://${created.id}/p`, manager).health()).rejects.toMatchObject({ reason: 'not_connected', message: expect.stringContaining('LANDFLOW_TRANSPORT_SECRET') });
    } finally {
      await manager.stop();
      connections.delete(created.id);
    }
  });
});

describe('the claim store setting', () => {
  const manager = (env: NodeJS.ProcessEnv) => new BrokerConnectionManager({ connections: new TransportConnections({ env: {} }), env, probeIntervalMs: 0 });

  it('is read from LANDFLOW_CLAIM_STORE, never shows credentials, and a bad setting is reported instead of crashing', () => {
    const none = manager({});
    none.loadKeyring();
    expect(none.claimStoreInfo()).toEqual({ configured: false });
    const s3 = manager({ LANDFLOW_CLAIM_STORE: 's3://landflow/claims?endpoint=http://127.0.0.1:59000', LANDFLOW_CLAIM_SECRET_ACCESS_KEY: 'do-not-show' });
    s3.loadKeyring();
    expect(s3.claimStoreInfo()).toEqual({ configured: true, description: 's3://landflow/claims @ http://127.0.0.1:59000' });
    const unsafe = manager({ LANDFLOW_CLAIM_STORE: 's3://landflow/claims' });
    unsafe.loadKeyring();
    expect(unsafe.claimStoreInfo()).toMatchObject({ configured: false, error: expect.stringContaining('refusing to use the default') });
  });
});

describe('discovery and calls over the broker', () => {
  beforeAll(async () => {
    transportConnections.create({ id: CONNECTION_ID, name: 'TMP memory', kind: 'memory', config: { url: 'memory://local', note: 'one' } });
    await until(() => expect(brokerConnections.openConnections()).toContain(CONNECTION_ID));
    server = await startServer();
    await registry.addEndpoint(SLOW_ENDPOINT, 'manual');
  });

  it('an announce on the broker registers the brokered endpoint under the host’s connection id, source broker, manifest pulled over the broker', async () => {
    await until(() => expect(endpointOf(ENDPOINT)).toMatchObject({ source: 'broker', status: 'online', transport: 'memory' }));
    expect(summary()?.endpoints.map((e) => e.endpoint).sort()).toEqual([ENDPOINT, SLOW_ENDPOINT].sort());
    expect(seen.some((s) => s.method === 'GetManifest')).toBe(true);
    expect(summary()?.transports?.find((t) => t.kind === 'memory')).toMatchObject({ online: true, endpoints: [ENDPOINT] });
    // The connection knows the plugin and is healthy.
    const view = (await (await transportsRoute.GET(new Request('http://landflow.test/api/transports'), {} as never)).json()) as TransportsResponse;
    const connection = view.connections.find((c) => c.id === CONNECTION_ID);
    expect(connection).toMatchObject({ plugins: [PLUGIN_ID], health: { state: 'connected', hostInstanceId: brokerConnections.hostInstanceId } });
    expect(connection?.health?.roundTripMs).toBeGreaterThanOrEqual(0);
    expect(view.kinds.find((k) => k.kind === 'memory')?.health).toMatchObject({ ok: true });
  });

  it('a pinned policy routes Execute over the broker: deadline, idempotency key, trace context, at-least-once only for idempotent nodes', async () => {
    transportPolicies.set(PLUGIN_ID, { mode: 'pinned', pinned: 'memory' });
    expect(registry.select(PLUGIN_ID)).toMatchObject({ endpoint: ENDPOINT, kind: 'memory', reason: 'pinned' });
    seen.length = 0;
    spans.reset();
    const plain = await execute('echo');
    expect(plain.outputs[0]?.[0]?.json).toMatchObject({ a: 1, via: 'memory', delivery: 'at-most-once' });
    const safe = await execute('upsert');
    expect(safe.outputs[0]?.[0]?.json).toMatchObject({ via: 'memory', delivery: 'at-least-once' });
    const executes = seen.filter((s) => s.method === 'Execute');
    expect(executes.map((s) => s.context.delivery)).toEqual(['at-most-once', 'at-least-once']);
    for (const call of executes) {
      expect(call.context.idempotencyKey).toBe('ex1:n1:0');
      expect(call.context.deadline).toBeGreaterThan(Date.now());
      expect(call.context.deadline).toBeLessThanOrEqual(Date.now() + 1_500);
      expect(call.context.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    }
    const rpc = spans.getFinishedSpans().filter((s) => s.name === 'plugin.rpc Execute');
    expect(rpc).toHaveLength(2);
    expect(rpc[0]?.attributes).toMatchObject({
      'rpc.system': 'memory',
      'landflow.transport': 'memory',
      'landflow.transport.reason': 'pinned',
      'landflow.plugin.id': PLUGIN_ID,
      'messaging.system': 'memory',
      'messaging.destination.name': `landflow.v1.plugin.${PLUGIN_ID}`,
      'messaging.operation.type': 'send',
    });
    // LoadOptions goes over the broker too, at least once.
    expect(await registry.loadOptions(`${PLUGIN_ID}.echo`, 'm', {})).toEqual([{ name: 'A', value: 'a' }]);
    expect(seen.at(-1)).toMatchObject({ method: 'LoadOptions', context: { delivery: 'at-least-once' } });
  });

  it('exposes the broker’s numbers: instances × maxConcurrency and the request channel’s depth and consumers', async () => {
    await brokerConnections.clientFor(CONNECTION_ID)!.sampleStats();
    const plugins = ((await (await pluginsRoute.GET(new Request('http://landflow.test/api/plugins'), {} as never)).json()) as { plugins: PluginSummary[] }).plugins;
    const p = plugins.find((x) => x.id === PLUGIN_ID)!;
    const endpoint = p.endpoints.find((e) => e.endpoint === ENDPOINT)!;
    expect(endpoint.queue).toMatchObject({ instances: 1, maxConcurrency: manifest.maxConcurrency ?? 16, depth: 0, consumers: expect.any(Number) });
    expect(endpoint.queue?.consumers).toBeGreaterThan(0);
    expect(endpoint.queue?.sampledAt).toBeDefined();
    expect(p.transports?.find((t) => t.kind === 'memory')?.stats).toMatchObject({ instances: 1, depth: 0 });
    // The direct stub has no queue and nothing announced its concurrency: no numbers rather than made-up ones.
    expect(p.endpoints.find((e) => e.endpoint === SLOW_ENDPOINT)?.queue).toBeUndefined();
    expect(p.transports?.find((t) => t.kind === 'slow')?.stats).toBeUndefined();
  });

  it('skips a broker the call is too big for (auto.size), never retries a timeout, and a pinned call has nowhere to go', async () => {
    // Auto prefers the low-latency memory broker over the high-latency stub; a request too big for the broker is skipped before
    // publishing (rule 1: the registry knows the request's size since the Auto wave), so the call goes straight to the stub.
    transportPolicies.set(PLUGIN_ID, { mode: 'auto', allowed: ['memory', 'slow'] });
    expect(registry.select(PLUGIN_ID)).toMatchObject({ kind: 'memory', reason: 'auto.latency' });
    const big = { blob: 'x'.repeat(100 * 1024) };
    slowCalls = 0;
    spans.reset();
    const response = await execute('echo', big);
    expect(response.outputs[0]?.[0]?.json).toMatchObject({ via: 'slow' });
    expect(slowCalls).toBe(1);
    const rpc = spans.getFinishedSpans().filter((s) => s.name === 'plugin.rpc Execute');
    expect(rpc.map((s) => [s.attributes['landflow.transport'], s.attributes['landflow.transport.reason']])).toEqual([['slow', 'auto.size']]);
    // A timeout may have run: it fails the node, no second try.
    slowCalls = 0;
    await expect(execute('slow')).rejects.toThrow(/may have run/);
    expect(slowCalls).toBe(0);
    // Pinned: nowhere to go.
    transportPolicies.set(PLUGIN_ID, { mode: 'pinned', pinned: 'memory' });
    await expect(execute('echo', big)).rejects.toThrow(/too_large|at most 65536|bytes/);
    expect(slowCalls).toBe(0);
  });

  it('aborting a call in flight cancels it on the plugin and fails the node without a second try', async () => {
    transportPolicies.set(PLUGIN_ID, { mode: 'auto', allowed: ['memory', 'slow'] });
    slowCalls = 0;
    seen.length = 0;
    const controller = new AbortController();
    const pending = execute('slow', { a: 1 }, { signal: controller.signal });
    await until(() => expect(seen.filter((s) => s.node?.endsWith('.slow')).length).toBeGreaterThan(0));
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(slowCalls).toBe(0);
    await until(() => expect(server.counters.cancelled).toBeGreaterThan(0));
    // Aborted before it was published: not delivered, but not something to run elsewhere either.
    const early = new AbortController();
    early.abort();
    await expect(execute('echo', { a: 1 }, { signal: early.signal })).rejects.toThrow(/abort/);
    expect(slowCalls).toBe(0);
  });

  it('Test makes a round trip through the form’s config and reports the latency', async () => {
    const check = await transportConnections.test(CONNECTION_ID);
    expect(check).toMatchObject({ ok: true, message: expect.stringContaining('round trip') });
    expect(check.latencyMs).toBeGreaterThanOrEqual(0);
    const unsaved = await transportConnections.test('new', { kind: 'memory', name: 'TMP form', config: { url: 'memory://form' } });
    expect(unsaved.ok).toBe(true);
    expect(transportConnections.get('new')).toBeUndefined();
    const probe = await roundTrip(await connected(), undefined, 1_000);
    expect(probe.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('a withdraw takes the endpoint offline; a plugin whose heartbeats stop expires', async () => {
    await server.stop();
    await until(() => expect(endpointOf(ENDPOINT)?.status).toBe('offline'));
    expect(registry.select(PLUGIN_ID)).toMatchObject({ kind: 'slow', reason: 'only' });
    // Back, then silent: announces once with a 2 s lease and never again.
    server = await startServer({ announceIntervalMs: 600_000 });
    await until(() => expect(endpointOf(ENDPOINT)?.status).toBe('online'));
    await until(() => expect(endpointOf(ENDPOINT)).toMatchObject({ status: 'offline', lastError: expect.stringContaining('stopped heartbeating') }));
    await server.stop();
    server = await startServer();
    await until(() => expect(endpointOf(ENDPOINT)?.status).toBe('online'));
  });

  it('editing the connection reopens it (the endpoint comes back with the plugin’s next announce), disabling closes it, deleting removes the endpoint', async () => {
    const before = brokerConnections.clientFor(CONNECTION_ID)!;
    transportConnections.update(CONNECTION_ID, { config: { url: 'memory://local', note: 'two' } });
    await until(() => {
      const after = brokerConnections.clientFor(CONNECTION_ID);
      expect(after).toBeDefined();
      expect(after).not.toBe(before);
    });
    expect(brokerConnections.clientFor(CONNECTION_ID)?.hostInstanceId).toBe(before.hostInstanceId);
    await until(() => expect(endpointOf(ENDPOINT)?.status).toBe('online'));
    expect((await execute('echo')).outputs[0]?.[0]?.json).toMatchObject({ via: 'memory' });

    transportConnections.update(CONNECTION_ID, { enabled: false });
    await until(() => expect(brokerConnections.clientFor(CONNECTION_ID)).toBeUndefined());
    expect(endpointOf(ENDPOINT)?.status).toBe('offline');
    expect(brokerConnections.health(CONNECTION_ID)).toBeUndefined();
    expect(brokerConnections.providerHealth('memory')).toMatchObject({ ok: true, message: 'No enabled connection yet' });
    // A client made for the endpoint while it is closed: provably undelivered.
    await expect(new BrokerPluginClient(ENDPOINT).health()).rejects.toMatchObject({ reason: 'not_connected' });

    transportConnections.update(CONNECTION_ID, { enabled: true });
    await until(() => expect(endpointOf(ENDPOINT)?.status).toBe('online'));

    expect(transportConnections.delete(CONNECTION_ID)).toBe(true);
    await until(() => expect(endpointOf(ENDPOINT)).toBeUndefined());
    expect(summary()?.endpoints.map((e) => e.endpoint)).toEqual([SLOW_ENDPOINT]);
  });
});

/** A connected memory driver of its own, for the round-trip helper. */
async function connected() {
  const driver = broker.driver();
  await driver.connect({ connectionId: 'probe' });
  return driver;
}
