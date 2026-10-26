/**
 * The protocol conformance kit (packages/protocol/conformance) run against every face of the TypeScript SDK: HTTP, gRPC,
 * messaging (over the in-memory driver of @landflow/transports) and MCP (the 2026-07-28 wire at /mcp). One runner per
 * face knows how to send a case over its binding and maps its own signals onto the kit's outcome and error codes
 * (README "Transport error codes"); the assertions are shared.
 *
 * Runner defaults: a 3 s deadline when a case gives none (the kit says 30 s; the plugin's nodes answer in milliseconds
 * and the tampered-event cases are only resolved by the deadline).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HTTP_PATHS, type ExecuteRequest, type ExecuteResponse, type JsonObject, type NodeItem } from '@landflow/protocol';
import {
  conformanceExecuteInput,
  loadConformanceSuites,
  loadMcpToolsFixture,
  outputsMatch,
  type ConformanceCall,
  type ConformanceCase,
  type ConformanceFace,
  type ConformanceOutcome,
  type DeliveryMode,
  type TransportErrorCode,
} from '@landflow/protocol/conformance';
import { executeRequestToMsg, executeResponseFromMsg, grpc, loadLandflowProto, toDynamic, type ExecuteResponseMsg } from '@landflow/protocol/grpc';
import { mcpToolsFromManifest, withoutBinding } from '@landflow/protocol';
import {
  CancelledError,
  ManifestMismatchError,
  MessagingClient,
  RemoteError,
  silentLogger,
  TimeoutError,
  UndeliverableError,
  Keyring,
  idempotencyFromManifest,
  type DispatchContext,
  type Method,
} from '@landflow/transports';
import { MemoryBroker } from '@landflow/transports/memory';
import type { BrokerTarget } from '@landflow/transports/drivers';
import { DEADLINE_HEADER } from '../src/http';
import { messagingBinding } from '../src/messaging';
import { serve, type ServeResult } from '../src/serve';
import { createTelemetry } from '../src/telemetry';
import { conformancePlugin, CONFORMANCE_PLUGIN_ID, hooks } from './conformance-plugin';
import { mcpRequest } from './mcp-client';

// Stream T2-D's port range: 7460–7479 (7460/7461 are the live smoke plugin).
const HTTP_PORT = 7462;
const GRPC_PORT = 7463;
const MCP_TOKEN = 'conformance-token';
const DEFAULT_DEADLINE_MS = 3_000;
const SECRET = 'conformance-transport-secret';
const MAX_MESSAGE_BYTES = 256 * 1024;

type Outcome = {
  outcome: ConformanceOutcome | 'skipped';
  code?: TransportErrorCode | string;
  response?: ExecuteResponse;
  errorMessage?: string;
  elapsedMs: number;
  reason?: string;
};

interface Runner {
  face: ConformanceFace;
  run(c: ConformanceCase): Promise<Outcome>;
  /** Messaging: the delivery mode the core chose for the last dispatched call. */
  lastDelivery?(): DeliveryMode | undefined;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const settled = () => sleep(300);

/**
 * The per-call timers every runner shares: the deadline (client-side `expired`) and `cancelAfterMs` (`cancelled`).
 * `signal` fires for both (HTTP and MCP, whose only cancellation is closing the request); `cancelSignal` only for the
 * cancel (gRPC and messaging carry the deadline themselves).
 */
function callTimers(call: ConformanceCall) {
  const both = new AbortController();
  const cancelOnly = new AbortController();
  const deadlineMs = call.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const deadline = Date.now() + deadlineMs;
  let expired = deadlineMs <= 0;
  let cancelled = false;
  const timers: NodeJS.Timeout[] = [];
  if (!expired) timers.push(setTimeout(() => ((expired = true), both.abort(new Error('deadline'))), deadlineMs));
  if (call.cancelAfterMs !== undefined) {
    timers.push(setTimeout(() => ((cancelled = true), both.abort(new Error('cancel')), cancelOnly.abort(new Error('cancel'))), call.cancelAfterMs));
  }
  return {
    deadline,
    deadlineMs,
    signal: both.signal,
    cancelSignal: cancelOnly.signal,
    /** `expired` wins over `cancelled` when both fired; `undefined` when neither did. */
    why: (): TransportErrorCode | undefined => (expired ? 'expired' : cancelled ? 'cancelled' : undefined),
    isLate: () => Date.now() >= deadline,
    clear: () => timers.forEach(clearTimeout),
  };
}

