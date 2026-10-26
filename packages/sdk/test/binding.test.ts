/**
 * TransportBinding (docs/transports.md "SDK side"): a third face plugs into serve() next to HTTP and gRPC, shares the
 * dispatcher, gets the hints and the announce hook; LANDFLOW_TRANSPORTS picks the faces; HTTP and gRPC carry the
 * deadline and cancellation into the dispatcher.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HTTP_PATHS, type AnnounceRequest, type ExecuteRequest, type ExecuteResponse } from '@landflow/protocol';
import { executeRequestToMsg, executeResponseFromMsg, grpc, loadLandflowProto, type ExecuteResponseMsg } from '@landflow/protocol/grpc';
import { defineNode, definePlugin, DispatchError, type BindingContext, type IExecuteContext, type TransportBinding } from '../src';
import { DEADLINE_HEADER } from '../src/http';
import { serve, type ServeResult } from '../src/serve';
import { createTelemetry } from '../src/telemetry';

// Stream T1-C's port range: 7400–7419.
const HTTP_PORT = 7410;
const GRPC_PORT = 7411;

const seen: { aborted: boolean; reason?: string }[] = [];
const sleep = (ms: number, signal?: AbortSignal) =>
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
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    properties: [{ name: 'ms', displayName: 'ms', type: 'number', default: 0 }],
  },
  async execute(ctx: IExecuteContext) {
    const record: (typeof seen)[number] = { aborted: false };
    seen.push(record);
    ctx.signal?.addEventListener('abort', () => Object.assign(record, { aborted: true, reason: String((ctx.signal!.reason as Error).message) }));
    await sleep(ctx.getNodeParameter<number>('ms'), ctx.signal);
    return [{ json: { deadline: ctx.deadline ?? null } }];
  },
});
const plugin = definePlugin({ info: { id: 'bind', name: 'Binding test', version: '1.2.3' }, nodes: [slow] });

const request = (ms = 0): ExecuteRequest => ({
  protocol: 'landflow.plugin/v1',
  executionId: 'ex_1',
  mode: 'manual',
  node: { id: 'n1', name: 'Slow', type: 'bind.slow', typeVersion: 1 },
  parameters: { ms },
  itemParameters: [{ ms }],
  inputs: [[{ json: {} }]],
});

/** A face that takes calls from a function instead of a socket. */
function fakeBinding(kind = 'fake') {
  const log: string[] = [];
  let context: BindingContext | undefined;
  const binding: TransportBinding & { log: string[]; context: () => BindingContext; call(request: ExecuteRequest, deadline?: number): Promise<ExecuteResponse> } = {
    kind,
    log,
    context: () => context!,
    async start(ctx) {
      context = ctx;
      log.push('start');
      return { endpoints: [`${kind}://conn-1/${ctx.plugin.info.id}`], description: `${kind} connected` };
    },
    async stop() {
      log.push('stop');
      await context?.dispatcher.drain();
    },
    call: (req, deadline) => context!.dispatcher.execute(req, { transport: kind, ...(deadline !== undefined && { deadline }) }),
  };
  return binding;
}

async function fakeRegistry(): Promise<{ url: string; announces: AnnounceRequest[]; withdraws: object[]; server: Server }> {
  const announces: AnnounceRequest[] = [];
  const withdraws: object[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      (req.method === 'POST' ? announces : withdraws).push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: true, heartbeatIntervalSeconds: 60 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, announces, withdraws, server };
}

const quietTelemetry = () => createTelemetry({ pluginId: 'bind', pluginVersion: '1.2.3', env: { OTEL_SDK_DISABLED: 'true' }, logWriter: () => {} });

