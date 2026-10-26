/**
 * The messaging binding (docs/transports.md "Generic messaging"): serve() over a BrokerTarget (the in-memory driver),
 * announce and withdraw over the broker with the SDK's instance id, calls through the dispatcher with the OTel messaging
 * attributes, error-code mapping, the secret rule, and the environment path (LANDFLOW_TRANSPORTS + LANDFLOW_<KIND>_URL).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { HTTP_PATHS, type ExecuteRequest, type PluginManifest } from '@landflow/protocol';
import { Keyring, manifestHashOf, MessagingClient, RemoteError, silentLogger, TimeoutError, type PluginEvent } from '@landflow/transports';
import type { BrokerTarget } from '@landflow/transports/drivers';
import { MemoryBroker } from '@landflow/transports/memory';
import { defineNode, definePlugin, DispatchError, type IExecuteContext } from '../src';
import { INSTANCE_ID } from '../src/announce';
import { brokerTargetFromEnv, brokerUrlEnv, messagingBinding, remoteErrorCode } from '../src/messaging';
import { serve, type ServeResult } from '../src/serve';
import { createTelemetry } from '../src/telemetry';

// Stream T2-D's port range: 7460–7479.
const HTTP_PORT = 7466;
const SECRET = 'messaging-test-secret';
const PLUGIN_ID = 'msgdemo';

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

const slow = defineNode({
  description: {
    name: 'slow',
    displayName: 'Slow',
    description: '',
    version: 1,
    kind: 'action',
    idempotent: true,
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    properties: [{ name: 'ms', displayName: 'ms', type: 'number', default: 0 }],
  },
  async execute(ctx: IExecuteContext) {
    await wait(ctx.getNodeParameter<number>('ms'), ctx.signal);
    return [{ json: { deadline: ctx.deadline ?? null, items: ctx.getInputData().length } }];
  },
});
const plugin = definePlugin({ info: { id: PLUGIN_ID, name: 'Messaging demo', version: '2.0.0' }, nodes: [slow] });

const request = (ms = 0): ExecuteRequest => ({
  protocol: 'landflow.plugin/v1',
  executionId: 'ex_1',
  mode: 'manual',
  node: { id: 'n1', name: 'Slow', type: `${PLUGIN_ID}.slow`, typeVersion: 1 },
  parameters: { ms },
  itemParameters: [{}],
  inputs: [[{ json: {} }]],
});

const config = { connectionId: 'test-conn', prefix: 'landflow' };
const keyring = new Keyring(SECRET);
const targetOn = (broker: MemoryBroker): BrokerTarget => ({ kind: 'memory', driver: () => broker.driver(), config });
const quietTelemetry = (exporter?: InMemorySpanExporter) =>
  createTelemetry({ pluginId: PLUGIN_ID, env: exporter ? { OTEL_TRACES_EXPORTER: 'none', OTEL_METRICS_EXPORTER: 'none' } : { OTEL_SDK_DISABLED: 'true' }, logWriter: () => {}, ...(exporter && { spanExporters: [exporter] }) });

const running: ServeResult[] = [];
const clients: MessagingClient[] = [];
const savedEnv = { ...process.env };
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(running.splice(0).map((result) => result.stop()));
  for (const key of ['LANDFLOW_TRANSPORTS', 'LANDFLOW_TRANSPORT_SECRET', 'LANDFLOW_REGISTRY_SECRET', 'LANDFLOW_MEMORY_URL', 'LANDFLOW_KAFKA_URL']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

async function hostOn(broker: MemoryBroker): Promise<{ client: MessagingClient; events: PluginEvent[] }> {
  const client = await MessagingClient.start({ driver: broker.driver(), config, keyring, registrySecret: null, log: silentLogger, statsIntervalMs: 0 });
  clients.push(client);
  const events: PluginEvent[] = [];
  client.on('plugin', (event) => events.push(event));
  return { client, events };
}

describe('serve() over a broker', () => {
  it('announces with the SDK instance id and the served manifest hash, answers calls through the dispatcher, withdraws on stop', async () => {
    process.env.LANDFLOW_TRANSPORT_SECRET = SECRET;
    const broker = new MemoryBroker();
    const { client, events } = await hostOn(broker);
    const exporter = new InMemorySpanExporter();
    const result = await serve(plugin, { http: HTTP_PORT, host: '127.0.0.1', brokers: [targetOn(broker)], maxConcurrency: 3, registryUrl: false, telemetry: await quietTelemetry(exporter) });
    running.push(result);
    expect(result.transports).toEqual(['http', 'memory', 'mcp']);
    expect(result.dispatcher.manifest.transports).toEqual(['http', 'memory', 'mcp']);
    // Brokered endpoints are announced over the broker, not through the HTTP announce (the host names its connections).
    expect(result.endpoints).toEqual([`http://127.0.0.1:${HTTP_PORT}`]);

    for (let i = 0; i < 50 && !client.plugin(PLUGIN_ID); i++) await wait(10);
    const announced = client.plugin(PLUGIN_ID)!;
    expect(announced.endpoint).toBe(`memory://test-conn/${PLUGIN_ID}`);
    expect(announced.instances.map((i) => i.instanceId)).toEqual([INSTANCE_ID]);
    expect(announced.instances[0]!.maxConcurrency).toBe(3);
    // The announce hash is over the exact manifest the HTTP face serves (what the host hashes, stream T2-C).
    const served = (await (await fetch(`http://127.0.0.1:${HTTP_PORT}${HTTP_PATHS.manifest}`)).json()) as PluginManifest;
    expect(announced.manifestHash).toBe(manifestHashOf(served));
    expect(await client.call(PLUGIN_ID, 'GetManifest', {})).toEqual(served);
    expect(await client.call(PLUGIN_ID, 'Health', {})).toMatchObject({ status: 'ok', pluginId: PLUGIN_ID });

    const reply = await client.invoke(PLUGIN_ID, 'Execute', request(5), { deadline: Date.now() + 4_000, delivery: 'at-least-once' });
    expect(reply.body.outputs[0]![0]!.json).toEqual({ deadline: expect.any(Number), items: 1 });
    expect(reply.instanceId).toBe(INSTANCE_ID);
    expect(reply.attributes.lfmanifest).toBe(announced.manifestHash);

    // Error mapping onto lferror codes.
    await expect(client.call(PLUGIN_ID, 'Execute', { ...request(), node: { ...request().node, type: `${PLUGIN_ID}.nope` } })).rejects.toMatchObject({ code: 'not_found' });
    await expect(client.call(PLUGIN_ID, 'Execute', { ...request(), inputs: 'nope' } as never)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(client.call(PLUGIN_ID, 'TestCredentials', { credentialType: 'nope', data: {} })).rejects.toBeInstanceOf(RemoteError);
    await expect(client.call(PLUGIN_ID, 'LoadOptions', { nodeType: `${PLUGIN_ID}.slow`, method: 'nope', parameters: {} })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(client.call(PLUGIN_ID, 'Execute', request(2_000), { timeoutMs: 150 })).rejects.toBeInstanceOf(TimeoutError);

    const spans = exporter.getFinishedSpans().filter((span) => span.name === `plugin.execute ${PLUGIN_ID}.slow`);
    expect(spans[0]!.attributes).toMatchObject({
      'rpc.system': 'memory',
      'messaging.system': 'memory',
      'messaging.destination.name': `landflow.v1.plugin.${PLUGIN_ID}`,
      'messaging.operation.type': 'process',
      'landflow.delivery.mode': 'at-least-once',
      'landflow.delivery.attempt': 1,
    });

    await result.stop();
    running.pop();
    expect(events.map((e) => e.type)).toEqual(['announced', 'withdrawn']);
    expect(client.plugin(PLUGIN_ID)?.instances).toHaveLength(0);
  });

  it('refuses to start without the shared secret, before any face listens', async () => {
    delete process.env.LANDFLOW_TRANSPORT_SECRET;
    delete process.env.LANDFLOW_REGISTRY_SECRET;
    await expect(serve(plugin, { http: HTTP_PORT, host: '127.0.0.1', brokers: [targetOn(new MemoryBroker())], registryUrl: false, telemetry: await quietTelemetry() })).rejects.toThrow(/LANDFLOW_TRANSPORT_SECRET/);
    await expect(fetch(`http://127.0.0.1:${HTTP_PORT}${HTTP_PATHS.health}`)).rejects.toThrow();
  });

  it('a ready messaging binding in brokers[] is started as is, and LANDFLOW_TRANSPORTS can leave it out', async () => {
    const broker = new MemoryBroker();
    const { client } = await hostOn(broker);
    const binding = messagingBinding(targetOn(broker), { keyring, registrySecret: null });
    process.env.LANDFLOW_TRANSPORTS = 'memory';
    const result = await serve(plugin, { http: HTTP_PORT, host: '127.0.0.1', brokers: [binding], registryUrl: false, telemetry: await quietTelemetry() });
    running.push(result);
    expect(result.transports).toEqual(['memory']);
    expect(binding.server?.instanceId).toBe(INSTANCE_ID);
    for (let i = 0; i < 50 && !client.plugin(PLUGIN_ID); i++) await wait(10);
    expect((await client.call(PLUGIN_ID, 'Execute', request())).outputs[0]![0]!.json).toMatchObject({ items: 1 });
    await expect(fetch(`http://127.0.0.1:${HTTP_PORT}${HTTP_PATHS.health}`)).rejects.toThrow();
  });

  it('LANDFLOW_TRANSPORTS names a broker kind: LANDFLOW_<KIND>_URL is required and the kind needs a driver module', async () => {
    process.env.LANDFLOW_TRANSPORT_SECRET = SECRET;
    process.env.LANDFLOW_TRANSPORTS = 'http,kafka';
    await expect(serve(plugin, { http: HTTP_PORT, host: '127.0.0.1', registryUrl: false, telemetry: await quietTelemetry() })).rejects.toThrow(/LANDFLOW_KAFKA_URL is not set/);
    process.env.LANDFLOW_TRANSPORTS = 'http,memory';
    process.env.LANDFLOW_MEMORY_URL = 'memory://local';
    await expect(serve(plugin, { http: HTTP_PORT, host: '127.0.0.1', registryUrl: false, telemetry: await quietTelemetry() })).rejects.toThrow(/no driver for "memory"/);
    expect(brokerUrlEnv('nats')).toBe('LANDFLOW_NATS_URL');
    expect(await brokerTargetFromEnv('kafka', {})).toBeUndefined();
  });

  it('maps dispatcher error codes onto lferror codes', () => {
    const codes = { unknown_node: 'not_found', unknown_credential_type: 'not_found', deadline_exceeded: 'expired', canceled: 'cancelled', capacity: 'capacity' } as const;
    for (const [code, remote] of Object.entries(codes)) expect(remoteErrorCode(new DispatchError(code as keyof typeof codes, 'x'))).toBe(remote);
  });
});