/** `conformanceExecuteInput`, also for a node the plugin does not have (the unknown-node case). */
function executeInput(call: ConformanceCall) {
  try {
    return conformanceExecuteInput(loadManifest(), call);
  } catch {
    return { node: { id: `n-${call.node}`, name: call.node!, type: `${CONFORMANCE_PLUGIN_ID}.${call.node}`, typeVersion: 1 }, parameters: call.parameters ?? {}, items: call.items ?? [{ json: {} }] };
  }
}

function executeRequest(call: ConformanceCall): ExecuteRequest {
  const input = executeInput(call);
  return {
    protocol: 'landflow.plugin/v1',
    executionId: `ex_${call.node}`,
    mode: 'manual',
    node: input.node,
    parameters: input.parameters,
    itemParameters: input.items.map(() => ({})),
    inputs: [input.items],
    ...(call.idempotencyKey && { idempotencyKey: call.idempotencyKey }),
    ...(call.credentials && { credentials: call.credentials }),
  };
}

let serving: ServeResult | undefined;
let client: MessagingClient | undefined;
const loadManifest = () => serving!.dispatcher.manifest;

const outcomeOf = (response: ExecuteResponse, elapsedMs: number): Outcome =>
  response.error ? { outcome: 'node-error', response, errorMessage: response.error.message, elapsedMs } : { outcome: 'reply', response, elapsedMs };

/** Run a case `repeat` times through `once`, returning the last outcome. */
async function repeated(c: ConformanceCase, once: () => Promise<Outcome>): Promise<Outcome> {
  let last: Outcome | undefined;
  for (let i = 0; i < (c.call.repeat ?? 1); i++) last = await once();
  return last!;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const HTTP_STATUS_CODES: Record<number, TransportErrorCode> = { 400: 'bad_request', 404: 'not_found', 413: 'too_large', 429: 'unavailable', 499: 'cancelled', 500: 'internal', 503: 'unavailable', 504: 'expired' };

function httpRunner(): Runner {
  const base = `http://127.0.0.1:${HTTP_PORT}`;
  const post = async (path: string, body: unknown, call: ConformanceCall): Promise<Outcome> => {
    const timers = callTimers(call);
    const started = Date.now();
    try {
      if (timers.why() === 'expired') return { outcome: 'transport-error', code: 'expired', elapsedMs: 0 };
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [DEADLINE_HEADER]: String(timers.deadline) },
        body: JSON.stringify(body),
        signal: timers.signal,
      });
      const elapsedMs = Date.now() - started;
      const json = (await response.json()) as ExecuteResponse & { error?: { message: string }; code?: string };
      // A reply that arrives after the deadline is ignored by the caller (the deadline timer is what the host sees).
      if (timers.isLate()) return { outcome: 'transport-error', code: 'expired', elapsedMs };
      if (response.ok) return outcomeOf(json, elapsedMs);
      return { outcome: 'transport-error', code: HTTP_STATUS_CODES[response.status] ?? `http_${response.status}`, errorMessage: json.error?.message, elapsedMs };
    } catch (error) {
      const why = timers.why();
      if (why) return { outcome: 'transport-error', code: why, elapsedMs: Date.now() - started };
      throw error;
    } finally {
      timers.clear();
    }
  };
  return {
    face: 'http',
    run: (c) =>
      repeated(c, () => {
        const { call } = c;
        switch (call.method) {
          case 'execute':
            return post(HTTP_PATHS.execute, executeRequest(call), call);
          case 'health':
            return fetch(`${base}${HTTP_PATHS.health}`, { headers: { [DEADLINE_HEADER]: String(Date.now() + (call.deadlineMs ?? DEFAULT_DEADLINE_MS)) } }).then((response) => ({ outcome: response.ok ? 'reply' : 'transport-error', elapsedMs: 0 }) as Outcome);
          case 'testCredentials':
            return post(HTTP_PATHS.testCredentials, call.testCredentials, call);
          case 'loadOptions':
            return post(HTTP_PATHS.loadOptions, { nodeType: `${CONFORMANCE_PLUGIN_ID}.${call.node}`, method: call.loadOptions?.method }, call);
          default:
            return Promise.resolve({ outcome: 'skipped', reason: `${call.method} over HTTP is not part of this runner`, elapsedMs: 0 });
        }
      }),
  };
}