const running: ServeResult[] = [];
const servers: Server[] = [];
const savedEnv = { ...process.env };
afterEach(async () => {
  await Promise.all(running.splice(0).map((result) => result.stop()));
  for (const server of servers.splice(0)) server.close();
  for (const key of ['LANDFLOW_TRANSPORTS', 'LANDFLOW_MAX_CONCURRENCY', 'LANDFLOW_REGISTRY_URL', 'LANDFLOW_HTTP_PORT', 'LANDFLOW_GRPC_PORT']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  seen.length = 0;
});

describe('serve() with a third binding', () => {
  it('starts it next to HTTP, shares the dispatcher and hints, announces its endpoint, stops it', async () => {
    const registry = await fakeRegistry();
    servers.push(registry.server);
    const fake = fakeBinding();
    const result = await serve(plugin, { http: HTTP_PORT, bindings: [fake], maxConcurrency: 3, registryUrl: registry.url, telemetry: await quietTelemetry() });
    running.push(result);

    expect(result.transports).toEqual(['http', 'fake']);
    expect(result.endpoints).toEqual([`http://127.0.0.1:${HTTP_PORT}`, 'fake://conn-1/bind']);
    const context = fake.context();
    expect(context.dispatcher).toBe(result.dispatcher);
    expect(context.hints).toEqual({ transports: ['http', 'fake'], maxConcurrency: 3 });
    expect(context.manifest).toMatchObject({ transports: ['http', 'fake'], maxConcurrency: 3 });
    expect(context.advertiseHost).toBe('127.0.0.1');

    // The same manifest (hints included) over HTTP; the fake face runs the same node through the same dispatcher.
    const manifest = await (await fetch(`http://127.0.0.1:${HTTP_PORT}${HTTP_PATHS.manifest}`)).json();
    expect(manifest).toMatchObject({ plugin: { id: 'bind' }, transports: ['http', 'fake'], maxConcurrency: 3 });
    const response = await fake.call(request(), Date.now() + 1000);
    expect(response.outputs[0]![0]!.json.deadline).toBeGreaterThan(Date.now() - 1);

    // The announce payload carries the hints for every endpoint.
    expect(registry.announces.map((a) => a.endpoint).sort()).toEqual([`fake://conn-1/bind`, `http://127.0.0.1:${HTTP_PORT}`]);
    expect(registry.announces.every((a) => (a as AnnounceRequest & { transports?: string[]; maxConcurrency?: number }).transports?.join() === 'http,fake')).toBe(true);
    expect((registry.announces[0] as AnnounceRequest & { maxConcurrency?: number }).maxConcurrency).toBe(3);

    // The announce hook: a late endpoint goes out at once; a withdrawn one stops.
    context.announce(['fake://conn-2/bind']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(registry.announces.some((a) => a.endpoint === 'fake://conn-2/bind')).toBe(true);
    expect(result.endpoints).toContain('fake://conn-2/bind');
    context.withdraw(['fake://conn-2/bind']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(registry.withdraws).toContainEqual({ endpoint: 'fake://conn-2/bind', pluginId: 'bind' });

    await result.stop();
    running.pop();
    expect(fake.log).toEqual(['start', 'stop']);
    expect(registry.withdraws.map((w) => (w as { endpoint: string }).endpoint).sort()).toEqual(['fake://conn-1/bind', 'fake://conn-2/bind', `http://127.0.0.1:${HTTP_PORT}`]);
  });

  it('LANDFLOW_TRANSPORTS picks the faces; a kind nobody provides is an error; brokers are not available yet', async () => {
    process.env.LANDFLOW_TRANSPORTS = 'fake';
    process.env.LANDFLOW_MAX_CONCURRENCY = '7';
    const fake = fakeBinding();
    const result = await serve(plugin, { http: HTTP_PORT, grpc: GRPC_PORT, bindings: [fake], registryUrl: false, telemetry: await quietTelemetry() });
    running.push(result);
    expect(result.transports).toEqual(['fake']);
    expect(result.dispatcher.maxConcurrency).toBe(7);
    await expect(fetch(`http://127.0.0.1:${HTTP_PORT}${HTTP_PATHS.health}`)).rejects.toThrow();
    await result.stop();
    running.pop();

    process.env.LANDFLOW_TRANSPORTS = 'http,kafka';
    await expect(serve(plugin, { http: HTTP_PORT, registryUrl: false, telemetry: await quietTelemetry() })).rejects.toThrow(/LANDFLOW_KAFKA_URL is not set/);
    process.env.LANDFLOW_TRANSPORTS = 'grpc';
    await expect(serve(plugin, { http: HTTP_PORT, registryUrl: false, telemetry: await quietTelemetry() })).rejects.toThrow(/no GRPC port/);
    process.env.LANDFLOW_TRANSPORTS = 'carrier-pigeon';
    await expect(serve(plugin, { http: HTTP_PORT, registryUrl: false, telemetry: await quietTelemetry() })).rejects.toThrow(/no binding provides/);
    delete process.env.LANDFLOW_TRANSPORTS;

    await expect(serve(plugin, { http: HTTP_PORT, brokers: [{ kind: 'kafka' } as never], registryUrl: false, telemetry: await quietTelemetry() })).rejects.toThrow(/brokers\[\] entries must be BrokerTargets/);
    await expect(serve(plugin, { registryUrl: false, telemetry: await quietTelemetry() })).rejects.toThrow(/at least one transport/);
    await expect(serve(plugin, { bindings: [fakeBinding('x'), fakeBinding('x')], registryUrl: false, telemetry: await quietTelemetry() })).rejects.toThrow(/two bindings of kind "x"/);
  });

  it('a binding that fails to start stops the ones already started', async () => {
    const fake = fakeBinding();
    const broken: TransportBinding = {
      kind: 'broken',
      start: async () => {
        throw new Error('no socket for you');
      },
      stop: async () => {},
    };
    await expect(serve(plugin, { bindings: [fake, broken], registryUrl: false, telemetry: await quietTelemetry() })).rejects.toThrow('no socket for you');
    expect(fake.log).toEqual(['start', 'stop']);
  });
});

describe('HTTP and gRPC bindings carry deadline and cancellation', () => {
  it('HTTP: x-landflow-deadline reaches the node; an expired one is 504; a closed connection cancels the call', async () => {
    const result = await serve(plugin, { http: HTTP_PORT, registryUrl: false, telemetry: await quietTelemetry() });
    running.push(result);
    const url = `http://127.0.0.1:${HTTP_PORT}${HTTP_PATHS.execute}`;
    const deadline = Date.now() + 5_000;
    const ok = await fetch(url, { method: 'POST', headers: { [DEADLINE_HEADER]: String(deadline) }, body: JSON.stringify(request()) });
    expect(((await ok.json()) as ExecuteResponse).outputs[0]![0]!.json).toEqual({ deadline });

    const late = await fetch(url, { method: 'POST', headers: { [DEADLINE_HEADER]: String(Date.now() - 10) }, body: JSON.stringify(request()) });
    expect(late.status).toBe(504);
    expect(await late.json()).toMatchObject({ code: 'deadline_exceeded' });

    const controller = new AbortController();
    const dropped = fetch(url, { method: 'POST', body: JSON.stringify(request(5_000)), signal: controller.signal });
    for (let i = 0; i < 100 && seen.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(result.dispatcher.inFlight).toBe(1);
    controller.abort();
    await expect(dropped).rejects.toThrow();
    for (let i = 0; i < 100 && result.dispatcher.inFlight > 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(result.dispatcher.inFlight).toBe(0);
    expect(seen.at(-1)).toEqual({ aborted: true, reason: 'The client closed the connection' });
  });

  it('gRPC: the call deadline reaches the node and an exceeded one is DEADLINE_EXCEEDED; capacity is RESOURCE_EXHAUSTED', async () => {
    const result = await serve(plugin, { grpc: GRPC_PORT, maxConcurrency: 1, registryUrl: false, telemetry: await quietTelemetry() });
    running.push(result);
    const client = new (loadLandflowProto().PluginService)(`127.0.0.1:${GRPC_PORT}`, grpc.credentials.createInsecure()) as unknown as Record<string, Function> & { close(): void };
    const execute = (req: ExecuteRequest, deadlineMs: number) =>
      new Promise<{ error: grpc.ServiceError | null; msg: unknown }>((resolve) =>
        client.Execute(executeRequestToMsg(req), { deadline: Date.now() + deadlineMs }, (error: grpc.ServiceError | null, msg: unknown) => resolve({ error, msg })),
      );
    try {
      const ok = await execute(request(), 5_000);
      expect(ok.error).toBeNull();
      expect(executeResponseFromMsg(ok.msg as ExecuteResponseMsg).outputs[0]![0]!.json.deadline).toBeGreaterThan(Date.now() + 1_000);

      // The node outlives the deadline: grpc-js ends the call with DEADLINE_EXCEEDED and the server side is aborted.
      const late = await execute(request(2_000), 60);
      expect(late.error?.code).toBe(grpc.status.DEADLINE_EXCEEDED);
      for (let i = 0; i < 100 && result.dispatcher.inFlight > 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(result.dispatcher.inFlight).toBe(0);

      // One slot, one waiting: the third call is refused.
      const first = execute(request(100), 5_000);
      const second = execute(request(0), 5_000);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const third = await execute(request(0), 5_000);
      expect(third.error?.code).toBe(grpc.status.RESOURCE_EXHAUSTED);
      expect((await first).error).toBeNull();
      expect((await second).error).toBeNull();
    } finally {
      client.close();
    }
  });

  it('DispatchError maps to HTTP statuses', async () => {
    const { dispatchErrorStatus } = await import('../src/http');
    expect(dispatchErrorStatus(new DispatchError('unknown_node', ''))).toBe(404);
    expect(dispatchErrorStatus(new DispatchError('capacity', ''))).toBe(429);
    expect(dispatchErrorStatus(new DispatchError('canceled', ''))).toBe(499);
  });
});
