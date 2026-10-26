/**
 * The host transport layer (lib/server/transports, docs/transports.md "Host side"):
 *
 * - the per-plugin policy in the database (policy-store.ts, migration 1700): defaults, normalization, the older
 *   `preferredTransport` reading (a transport pins the policy), rows gone when back to the default, the cache dropped
 *   on changes from elsewhere;
 * - the selector (selector.ts): pinned, the allow-list, `only`, the direct preference as `auto.latency`, size skips,
 *   and the errors when nothing fits;
 * - broker connections (connections.ts, migration 1701): CRUD with secrets sealed like credentials and never shown,
 *   read-only rows from LANDFLOW_TRANSPORT_<KIND>_URL, Test without a driver ("No driver for … yet") and through a
 *   registered provider, audit events like other settings changes;
 * - the routes: GET /api/transports, /api/transports/connections CRUD and test, PATCH /api/plugins/:id with the new
 *   `policy` body and the old `preferredTransport` one;
 * - the registry through the selector: a plugin on HTTP (7440) and gRPC (7441) is executed over the chosen transport,
 *   the `plugin.rpc` span carries `landflow.transport` and `landflow.transport.reason`, and pinning an offline kind
 *   makes the plugin unavailable with a clear error.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@landflow/protocol';
import type { grpc } from '@landflow/protocol/grpc';
import { defineNode, definePlugin } from '@landflow/sdk';
import type { PluginSummary } from '@/lib/shared/types';
import type { TransportConnectionCheck, TransportConnectionView, TransportsResponse } from '@/lib/shared/transports';

vi.setConfig({ testTimeout: 20_000 });
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-transports-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_ENCRYPTION_KEY: 'transports-test-key' });
delete process.env.LANDFLOW_TRANSPORT_KAFKA_URL;

const { database } = await import('@/lib/server/db');
const { emitTablesChanged } = await import('@/lib/server/db/replication');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { queryEvents } = await import('@/lib/server/audit/store');
const { isDefaultPolicy, normalizePolicy, policyFromPreferred, TransportPolicyStore, transportPolicies, transportPolicySchema } = await import('@/lib/server/transports/policy-store');
const { isChoice, runModeOf, select, staticRank } = await import('@/lib/server/transports/selector');
const { envConnections, TransportConnections, transportConnections, TransportError, viewOf } = await import('@/lib/server/transports/connections');
const { brokeredEndpoint, endpointKind, transportProviders } = await import('@/lib/server/transports/provider');
const { driverModules } = await import('@/lib/server/transports/brokers');
const { createFetchHandler } = await import('@landflow/sdk/http');
const { serveGrpc } = await import('@landflow/sdk/grpc');
const transportsRoute = await import('@/app/api/transports/route');
const connectionsRoute = await import('@/app/api/transports/connections/route');
const connectionRoute = await import('@/app/api/transports/connections/[id]/route');
const connectionTestRoute = await import('@/app/api/transports/connections/[id]/test/route');
const pluginRoute = await import('@/app/api/plugins/[id]/route');
type TransportProvider = import('@/lib/server/transports/provider').TransportProvider;
type Candidate = import('@/lib/server/transports/selector').Candidate;

registry.registerBuiltin(corePlugin);

const HTTP_PORT = 7440;
const GRPC_PORT = 7441;
const PLUGIN_ID = 'tp-echo';

/** Set a registered provider aside (so its kind reads as "not installed") and return the function that puts it back. */
const withoutProvider = (kind: string) => {
  const real = transportProviders.get(kind);
  if (!real) return () => {};
  transportProviders.register({ ...real })(); // registering a copy and unregistering it removes the kind
  return () => void transportProviders.register(real);
};