// ---------------------------------------------------------------------------
// gRPC
// ---------------------------------------------------------------------------

const GRPC_STATUS_CODES: Partial<Record<grpc.status, TransportErrorCode>> = {
  [grpc.status.NOT_FOUND]: 'not_found',
  [grpc.status.INVALID_ARGUMENT]: 'bad_request',
  [grpc.status.DEADLINE_EXCEEDED]: 'expired',
  [grpc.status.CANCELLED]: 'cancelled',
  [grpc.status.RESOURCE_EXHAUSTED]: 'unavailable',
  [grpc.status.INTERNAL]: 'internal',
  [grpc.status.UNAVAILABLE]: 'no_consumers',
  [grpc.status.UNAUTHENTICATED]: 'unauthenticated',
};

function grpcRunner(): Runner & { close(): void } {
  const proto = loadLandflowProto();
  const client = new proto.PluginService(`127.0.0.1:${GRPC_PORT}`, grpc.credentials.createInsecure()) as grpc.Client & Record<string, (...args: unknown[]) => grpc.ClientUnaryCall>;
  const unary = <T>(method: string, message: unknown, call: ConformanceCall, decode: (msg: T) => Outcome['response']): Promise<Outcome> => {
    const timers = callTimers(call);
    const started = Date.now();
    if (timers.why() === 'expired') {
      timers.clear();
      return Promise.resolve({ outcome: 'transport-error', code: 'expired', elapsedMs: 0 });
    }
    return new Promise<Outcome>((resolve) => {
      const handle = client[method](message, { deadline: new Date(timers.deadline) }, (error: grpc.ServiceError | null, msg: T) => {
        const why = timers.why();
        timers.clear();
        const elapsedMs = Date.now() - started;
        if (error) return resolve({ outcome: 'transport-error', code: why ?? GRPC_STATUS_CODES[error.code] ?? `grpc_${error.code}`, errorMessage: error.details, elapsedMs });
        const response = decode(msg);
        resolve(response ? outcomeOf(response, elapsedMs) : { outcome: 'reply', elapsedMs });
      });
      timers.cancelSignal.addEventListener('abort', () => handle.cancel(), { once: true });
    });
  };
  return {
    face: 'grpc',
    close: () => client.close(),
    run: (c) =>
      repeated(c, () => {
        const { call } = c;
        switch (call.method) {
          case 'execute':
            return unary<ExecuteResponseMsg>('Execute', executeRequestToMsg(executeRequest(call)), call, executeResponseFromMsg);
          case 'health':
            return unary('Health', {}, call, () => undefined);
          case 'testCredentials':
            return unary('TestCredentials', { credentialType: call.testCredentials!.credentialType, data: toDynamic(call.testCredentials!.data) }, call, () => undefined);
          case 'loadOptions':
            return unary('LoadOptions', { nodeType: `${CONFORMANCE_PLUGIN_ID}.${call.node}`, method: call.loadOptions?.method, parameters: toDynamic({}) }, call, () => undefined);
          default:
            return Promise.resolve({ outcome: 'skipped', reason: `${call.method} over gRPC is not part of this runner`, elapsedMs: 0 });
        }
      }),
  };
}

// ---------------------------------------------------------------------------
// Messaging (in-memory driver)
// ---------------------------------------------------------------------------

const broker = new MemoryBroker({ capabilities: { maxMessageBytes: MAX_MESSAGE_BYTES } });
const brokerConfig = { connectionId: 'conformance', prefix: 'landflow' };
const keyring = new Keyring(SECRET);
const target: BrokerTarget = { kind: 'memory', driver: () => broker.driver(), config: brokerConfig };
const dispatched: Array<{ method: Method; context: DispatchContext }> = [];
const memoryBinding = messagingBinding(target, { keyring, registrySecret: null, announceIntervalMs: 60_000, observe: (method, context) => dispatched.push({ method, context }) });

