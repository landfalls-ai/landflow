/**
 * Queue-mode workers on brokers (cluster/worker-main.ts; docs/transports.md "Queue mode"): a worker process opens the
 * instance's enabled broker connections (they live in the shared database), discovers plugins announced only over a
 * broker, and runs nodes through the Auto selector with no policy set. A connection another process (a main) adds,
 * edits or disables reaches the worker through the replication broadcast, with no restart.
 *
 * The test starts the registry and the manager the way worker-main does (role `worker`, `registry.start()`,
 * `registerBrokerProviders()`, `brokerConnections.start(registry)`), with the in-memory driver standing in for a broker.
 * "The main" is a second `TransportConnections` store: its writes reach the worker's manager only through
 * `emitTablesChanged`, the event the Postgres LISTEN/NOTIFY (or the SQLite broadcast) raises in another process.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type ExecuteRequest, type ExecuteResponse, type JsonValue, type PluginManifest } from '@landflow/protocol';
import { buildManifest, defineNode, definePlugin } from '@landflow/sdk';
import { DispatchError, Keyring, MessagingServer, type DispatchContext, type Method } from '@landflow/transports';
import type { DriverModule } from '@landflow/transports/drivers';
import { MemoryBroker, type MemoryConfig } from '@landflow/transports/memory';
import type { PluginSummary } from '@/lib/shared/types';

vi.setConfig({ testTimeout: 20_000, hookTimeout: 30_000 });
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-worker-brokers-'));
Object.assign(process.env, {
  LANDFLOW_ROLE: 'worker',
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_ENCRYPTION_KEY: 'worker-test-key',
  LANDFLOW_TRANSPORT_SECRET: 'worker-test-transport-secret',
  LANDFLOW_REGISTRY_SECRET: 'worker-test-registry-secret',
});

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { transportConnections, TransportConnections } = await import('@/lib/server/transports/connections');
const { transportPolicies } = await import('@/lib/server/transports/policy-store');
const { brokerConnections, driverModules } = await import('@/lib/server/transports/brokers');
const { registerBrokerProviders } = await import('@/lib/server/transports/broker-provider');
const { emitTablesChanged } = await import('@/lib/server/db/replication');
const { clusterConfig } = await import('@/lib/server/cluster/config');

const PLUGIN_ID = 'tw-echo';
const CONNECTION_ID = 'tw-mem';
const ENDPOINT = `memory://${CONNECTION_ID}/${PLUGIN_ID}`;
const until = (check: () => void, timeout = 8_000) => vi.waitFor(check, { timeout, interval: 25 });
const summary = () => registry.list().find((p) => p.id === PLUGIN_ID) as PluginSummary | undefined;

const broker = new MemoryBroker();
const memoryModule: DriverModule<MemoryConfig> = {
  kind: 'memory',
  label: 'Memory (test)',
  capabilities: broker.capabilities,
  exampleUrl: 'memory://local',
  create: () => broker.driver(),
  configFrom: (connectionId, _url, options) => ({ connectionId, ...(typeof options?.prefix === 'string' && { prefix: options.prefix }) }),
};

const plugin = definePlugin({
  info: { id: PLUGIN_ID, name: 'Worker Echo', version: '1.0.0' },
  nodes: [
    defineNode({
      description: { name: 'echo', displayName: 'Echo', description: '', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
      execute: (ctx) => ctx.getInputData(),
    }),
  ],
});
const manifest: PluginManifest = buildManifest(plugin);
const seen: Method[] = [];
const dispatch = async (method: Method, body: JsonValue, _ctx: DispatchContext): Promise<JsonValue> => {
  seen.push(method);
  const request = body as unknown as ExecuteRequest;
  switch (method) {
    case 'GetManifest':
      return manifest as unknown as JsonValue;
    case 'Health':
      return { status: 'ok', uptimeMs: 1, pluginId: PLUGIN_ID, version: '1.0.0' };
    case 'Execute':
      return { outputs: [request.inputs[0]!.map((item) => ({ json: { ...item.json, via: 'broker' } }))] } satisfies ExecuteResponse as unknown as JsonValue;
    default:
      throw new DispatchError(`unsupported ${method}`, 'bad_request');
  }
};

const execute = () => {
  const resolved = registry.resolve(`${PLUGIN_ID}.echo`);
  if ('error' in resolved) throw new Error(resolved.error);
  return resolved.execute({
    protocol: PROTOCOL_VERSION,
    executionId: 'ex-w1',
    workflowId: 'wf-w1',
    mode: 'production',
    node: { id: 'n1', name: 'echo', type: `${PLUGIN_ID}.echo`, typeVersion: 1 },
    parameters: {},
    itemParameters: [{}],
    inputs: [[{ json: { a: 1 } }]],
    idempotencyKey: 'ex-w1:n1:0',
  });
};

/** The main: its own store over the same database; the worker hears of its writes only through the replication event. */
const main = new TransportConnections();
const mainChanged = () => emitTablesChanged({ tables: new Set(['transport_connections']), keys: new Map() });