const request = (body?: unknown, method = 'POST') => new Request('http://landflow.test/api', { method, ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const online = (endpoint: string, kind: string): Candidate => ({ endpoint, kind, status: 'online' });
const offline = (endpoint: string, kind: string): Candidate => ({ endpoint, kind, status: 'offline' });
const AUTO = { mode: 'auto' as const, objective: 'balanced' as const };

// ---------------------------------------------------------------------------
// Policy store
// ---------------------------------------------------------------------------

describe('transport policy store', () => {
  it('answers Auto/balanced for a plugin without a row and stores only non-default policies', () => {
    const store = new TransportPolicyStore();
    expect(store.get('nobody')).toEqual(AUTO);
    expect(store.set('p1', { mode: 'pinned', pinned: 'grpc' })).toEqual({ mode: 'pinned', pinned: 'grpc', objective: 'balanced' });
    expect(database().get<{ policy: string }>('SELECT policy FROM plugin_transport_policies WHERE plugin_id = ?', 'p1')?.policy).toContain('"pinned":"grpc"');
    expect(store.get('p1')).toEqual({ mode: 'pinned', pinned: 'grpc', objective: 'balanced' });
    // Back to the default: the row goes.
    store.set('p1', { mode: 'auto' });
    expect(database().get('SELECT 1 FROM plugin_transport_policies WHERE plugin_id = ?', 'p1')).toBeUndefined();
    expect(store.get('p1')).toEqual(AUTO);
  });

  it('normalizes: pinned only with mode pinned, allow-list deduplicated and dropped when empty', () => {
    expect(normalizePolicy({ mode: 'auto', pinned: 'grpc', allowed: ['http', 'http', 'grpc'] })).toEqual({ mode: 'auto', allowed: ['http', 'grpc'], objective: 'balanced' });
    expect(normalizePolicy({ mode: 'pinned', pinned: 'http', allowed: [], objective: 'latency' })).toEqual({ mode: 'pinned', pinned: 'http', objective: 'latency' });
    expect(isDefaultPolicy(normalizePolicy({}))).toBe(true);
    expect(isDefaultPolicy(normalizePolicy({ objective: 'throughput' }))).toBe(false);
  });

  it('reads the older preferredTransport as a pinned policy, and none as Auto, keeping the objective', () => {
    expect(policyFromPreferred('grpc')).toEqual({ mode: 'pinned', pinned: 'grpc', objective: 'balanced' });
    expect(policyFromPreferred(null, { mode: 'pinned', pinned: 'grpc', objective: 'latency' })).toEqual({ mode: 'auto', objective: 'latency' });
    expect(policyFromPreferred('http', { mode: 'auto', allowed: ['http', 'grpc'], objective: 'balanced' })).toEqual({ mode: 'pinned', pinned: 'http', allowed: ['http', 'grpc'], objective: 'balanced' });
  });

  it('validates the PATCH body: pinned needs a kind, the allow-list is non-empty and holds the pinned kind', () => {
    expect(transportPolicySchema.safeParse({ mode: 'pinned' }).success).toBe(false);
    expect(transportPolicySchema.safeParse({ mode: 'auto', allowed: [] }).success).toBe(false);
    expect(transportPolicySchema.safeParse({ mode: 'pinned', pinned: 'kafka', allowed: ['http'] }).success).toBe(false);
    expect(transportPolicySchema.safeParse({ mode: 'pinned', pinned: 'HTTP' }).success).toBe(false);
    expect(transportPolicySchema.parse({})).toEqual(AUTO);
    expect(transportPolicySchema.parse({ mode: 'auto', allowed: ['nats', 'grpc'], objective: 'throughput' })).toEqual({ mode: 'auto', allowed: ['nats', 'grpc'], objective: 'throughput' });
  });

  it('drops its cache when another process changes the table', () => {
    const store = new TransportPolicyStore();
    expect(store.get('p2')).toEqual(AUTO);
    // Written past this store (another process in queue mode): the cache still says Auto…
    database().upsert('plugin_transport_policies', { plugin_id: 'p2', policy: JSON.stringify({ mode: 'pinned', pinned: 'http' }), updated_at: new Date().toISOString(), updated_by: null });
    expect(store.get('p2')).toEqual(AUTO);
    // …until the replication notice arrives.
    emitTablesChanged({ tables: new Set(['plugin_transport_policies']), keys: new Map() });
    expect(store.get('p2')).toEqual({ mode: 'pinned', pinned: 'http', objective: 'balanced' });
    expect(store.list()).toMatchObject({ p2: { mode: 'pinned' } });
    store.remove('p2');
  });
});

// ---------------------------------------------------------------------------
// Selector
// ---------------------------------------------------------------------------

describe('selector', () => {
  const grpcEp = online('grpc://127.0.0.1:7201', 'grpc');
  const httpEp = online('http://127.0.0.1:7101', 'http');
  const kafkaEp = online('kafka://kafka-main/p', 'kafka');
  const natsEp = online('nats://nats-main/p', 'nats');
  const capabilities = (kind: string) =>
    ({
      http: { maxMessageBytes: 64 * 1024 * 1024, delivery: ['at-most-once'], latency: 'low', buffering: false },
      grpc: { maxMessageBytes: 64 * 1024 * 1024, delivery: ['at-most-once'], latency: 'low', buffering: false },
      kafka: { maxMessageBytes: 1024 * 1024, delivery: ['at-most-once', 'at-least-once'], latency: 'high', buffering: true },
      nats: { maxMessageBytes: 1024 * 1024, delivery: ['at-most-once'], latency: 'low', buffering: false },
    })[kind] as import('@/lib/shared/transports').TransportCapabilities | undefined;
  const exec = { method: 'Execute' as const };

  it('prefers gRPC, then HTTP, then brokers by latency prior, as auto.latency', () => {
    expect(select('p', [httpEp, grpcEp], AUTO, exec)).toEqual({ endpoint: grpcEp.endpoint, kind: 'grpc', reason: 'auto.latency' });
    expect(select('p', [kafkaEp, httpEp], AUTO, exec)).toMatchObject({ kind: 'http', reason: 'auto.latency' });
    expect(select('p', [kafkaEp, natsEp], AUTO, exec, { capabilities })).toMatchObject({ kind: 'nats', reason: 'auto.latency' });
    expect(staticRank('grpc', {})).toBeLessThan(staticRank('http', {}));
    expect(staticRank('http', {})).toBeLessThan(staticRank('kafka', { capabilities }));
  });

  it('pins, and fails clearly when the pinned kind is offline', () => {
    expect(select('p', [httpEp, grpcEp], { mode: 'pinned', pinned: 'http', objective: 'balanced' }, exec)).toEqual({ endpoint: httpEp.endpoint, kind: 'http', reason: 'pinned' });
    const result = select('p', [grpcEp, offline(httpEp.endpoint, 'http')], { mode: 'pinned', pinned: 'http', objective: 'balanced' }, exec);
    expect(isChoice(result)).toBe(false);
    expect(result).toEqual({ error: 'Plugin "p" is pinned to http, but no http endpoint is online' });
  });

  it('filters by the allow-list and answers `only` when one kind is left', () => {
    expect(select('p', [httpEp, grpcEp, kafkaEp], { mode: 'auto', allowed: ['http'], objective: 'balanced' }, exec)).toMatchObject({ kind: 'http', reason: 'only' });
    expect(select('p', [httpEp, grpcEp, kafkaEp], { mode: 'auto', allowed: ['http', 'kafka'], objective: 'balanced' }, exec)).toMatchObject({ kind: 'http', reason: 'auto.latency' });
    expect(select('p', [httpEp], AUTO, exec)).toMatchObject({ kind: 'http', reason: 'only' });
    expect(select('p', [httpEp, grpcEp], { mode: 'auto', allowed: ['nats'], objective: 'balanced' }, exec)).toEqual({ error: 'Plugin "p": none of its allowed transports (nats) is online' });
  });

  it('skips transports the call is too large for (auto.size) and says when nothing fits', () => {
    expect(select('p', [kafkaEp, httpEp], AUTO, { ...exec, payloadBytes: 2 * 1024 * 1024 }, { capabilities })).toMatchObject({ kind: 'http', reason: 'auto.size' });
    expect(select('p', [kafkaEp, natsEp], AUTO, { ...exec, payloadBytes: 2 * 1024 * 1024 }, { capabilities })).toEqual({ error: 'Plugin "p": the call (2097152 bytes) is too large for every online transport' });
    // Small enough: the usual order.
    expect(select('p', [kafkaEp, httpEp], AUTO, { ...exec, payloadBytes: 512 }, { capabilities })).toMatchObject({ kind: 'http', reason: 'auto.latency' });
  });

  it('reports offline plugins and maps execution modes to run modes', () => {
    expect(select('p', [offline(httpEp.endpoint, 'http')], AUTO, exec)).toEqual({ error: 'Plugin "p" is offline — start it or check its endpoint' });
    expect(select('p', [], AUTO, exec)).toEqual({ error: 'Plugin "p" has no endpoint' });
    expect(runModeOf('manual')).toBe('manual');
    expect(runModeOf('mcp')).toBe('mcp');
    expect(runModeOf('trigger')).toBe('production');
    expect(runModeOf(undefined)).toBe('production');
  });
});

// ---------------------------------------------------------------------------
// Providers and endpoints
// ---------------------------------------------------------------------------

describe('transport providers', () => {
  it('registers the direct kinds and lists the broker kinds without a driver', () => {
    const kinds = transportProviders.kinds();
    expect(kinds.find((k) => k.kind === 'grpc')).toMatchObject({ direct: true, installed: true, fields: [] });
    expect(kinds.find((k) => k.kind === 'http')).toMatchObject({ direct: true, installed: true });
    expect(kinds.find((k) => k.kind === 'kafka')).toMatchObject({ direct: false, installed: false });
    expect(kinds.find((k) => k.kind === 'kafka')?.fields.map((f) => f.name)).toEqual(['url', 'username', 'password', 'tls']);
    expect(endpointKind('https://plugins.example.com')).toBe('http');
    expect(endpointKind('grpc://10.0.0.5:7204')).toBe('grpc');
    expect(endpointKind('kafka://kafka-main/twilio')).toBe('kafka');
    expect(brokeredEndpoint('kafka://kafka-main/twilio')).toEqual({ kind: 'kafka', connectionId: 'kafka-main', pluginId: 'twilio' });
    expect(brokeredEndpoint('http://127.0.0.1:7101')).toBeUndefined();
    expect(() => transportProviders.createClient('kafka://kafka-main/twilio')).toThrow(/No transport provider for "kafka"/);
    expect(transportProviders.createClient('http://127.0.0.1:7101').transport).toBe('http');
    expect(transportProviders.createClient('grpc://127.0.0.1:7201').transport).toBe('grpc');
  });
});

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

describe('broker connections', () => {
  it('stores secrets sealed, shows only which are set, and keeps or clears them on update', () => {
    const created = transportConnections.create({ name: 'Kafka main', kind: 'kafka', config: { url: 'kafka://127.0.0.1:59092', username: 'host', tls: false }, secrets: { password: 's3cret-pw' } });
    expect(created.id).toBe('kafka-main');
    const raw = database().get<{ secrets: string | null; config: string }>('SELECT secrets, config FROM transport_connections WHERE id = ?', created.id)!;
    expect(raw.secrets).toMatch(/^v1\./);
    expect(raw.secrets).not.toContain('s3cret-pw');
    expect(raw.config).not.toContain('s3cret-pw');
    expect(transportConnections.get('kafka-main')?.secrets).toEqual({ password: 's3cret-pw' });

    const view = viewOf(created);
    expect(view).toMatchObject({ id: 'kafka-main', kind: 'kafka', enabled: true, source: 'database', secretsSet: ['password'], config: { url: 'kafka://127.0.0.1:59092', username: 'host', tls: false }, plugins: [] });
    expect(JSON.stringify(view)).not.toContain('s3cret-pw');

    // An empty secret keeps the saved one; null clears it.
    expect(transportConnections.update('kafka-main', { secrets: { password: '' }, config: { url: 'kafka://127.0.0.1:59093' } }).secrets).toEqual({ password: 's3cret-pw' });
    expect(transportConnections.get('kafka-main')?.config).toEqual({ url: 'kafka://127.0.0.1:59093' });
    expect(transportConnections.update('kafka-main', { secrets: { password: null } }).secrets).toEqual({});
    expect(database().get<{ secrets: string | null }>('SELECT secrets FROM transport_connections WHERE id = ?', 'kafka-main')?.secrets).toBeNull();
  });

  it('refuses duplicates, direct kinds, unknown kinds and kind changes', () => {
    expect(() => transportConnections.create({ name: 'Kafka main', kind: 'kafka' })).toThrow(TransportError);
    expect(() => transportConnections.create({ name: 'Other', kind: 'kafka', id: 'kafka-main' })).toThrow(/already exists/);
    expect(() => transportConnections.create({ name: 'Direct', kind: 'grpc' })).toThrow(/direct transport/);
    expect(() => transportConnections.create({ name: 'Weird', kind: 'carrier-pigeon' })).toThrow(/Unknown transport kind/);
    expect(() => transportConnections.update('kafka-main', { kind: 'nats' })).toThrow(/can’t change/);
    expect(() => transportConnections.update('missing', { enabled: false })).toThrow(/not found/);
  });

  it('answers "No driver … yet" for a kind without a provider, and tests through a registered provider', async () => {
    const check = await transportConnections.test('kafka-main');
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/^No driver for Kafka yet/);
    expect(transportConnections.get('kafka-main')?.lastCheck).toMatchObject({ ok: false });

    const seen: Array<import('@/lib/server/transports/provider').TransportConnectionConfig> = [];
    const fakeNats: TransportProvider = {
      kind: 'nats',
      label: 'NATS (fake)',
      direct: false,
      capabilities: { maxMessageBytes: 1024 * 1024, delivery: ['at-most-once'], latency: 'low', buffering: false },
      createClient: () => {
        throw new Error('not in this test');
      },
      health: () => ({ ok: true }),
      test: async (connection) => {
        seen.push(connection);
        return connection.secrets.token === 'tok' ? { ok: true, message: 'pong', version: '2.10' } : { ok: false, message: 'authorization violation' };
      },
    };
    const unregister = transportProviders.register(fakeNats);
    try {
      expect(transportProviders.kinds().find((k) => k.kind === 'nats')).toMatchObject({ installed: true, label: 'NATS (fake)' });
      const nats = transportConnections.create({ name: 'NATS main', kind: 'nats', config: { url: 'nats://127.0.0.1:54222' }, secrets: { token: 'tok' } });
      const ok = await transportConnections.test(nats.id);
      expect(ok).toMatchObject({ ok: true, message: 'pong', version: '2.10' });
      expect(typeof ok.latencyMs).toBe('number');
      expect(seen.at(-1)).toEqual({ id: 'nats-main', kind: 'nats', config: { url: 'nats://127.0.0.1:54222' }, secrets: { token: 'tok' } });
      // The form's Test before Save: unsaved values, secrets left empty fall back to the saved ones.
      expect(await transportConnections.test('nats-main', { config: { url: 'nats://127.0.0.1:54223' }, secrets: { token: '' } })).toMatchObject({ ok: true });
      expect(seen.at(-1)?.config).toEqual({ url: 'nats://127.0.0.1:54223' });
      expect(await transportConnections.test('new', { kind: 'nats', config: { url: 'nats://127.0.0.1:54222' }, secrets: { token: 'wrong' } })).toMatchObject({ ok: false, message: 'authorization violation' });
      expect(transportConnections.get('new')).toBeUndefined();
      expect(transportConnections.delete(nats.id)).toBe(true);
    } finally {
      unregister();
    }
    expect(transportProviders.kinds().find((k) => k.kind === 'nats')).toMatchObject({ installed: false });
  });

  it('lists LANDFLOW_TRANSPORT_<KIND>_URL as read-only connections, user info split into secrets', () => {
    const env = { LANDFLOW_TRANSPORT_KAFKA_URL: 'kafka://host%40user:p%3Aw@127.0.0.1:59092,127.0.0.1:59093', LANDFLOW_TRANSPORT_AMQP_URL: ' amqp://127.0.0.1:55672 ', LANDFLOW_TRANSPORT_HTTP_URL: 'http://ignored', LANDFLOW_TRANSPORT_NATS_URL: '' };
    const rows = envConnections(env);
    expect(rows.map((r) => r.id)).toEqual(['env-amqp', 'env-kafka']);
    expect(rows[1]).toMatchObject({ kind: 'kafka', source: 'env', enabled: true, config: { url: 'kafka://127.0.0.1:59092,127.0.0.1:59093' }, secrets: { username: 'host@user', password: 'p:w' } });
    expect(rows[0]).toMatchObject({ kind: 'amqp', config: { url: 'amqp://127.0.0.1:55672' }, secrets: {} });

    const store = new TransportConnections({ env });
    expect(store.list().map((c) => c.id)).toEqual(['kafka-main', 'env-amqp', 'env-kafka']);
    expect(store.get('env-kafka')?.name).toBe('Kafka (environment)');
    expect(() => store.update('env-kafka', { enabled: false })).toThrow(/comes from the environment/);
    expect(() => store.delete('env-kafka')).toThrow(/comes from the environment/);
    expect(() => store.create({ name: 'x', kind: 'kafka', id: 'env-kafka' })).toThrow(/doesn’t start with “env-”/);
  });

  it('records audit events like other settings changes', () => {
    const events = queryEvents({ action: ['settings.update'], targetId: 'transports' }, { limit: 50 }).events;
    expect(events.some((e) => e.summary === 'Added transport connection Kafka main (Kafka)' && e.details?.connectionId === 'kafka-main')).toBe(true);
    expect(events.some((e) => e.summary === 'Removed transport connection NATS main')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('s3cret-pw');
    expect(JSON.stringify(events)).not.toContain('tok"');
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe('routes', () => {
  it('GET /api/transports lists kinds and connections with the plugins on each', async () => {
    const response = await transportsRoute.GET(request(undefined, 'GET'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as TransportsResponse;
    expect(body.kinds.map((k) => k.kind).slice(0, 2)).toEqual(['http', 'grpc']);
    expect(body.kinds.find((k) => k.kind === 'kafka')).toMatchObject({ installed: true, direct: false });
    // Every broker kind with a driver module is installed; a kind whose module is missing is listed as not installed.
    const modules = driverModules.kinds();
    for (const kind of body.kinds.filter((k) => !k.direct)) expect({ kind: kind.kind, installed: kind.installed }).toEqual({ kind: kind.kind, installed: modules.includes(kind.kind) });
    const restore = withoutProvider('pulsar');
    try {
      const again = (await (await transportsRoute.GET(request(undefined, 'GET'))).json()) as TransportsResponse;
      expect(again.kinds.find((k) => k.kind === 'pulsar')).toMatchObject({ installed: false, direct: false });
    } finally {
      restore();
    }
    expect(body.connections).toEqual([expect.objectContaining({ id: 'kafka-main', secretsSet: [], plugins: [] })]);
  });

  it('creates, reads, changes, tests and deletes a connection; the environment’s are read-only', async () => {
    const created = await connectionsRoute.POST(request({ name: 'Pulsar', kind: 'pulsar', config: { url: 'pulsar://127.0.0.1:56650', tls: true }, secrets: { password: 'guest-pw' } }));
    expect(created.status).toBe(201);
    const view = (await created.json()) as TransportConnectionView;
    expect(view).toMatchObject({ id: 'pulsar', kind: 'pulsar', secretsSet: ['password'], config: { url: 'pulsar://127.0.0.1:56650', tls: true } });

    expect((await (await connectionRoute.GET(request(undefined, 'GET'), params('pulsar'))).json()) as TransportConnectionView).toMatchObject({ id: 'pulsar' });
    expect((await connectionRoute.GET(request(undefined, 'GET'), params('nope'))).status).toBe(404);

    const patched = await connectionRoute.PATCH(request({ enabled: false, name: 'Pulsar 2' }, 'PATCH'), params('pulsar'));
    expect((await patched.json()) as TransportConnectionView).toMatchObject({ enabled: false, name: 'Pulsar 2', secretsSet: ['password'] });
    expect((await connectionRoute.PATCH(request({ kind: 'nats' }, 'PATCH'), params('pulsar'))).status).toBe(400);
    expect((await connectionsRoute.POST(request({ name: 'Pulsar 2', kind: 'pulsar' }))).status).toBe(409);

    // Test without a driver: the real Pulsar provider is set aside for this call, so the kind counts as "driver in a later release".
    const restore = withoutProvider('pulsar');
    let tested: TransportConnectionCheck;
    try {
      tested = (await (await connectionTestRoute.POST(request(), params('pulsar'))).json()) as TransportConnectionCheck;
    } finally {
      restore();
    }
    expect(tested).toMatchObject({ ok: false, message: expect.stringMatching(/^No driver for (Apache )?Pulsar/) });
    const list = (await (await connectionsRoute.GET(request(undefined, 'GET'))).json()) as { connections: TransportConnectionView[] };
    expect(list.connections.find((c) => c.id === 'pulsar')?.lastCheck).toMatchObject({ ok: false });

    expect((await connectionRoute.DELETE(request(undefined, 'DELETE'), params('pulsar'))).status).toBe(200);
    expect((await connectionRoute.DELETE(request(undefined, 'DELETE'), params('pulsar'))).status).toBe(404);
    expect((await connectionsRoute.POST(request({ name: 'bad', kind: 'kafka', config: { url: 42 } }))).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The registry through the selector
// ---------------------------------------------------------------------------

describe('registry: the selector chooses per call', () => {
  const spans = new InMemorySpanExporter();
  const plugin = definePlugin({
    info: { id: PLUGIN_ID, name: 'Transport Echo', version: '1.0.0' },
    nodes: [
      defineNode({
        description: { name: 'echo', displayName: 'Echo', description: '', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
        execute: (ctx) => ctx.getInputData().map((item) => ({ json: { ...item.json, echoed: true } })),
      }),
    ],
  });
  let httpServer: Server;
  let grpcServer: grpc.Server;
  const HTTP = `http://127.0.0.1:${HTTP_PORT}`;
  const GRPC = `grpc://127.0.0.1:${GRPC_PORT}`;
  const summary = () => registry.list().find((p) => p.id === PLUGIN_ID) as PluginSummary;
  const execute = async () => {
    const resolved = registry.resolve(`${PLUGIN_ID}.echo`);
    if ('error' in resolved) throw new Error(resolved.error);
    return resolved.execute({
      protocol: PROTOCOL_VERSION,
      executionId: 'ex1',
      workflowId: 'wf1',
      mode: 'manual',
      node: { id: 'n1', name: 'Echo', type: `${PLUGIN_ID}.echo`, typeVersion: 1 },
      parameters: {},
      itemParameters: [{}],
      inputs: [[{ json: { a: 1 } }]],
    });
  };
  const rpcSpans = () => spans.getFinishedSpans().filter((s) => s.name === 'plugin.rpc Execute');

  beforeAll(async () => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spans })] }));
    const handle = createFetchHandler(plugin);
    httpServer = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const response = await handle(new Request(`http://plugin${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, ...(chunks.length && { body: Buffer.concat(chunks) }) }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((resolve) => httpServer.listen(HTTP_PORT, '127.0.0.1', resolve));
    grpcServer = await serveGrpc(plugin, { port: GRPC_PORT, host: '127.0.0.1' });
    await registry.addEndpoint(HTTP, 'manual');
    await registry.addEndpoint(GRPC, 'manual');
  });

  afterAll(async () => {
    registry.remove(PLUGIN_ID);
    transportPolicies.remove(PLUGIN_ID);
    grpcServer.forceShutdown();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    trace.disable();
  });

  it('lists the plugin’s transports, its policy and the choice with its reason', () => {
    const p = summary();
    expect(p.status).toBe('online');
    expect(p.transports?.map((t) => [t.kind, t.online])).toEqual(expect.arrayContaining([['http', true], ['grpc', true]]));
    expect(p.policy).toEqual(AUTO);
    expect(p.choice).toEqual({ endpoint: GRPC, kind: 'grpc', reason: 'auto.latency' });
    expect(p.transport).toBe('grpc');
    expect(p.activeEndpoint).toBe(GRPC);
    expect(p.preferredTransport).toBeUndefined();
    expect(registry.select(PLUGIN_ID)).toEqual(p.choice);
  });

  it('executes over the chosen transport and puts the transport and reason on the plugin.rpc span', async () => {
    spans.reset();
    const auto = await execute();
    expect(auto.outputs?.[0]?.[0]?.json).toMatchObject({ a: 1, echoed: true });
    expect(rpcSpans().at(-1)?.attributes).toMatchObject({ 'rpc.system': 'grpc', 'landflow.transport': 'grpc', 'landflow.transport.reason': 'auto.latency', 'landflow.plugin.id': PLUGIN_ID });

    // The older body: a preferred transport pins the policy.
    const patched = await pluginRoute.PATCH(request({ preferredTransport: 'http' }, 'PATCH'), params(PLUGIN_ID));
    expect(patched.status).toBe(200);
    const after = ((await patched.json()) as { plugins: PluginSummary[] }).plugins.find((p) => p.id === PLUGIN_ID)!;
    expect(after.policy).toEqual({ mode: 'pinned', pinned: 'http', objective: 'balanced' });
    expect(after.preferredTransport).toBe('http');
    expect(after.choice).toEqual({ endpoint: HTTP, kind: 'http', reason: 'pinned' });
    expect(after.transports?.find((t) => t.kind === 'grpc')?.excluded).toBe(true);

    spans.reset();
    await execute();
    expect(rpcSpans().at(-1)?.attributes).toMatchObject({ 'rpc.system': 'http', 'landflow.transport': 'http', 'landflow.transport.reason': 'pinned' });
    // The policy survived in the database, shared with every other process.
    expect(transportPolicies.get(PLUGIN_ID)).toEqual({ mode: 'pinned', pinned: 'http', objective: 'balanced' });
    expect(queryEvents({ action: ['plugin.transport'], targetId: PLUGIN_ID }).events[0]?.details).toMatchObject({ mode: 'pinned', pinned: 'http' });
  });

  it('accepts the new policy body: an allow-list with one kind left is `only`; back to Auto is gRPC again', async () => {
    const allowed = await pluginRoute.PATCH(request({ policy: { mode: 'auto', allowed: ['http'], objective: 'latency' } }, 'PATCH'), params(PLUGIN_ID));
    expect(allowed.status).toBe(200);
    expect(summary().choice).toEqual({ endpoint: HTTP, kind: 'http', reason: 'only' });
    expect(summary().policy).toEqual({ mode: 'auto', allowed: ['http'], objective: 'latency' });

    expect((await pluginRoute.PATCH(request({ policy: { mode: 'pinned' } }, 'PATCH'), params(PLUGIN_ID))).status).toBe(400);
    expect((await pluginRoute.PATCH(request({}, 'PATCH'), params(PLUGIN_ID))).status).toBe(400);
    expect((await pluginRoute.PATCH(request({ preferredTransport: null }, 'PATCH'), params('no-such-plugin'))).status).toBe(404);

    // The older body only pins and unpins: the allow-list and objective stay.
    await pluginRoute.PATCH(request({ preferredTransport: 'http' }, 'PATCH'), params(PLUGIN_ID));
    expect(summary().policy).toEqual({ mode: 'pinned', pinned: 'http', allowed: ['http'], objective: 'latency' });
    await pluginRoute.PATCH(request({ preferredTransport: null }, 'PATCH'), params(PLUGIN_ID));
    expect(summary().policy).toEqual({ mode: 'auto', allowed: ['http'], objective: 'latency' });
    await pluginRoute.PATCH(request({ policy: { mode: 'auto' } }, 'PATCH'), params(PLUGIN_ID));
    expect(summary().policy).toEqual(AUTO);
    expect(summary().choice).toMatchObject({ kind: 'grpc', reason: 'auto.latency' });
  });

  it('pinned to a kind the plugin has no live endpoint on: offline, with the reason, until the policy changes', async () => {
    registry.setPolicy(PLUGIN_ID, { mode: 'pinned', pinned: 'kafka' });
    const p = summary();
    expect(p.status).toBe('offline');
    expect(p.choice).toBeUndefined();
    expect(p.choiceError).toBe(`Plugin "${PLUGIN_ID}" is pinned to kafka, but no kafka endpoint is online`);
    expect(registry.resolve(`${PLUGIN_ID}.echo`)).toEqual({ error: 'Plugin "Transport Echo" is pinned to kafka, but no kafka endpoint is online' });
    expect(registry.nodeTypes().find((n) => n.type === `${PLUGIN_ID}.echo`)?.available).toBe(false);
    registry.setPolicy(PLUGIN_ID, { mode: 'auto' });
    expect(summary().status).toBe('online');
  });
});