function messagingRunner(client: MessagingClient): Runner {
  const requestChannel = client.names.request(CONFORMANCE_PLUGIN_ID);
  const isIdempotent = idempotencyFromManifest(loadManifest());
  const tampered = (tamper: ConformanceCall['tamper']) => {
    if (!tamper) return () => {};
    return broker.tap((channel, event) => {
      if (channel !== requestChannel) return event;
      if (tamper === 'signature') return { ...event, headers: { ...event.headers, lfsig: event.headers.lfsig.replace(/^./, (c) => (c === '0' ? '1' : '0')) } };
      if (tamper === 'manifestHash') return event; // the client signs with the wrong hash itself (`manifestHash` below)
      const body = new Uint8Array(event.body);
      body[body.length - 1] ^= 0xff;
      return { ...event, body };
    });
  };
  const invoke = async (method: Method, body: unknown, call: ConformanceCall, extra: { delivery?: DeliveryMode } = {}): Promise<Outcome> => {
    const timers = callTimers(call);
    const untap = tampered(call.tamper);
    const started = Date.now();
    try {
      const reply = await client.call(CONFORMANCE_PLUGIN_ID, method, body as never, {
        deadline: timers.deadline,
        signal: timers.cancelSignal,
        idempotencyKey: call.idempotencyKey,
        // Like the host: at least once for every method but Execute, and for an Execute of an idempotent node.
        delivery: method !== 'Execute' || isIdempotent(body as ExecuteRequest) ? 'at-least-once' : 'at-most-once',
        ...(call.tamper === 'manifestHash' && { manifestHash: 'ffffffffffffffff' }),
        ...extra,
      });
      const elapsedMs = Date.now() - started;
      return method === 'Execute' ? outcomeOf(reply as ExecuteResponse, elapsedMs) : { outcome: 'reply', elapsedMs };
    } catch (error) {
      const elapsedMs = Date.now() - started;
      const why = timers.why();
      if (why === 'expired') return { outcome: 'transport-error', code: 'expired', errorMessage: (error as Error).message, elapsedMs };
      if (error instanceof TimeoutError) return { outcome: 'transport-error', code: 'expired', errorMessage: error.message, elapsedMs };
      if (error instanceof CancelledError) return { outcome: 'transport-error', code: 'cancelled', errorMessage: error.message, elapsedMs };
      if (error instanceof UndeliverableError) return { outcome: 'transport-error', code: error.reason, errorMessage: error.message, elapsedMs };
      if (error instanceof ManifestMismatchError) return { outcome: 'transport-error', code: 'manifest_mismatch', errorMessage: error.message, elapsedMs };
      if (error instanceof RemoteError) return { outcome: 'transport-error', code: error.code, errorMessage: error.message, elapsedMs };
      throw error;
    } finally {
      untap();
      timers.clear();
    }
  };
  return {
    face: 'messaging',
    lastDelivery: () => dispatched.at(-1)?.context.delivery,
    run: async (c) => {
      const { call } = c;
      if (c.id === 'request-over-limit-with-store') return { outcome: 'skipped', reason: 'the claim-check store is not part of this wave', elapsedMs: 0 };
      if (c.id === 'cancel-before-dispatch') {
        // Fill the plugin's prefetch so the cancelled request waits on the broker until after its cancel arrived: four
        // at-least-once calls (an idempotency key makes a sleep repeatable) hold their deliveries until they reply.
        const blockers = Array.from({ length: 4 }, (_, i) =>
          client.call(CONFORMANCE_PLUGIN_ID, 'Execute', executeRequest({ method: 'execute', node: 'sleep', parameters: { ms: 400 } }), { timeoutMs: 5_000, delivery: 'at-least-once', idempotencyKey: `blocker-${i}` }),
        );
        await sleep(50);
        const outcome = await invoke('Execute', executeRequest(call), call);
        await Promise.all(blockers);
        return outcome;
      }
      return repeated(c, () => {
        switch (call.method) {
          case 'execute':
            return invoke('Execute', executeRequest(call), call);
          case 'health':
            return invoke('Health', {}, call);
          case 'getManifest':
            return invoke('GetManifest', {}, call);
          case 'testCredentials':
            return invoke('TestCredentials', call.testCredentials, call);
          case 'loadOptions':
            return invoke('LoadOptions', { nodeType: `${CONFORMANCE_PLUGIN_ID}.${call.node}`, method: call.loadOptions?.method, parameters: {} }, call);
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// MCP (2026-07-28 wire, Streamable HTTP at /mcp)
// ---------------------------------------------------------------------------

function mcpRunner(): Runner {
  const url = `http://127.0.0.1:${HTTP_PORT}/mcp`;
  return {
    face: 'mcp',
    run: (c) =>
      repeated(c, async () => {
        const { call } = c;
        if (call.method !== 'execute') return { outcome: 'skipped', reason: `MCP has no ${call.method}; tools/call only runs Execute`, elapsedMs: 0 };
        const timers = callTimers(call);
        const started = Date.now();
        try {
          if (timers.why() === 'expired') return { outcome: 'transport-error', code: 'expired', elapsedMs: 0 };
          const input = executeInput(call);
          const malformed = call.items?.some((item) => typeof item.json !== 'object' || item.json === null);
          const { body } = await mcpRequest(url, 'tools/call', { name: call.node, arguments: malformed ? 'not-an-object' : input.parameters }, { token: MCP_TOKEN, signal: timers.signal, name: call.node });
          const elapsedMs = Date.now() - started;
          if (timers.isLate()) return { outcome: 'transport-error', code: 'expired', elapsedMs };
          if (body?.error) {
            const code: TransportErrorCode = body.error.code === -32602 ? (/Unknown tool/.test(body.error.message) ? 'not_found' : 'bad_request') : body.error.code === -32603 ? 'internal' : 'bad_request';
            return { outcome: 'transport-error', code, errorMessage: body.error.message, elapsedMs };
          }
          const result = body!.result as { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: { items: JsonObject[] } };
          if (result.isError) return { outcome: 'node-error', errorMessage: result.content.map((part) => part.text ?? '').join('\n'), elapsedMs };
          const items: NodeItem[] = (result.structuredContent?.items ?? []).map((json) => ({ json }));
          return { outcome: 'reply', response: { outputs: [items] }, elapsedMs };
        } catch (error) {
          const why = timers.why();
          if (why) return { outcome: 'transport-error', code: why, elapsedMs: Date.now() - started };
          throw error;
        } finally {
          timers.clear();
        }
      }),
  };
}

// ---------------------------------------------------------------------------
// The suites
// ---------------------------------------------------------------------------

const savedSecret = process.env.LANDFLOW_TRANSPORT_SECRET;

beforeAll(async () => {
  process.env.LANDFLOW_TRANSPORT_SECRET = SECRET;
  const telemetry = await createTelemetry({ pluginId: CONFORMANCE_PLUGIN_ID, env: { OTEL_SDK_DISABLED: 'true' }, logWriter: () => {} });
  // The host side first, so it sees the plugin's first announce on the registry channel.
  client = await MessagingClient.start({ driver: broker.driver(), config: brokerConfig, keyring, registrySecret: null, log: silentLogger, statsIntervalMs: 0 });
  serving = await serve(conformancePlugin, {
    http: HTTP_PORT,
    grpc: GRPC_PORT,
    host: '127.0.0.1',
    maxConcurrency: 4,
    brokers: [memoryBinding],
    mcp: { token: MCP_TOKEN },
    registryUrl: false,
    telemetry,
  });
  for (let i = 0; i < 50 && !client.plugin(CONFORMANCE_PLUGIN_ID); i++) await sleep(20);
  expect(client.plugin(CONFORMANCE_PLUGIN_ID)?.instances).toHaveLength(1);
}, 20_000);

afterAll(async () => {
  await client?.close();
  await serving?.stop();
  if (savedSecret === undefined) delete process.env.LANDFLOW_TRANSPORT_SECRET;
  else process.env.LANDFLOW_TRANSPORT_SECRET = savedSecret;
});

const grpcClient = grpcRunner();
afterAll(() => grpcClient.close());
const runners: Runner[] = [httpRunner(), grpcClient, { face: 'messaging', run: (c) => messagingRunner(client!).run(c), lastDelivery: () => dispatched.at(-1)?.context.delivery }, mcpRunner()];

function assertCase(runner: Runner, c: ConformanceCase, outcome: Outcome, ranCount: number) {
  const { expect: expected } = c;
  const outcomes = Array.isArray(expected.outcome) ? expected.outcome : [expected.outcome];
  expect(outcomes, `${c.id}: outcome ${outcome.outcome} (${outcome.code ?? ''} ${outcome.errorMessage ?? ''})`).toContain(outcome.outcome);
  if (expected.code && outcome.outcome === 'transport-error') expect(outcome.code, `${c.id}: code`).toBe(expected.code);
  if (expected.outputs && outcome.response) expect(outputsMatch(expected.outputs, outcome.response.outputs), `${c.id}: outputs ${JSON.stringify(outcome.response.outputs)}`).toBe(true);
  if (expected.errorMessage) expect(outcome.errorMessage ?? '', `${c.id}: error message`).toContain(expected.errorMessage);
  if (expected.ran !== undefined) expect(ranCount > 0, `${c.id}: ran ${ranCount} times`).toBe(expected.ran);
  if (expected.signalAborted) expect(hooks.sleeps.at(-1)?.aborted, `${c.id}: signal aborted`).toBe(true);
  if (expected.withinMs !== undefined) expect(outcome.elapsedMs, `${c.id}: within ${expected.withinMs} ms`).toBeLessThanOrEqual(expected.withinMs);
  if (expected.deliveryMode && runner.lastDelivery) expect(runner.lastDelivery(), `${c.id}: delivery mode`).toBe(expected.deliveryMode);
  if (expected.count !== undefined && outcome.response) expect(outcome.response.outputs[0]?.[0]?.json.count, `${c.id}: count`).toBe(expected.count);
}

for (const runner of runners) {
  describe(`conformance over ${runner.face}`, () => {
    beforeEach(() => {
      hooks.reset();
      dispatched.length = 0;
    });
    for (const suite of loadConformanceSuites(runner.face)) {
      for (const c of suite.cases) {
        it(`${suite.suite}/${c.id}`, { timeout: 15_000 }, async ({ skip }) => {
          const outcome = await runner.run(c);
          if (outcome.outcome === 'skipped') skip(outcome.reason);
          // Give a late or dropped call time to show up before asserting it never ran (or that its signal fired); the kit
          // also asks runners to wait after `late-reply-dropped` and assert that exactly one outcome happened (vitest
          // fails on stray rejections).
          if (c.expect.ran === false || c.expect.signalAborted || c.id === 'late-reply-dropped') await settled();
          assertCase(runner, c, outcome, c.call.node ? hooks.byNode.get(c.call.node) ?? 0 : hooks.executions);
        });
      }
    }
  });
}

describe('conformance: MCP tool listing', () => {
  it('tools/list is the shared mapping of the served manifest, without _meta, for both protocol revisions', async () => {
    const url = `http://127.0.0.1:${HTTP_PORT}/mcp`;
    const expected = mcpToolsFromManifest(loadManifest()).map(withoutBinding);
    expect(expected.map((t) => t.name)).toEqual(['echo', 'sleep', 'fail', 'payload', 'counter']);
    const modern = await mcpRequest(url, 'tools/list', {}, { token: MCP_TOKEN });
    expect(modern.status).toBe(200);
    expect(modern.body?.result?.tools).toEqual(expected);
    expect(modern.body?.result).toMatchObject({ resultType: 'complete' });
    // 2025-11-25: the stateless legacy path (initialize, then tools/list).
    const legacy = async (method: string, params: unknown) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${MCP_TOKEN}`, 'mcp-protocol-version': '2025-11-25' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }).then(async (response) => JSON.parse((await response.text()).split('\n').find((line) => line.startsWith('data:'))!.slice(5)));
    const init = await legacy('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '0' } });
    expect(init.result.protocolVersion).toBe('2025-11-25');
    const list = await legacy('tools/list', {});
    expect(list.result.tools).toEqual(expected);
  });

  it('the mcp-tools fixture maps every synthetic manifest exactly', () => {
    for (const c of loadMcpToolsFixture().cases) expect(mcpToolsFromManifest(c.manifest), c.id).toEqual(c.tools);
  });
});