let server: MessagingServer;

beforeAll(async () => {
  driverModules.register(memoryModule);
  // What worker-main.ts does, in its order.
  registry.registerBuiltin(corePlugin);
  registry.start();
  await registerBrokerProviders();
  await brokerConnections.start(registry);
});

afterAll(async () => {
  await server?.stop().catch(() => {});
  await brokerConnections.stop();
  registry.remove(PLUGIN_ID);
  transportPolicies.remove(PLUGIN_ID);
});

describe('a queue-mode worker on brokers', () => {
  it('runs as the worker role, with no broker connection saved yet', () => {
    expect(clusterConfig(process.env).role).toBe('worker');
    expect(transportConnections.list().filter((c) => c.source === 'database')).toEqual([]);
    expect(brokerConnections.clientFor(CONNECTION_ID)).toBeUndefined();
  });

  it('opens a connection a main adds later, discovers a broker-only plugin and runs a node over the broker with Auto', async () => {
    main.create({ id: CONNECTION_ID, name: 'TMP worker memory', kind: 'memory', config: { url: 'memory://local' } });
    mainChanged();
    await until(() => expect(brokerConnections.clientFor(CONNECTION_ID)).toBeDefined());

    server = await MessagingServer.start({
      driver: broker.driver(),
      config: { connectionId: 'plugin-side-name' },
      keyring: Keyring.fromEnv(),
      pluginId: PLUGIN_ID,
      version: '1.0.0',
      manifest,
      dispatch,
      announceIntervalMs: 200,
      ttlSeconds: 2,
      log: () => {},
    });
    await until(() => expect(summary()?.endpoints.map((e) => [e.endpoint, e.status])).toEqual([[ENDPOINT, 'online']]));
    expect(summary()?.endpoints[0]?.transport).toBe('memory');

    // No policy for the plugin: Auto chooses, and the broker is the only endpoint there is.
    expect(transportPolicies.get(PLUGIN_ID)).toMatchObject({ mode: 'auto' });
    const response = await execute();
    expect(response.outputs[0]?.[0]?.json).toMatchObject({ a: 1, via: 'broker' });
    expect(seen).toContain('Execute');
    expect(registry.list().find((p) => p.id === PLUGIN_ID)?.endpoints[0]).toMatchObject({ endpoint: ENDPOINT });
  });

  it('follows a main that edits the connection (reopens it) and disables it (closes it, the plugin goes offline), then enables it again', async () => {
    const before = brokerConnections.clientFor(CONNECTION_ID)!;
    main.update(CONNECTION_ID, { config: { url: 'memory://local', note: 'edited' } });
    mainChanged();
    await until(() => {
      const after = brokerConnections.clientFor(CONNECTION_ID);
      expect(after).toBeDefined();
      expect(after).not.toBe(before);
    });
    await until(() => expect(summary()?.endpoints[0]?.status).toBe('online'));
    expect((await execute()).outputs[0]?.[0]?.json).toMatchObject({ via: 'broker' });

    main.update(CONNECTION_ID, { enabled: false });
    mainChanged();
    await until(() => expect(brokerConnections.clientFor(CONNECTION_ID)).toBeUndefined());
    await until(() => expect(summary()?.endpoints[0]?.status).toBe('offline'));

    main.update(CONNECTION_ID, { enabled: true });
    mainChanged();
    await until(() => expect(summary()?.endpoints[0]?.status).toBe('online'));
    expect((await execute()).outputs[0]?.[0]?.json).toMatchObject({ via: 'broker' });
  });

  it('drops the endpoint when a main deletes the connection', async () => {
    expect(main.delete(CONNECTION_ID)).toBe(true);
    mainChanged();
    await until(() => expect(brokerConnections.clientFor(CONNECTION_ID)).toBeUndefined());
    await until(() => expect(summary()).toBeUndefined());
  });

  it('keeps the MCP gateway sync out of the worker (mains only)', () => {
    const source = readFileSync(join(__dirname, '../src/lib/server/cluster/worker-main.ts'), 'utf8');
    expect(source).not.toMatch(/gateway-sync|McpGatewaySync|startGatewaySync/i);
    expect(source).toMatch(/brokerConnections\.start\(registry\)/);
  });
});
