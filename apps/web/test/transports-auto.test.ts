/**
 * Auto, phase 5 of docs/transports.md ("Choosing a transport per call"), simulated with fake clients and a fake clock:
 *
 * - stats.ts: 60 s windows, latency per method and size bucket with its fallbacks, failures and timeouts, in flight;
 * - breaker.ts: 5 in a row or more than half of the last 20 (once 10 are in), half-open after 15 s, one trial;
 * - classifyError: what moves (connection refused, DNS, gRPC UNAVAILABLE before sending, 429 / RESOURCE_EXHAUSTED /
 *   `lferror: capacity`) and what doesn't (timeouts, node errors in a reply, anything after the call may have gone out);
 * - the selector with the controller's inputs: low traffic stays direct; bursts spill over to a buffering broker and
 *   come back; oversized calls skip small-message brokers; failover and recovery through the breaker; no flapping
 *   (≥ 20 % better for three 10 s windows, then a 60 s hold); capacity refusals move once and feed spill-over;
 *   interactive calls never spill to a buffering broker while direct is healthy; the feed events;
 * - the registry: a 429 with Retry-After moves the call once (`auto.failover` on the span) and holds the endpoint.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@landflow/protocol';
import { defineNode, definePlugin } from '@landflow/sdk';
import { RemoteError, TimeoutError as MessagingTimeoutError, UndeliverableError } from '@landflow/transports';
import type { RegistryEvent } from '@/lib/shared/types';
import type { TransportCapabilities, TransportChoice, TransportPolicy } from '@/lib/shared/transports';

vi.setConfig({ testTimeout: 20_000 });
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-transports-auto-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_ENCRYPTION_KEY: 'transports-auto-test-key' });

const { AUTO, classifyError, parseRetryAfter, TransportAuto, transportAuto } = await import('@/lib/server/transports/auto');
const { CircuitBreaker } = await import('@/lib/server/transports/breaker');
const { isInteractive, scoreParts, select, spillThreshold } = await import('@/lib/server/transports/selector');
const { sizeBucket, TransportStats } = await import('@/lib/server/transports/stats');
const { registry } = await import('@/lib/server/plugins/registry');
const { createFetchHandler } = await import('@landflow/sdk/http');
type Candidate = import('@/lib/server/transports/selector').Candidate;
type CallContext = import('@/lib/server/transports/selector').CallContext;
type AutoEndpoint = import('@/lib/server/transports/auto').AutoEndpoint;

const GRPC = 'grpc://127.0.0.1:7420';
const HTTP = 'http://127.0.0.1:7421';
const JETSTREAM = 'jetstream://tmp/p';
const NATS = 'nats://tmp/p';
const KAFKA = 'kafka://tmp/p';
const DIRECT: TransportCapabilities = { maxMessageBytes: 64 * 1024 * 1024, delivery: ['at-most-once'], latency: 'low', buffering: false };
const CAPABILITIES: Record<string, TransportCapabilities> = {
  grpc: DIRECT,
  http: DIRECT,
  jetstream: { maxMessageBytes: 1024 * 1024, delivery: ['at-most-once', 'at-least-once'], latency: 'low', buffering: true },
  nats: { maxMessageBytes: 1024 * 1024, delivery: ['at-most-once'], latency: 'low', buffering: false },
  kafka: { maxMessageBytes: 1024 * 1024, delivery: ['at-most-once', 'at-least-once'], latency: 'medium', buffering: true },
};
const online = (endpoint: string, kind: string): Candidate => ({ endpoint, kind, status: 'online' });
const PRODUCTION: CallContext = { method: 'Execute', mode: 'production', payloadBytes: 512 };
const MANUAL: CallContext = { method: 'Execute', mode: 'manual', payloadBytes: 512 };
const POLICY: TransportPolicy = { mode: 'auto', objective: 'balanced' };

/** A plugin with fake endpoints on a fake clock: calls are chosen through the selector and run through the controller. */
function world(options: { kinds?: string[]; limit?: number; policy?: TransportPolicy; queue?: Record<string, { depth?: number; consumers?: number; lag?: number }> } = {}) {
  let now = 1_700_000_000_000;
  const clock = () => now;
  const events: RegistryEvent[] = [];
  const policy = options.policy ?? POLICY;
  const auto = new TransportAuto({
    now: clock,
    emit: (event) => events.push(event),
    policyOf: () => policy,
    base: { capabilities: (kind) => CAPABILITIES[kind], maxConcurrency: () => options.limit ?? 16, queue: (endpoint) => options.queue?.[endpoint] },
  });
  const endpoints = new Map<string, { kind: string; latencyMs: number; fail?: () => Error; health: boolean }>();
  for (const endpoint of options.kinds ?? [GRPC, HTTP, JETSTREAM, NATS]) {
    const kind = endpoint.split(':')[0]!;
    endpoints.set(endpoint, { kind, latencyMs: kind === 'grpc' ? 4 : kind === 'http' ? 6 : 12, health: true });
  }
  const source = {
    autoEndpoints: (): AutoEndpoint[] =>
      [...endpoints.entries()].map(([endpoint, e]) => ({
        pluginId: 'p',
        pluginName: 'Text Toolkit',
        endpoint,
        kind: e.kind,
        status: 'online',
        health: async () => {
          if (!e.health) throw new Error('connect ECONNREFUSED');
        },
      })),
  };
  auto.start(source);
  auto.stop(); // No real timer: the tests tick on the fake clock.
  const inputs = auto.inputs();
  const candidates = () => [...endpoints.entries()].map(([endpoint, e]) => online(endpoint, e.kind));
  const choose = (ctx: CallContext = PRODUCTION, except?: string) => {
    const selection = select('p', candidates().filter((c) => c.endpoint !== except), policy, ctx, inputs);
    if (!('endpoint' in selection)) throw new Error(selection.error);
    return selection;
  };
  /** Start a call: it stays in flight until `done()`; the fake endpoint's latency passes on the clock. */
  const start = (ctx: CallContext = PRODUCTION, except?: string) => {
    const choice = choose(ctx, except);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const promise = auto.run({ pluginId: 'p', pluginName: 'Text Toolkit', choice, context: ctx }, async () => {
      await gate;
      const e = endpoints.get(choice.endpoint)!;
      now += e.latencyMs;
      if (e.fail) throw e.fail();
      return 'ok';
    });
    return { choice, done: () => release(), promise };
  };
  /** One call, start to finish. */
  const call = async (ctx: CallContext = PRODUCTION, except?: string): Promise<TransportChoice> => {
    const { choice, done, promise } = start(ctx, except);
    done();
    await promise.catch(() => {});
    return choice;
  };
  const advance = (ms: number) => (now += ms);
  const tick = () => auto.tick();
  return { auto, inputs, events, endpoints, choose, start, call, advance, tick, clock };
}

// ---------------------------------------------------------------------------
// Stats and breaker
// ---------------------------------------------------------------------------

describe('transport stats', () => {
  it('buckets sizes, averages per method and bucket with fallbacks, and forgets what left the 60 s window', () => {
    let now = 0;
    const stats = new TransportStats(() => now);
    expect([sizeBucket(undefined), sizeBucket(100), sizeBucket(10_000), sizeBucket(100_000), sizeBucket(2 * 1024 * 1024), sizeBucket(20 * 1024 * 1024)]).toEqual(['xs', 'xs', 's', 'm', 'l', 'xl']);
    stats.begin('p', GRPC, 'grpc');
    expect(stats.inflight(GRPC)).toBe(1);
    expect(stats.inflightDirect('p')).toBe(1);
    stats.end(GRPC, { method: 'Execute', bucket: 'xs', ms: 10, outcome: 'ok' });
    stats.begin('p', GRPC, 'grpc');
    stats.end(GRPC, { method: 'Execute', bucket: 'm', ms: 30, outcome: 'ok' });
    stats.begin('p', GRPC, 'grpc');
    stats.end(GRPC, { method: 'LoadOptions', bucket: 'xs', ms: 50, outcome: 'remote' });
    stats.probe('p', GRPC, 'grpc', 2, true);
    expect(stats.inflight(GRPC)).toBe(0);
    expect(stats.latencyMs(GRPC, 'Execute', 'xs')).toBe(10);
    expect(stats.latencyMs(GRPC, 'Execute', 'l')).toBe(20); // the method's mean
    expect(stats.latencyMs(GRPC, 'TestCredentials')).toBe(30); // every call's mean, probes left out
    expect(stats.percentiles(GRPC)).toEqual({ p50Ms: 30, p95Ms: 50, calls: 3 });
    expect(stats.calls(GRPC)).toBe(3);
    expect(stats.errorRate(GRPC)).toBe(0);
    now = 61_000;
    expect(stats.latencyMs(GRPC)).toBeUndefined();
    expect(stats.percentiles(GRPC)).toBeUndefined();
    stats.probe('p', GRPC, 'grpc', 3, true);
    expect(stats.latencyMs(GRPC)).toBe(3); // the probe, as a last resort
  });

  it('counts transport failures and timeouts, not node errors in a reply, and keeps the last 20 outcomes', () => {
    const stats = new TransportStats(() => 0);
    for (let i = 0; i < 18; i++) {
      stats.begin('p', HTTP, 'http');
      stats.end(HTTP, { method: 'Execute', ms: 5, outcome: i % 3 === 0 ? 'remote' : 'ok' });
    }
    stats.begin('p', HTTP, 'http');
    stats.end(HTTP, { method: 'Execute', ms: 2000, outcome: 'timeout' });
    stats.begin('p', HTTP, 'http');
    stats.end(HTTP, { method: 'Execute', ms: 0, outcome: 'failure' });
    stats.begin('p', HTTP, 'http');
    stats.end(HTTP, { method: 'Execute', ms: 0, outcome: 'skipped' });
    expect(stats.failures(HTTP)).toEqual({ consecutive: 2, recent: 2, of: 20 });
    expect(stats.errorRate(HTTP)).toBe(0.1);
    expect(stats.inflight(HTTP)).toBe(0);
    // Timed-out and failed calls leave no latency sample.
    expect(stats.percentiles(HTTP)?.p95Ms).toBe(5);
  });
});

describe('circuit breaker', () => {
  it('opens after 5 failures in a row, is half-open after 15 s, closes on a successful trial', () => {
    let now = 0;
    const breaker = new CircuitBreaker(() => now);
    for (let i = 0; i < 4; i++) expect(breaker.record(false)).toBeUndefined();
    expect(breaker.state()).toBe('closed');
    expect(breaker.record(false)).toBe('opened');
    expect(breaker.cause).toBe('5 failures in a row');
    expect(breaker.allows()).toBe(false);
    now = 14_999;
    expect(breaker.state()).toBe('open');
    now = 15_000;
    expect(breaker.state()).toBe('half-open');
    expect(breaker.allows()).toBe(true); // one trial…
    expect(breaker.allows()).toBe(false); // …at a time
    expect(breaker.record(false)).toBe('opened');
    now = 31_000;
    expect(breaker.allows()).toBe(true);
    expect(breaker.record(true)).toBe('closed');
    expect(breaker.state()).toBe('closed');
    expect(breaker.allows()).toBe(true);
  });

  it('opens when more than half of the last 20 failed, once 10 outcomes are in', () => {
    const breaker = new CircuitBreaker(() => 0);
    // Two of two failed is 100 %, but too few to judge.
    const fresh = new CircuitBreaker(() => 0);
    expect(fresh.record(false)).toBeUndefined();
    expect(fresh.record(false)).toBeUndefined();
    expect(fresh.state()).toBe('closed');
    for (let i = 0; i < 10; i++) expect(breaker.record(true)).toBeUndefined();
    for (let i = 0; i < 10; i++) expect(breaker.record(i % 2 === 1)).toBeUndefined(); // 5 of the last 20
    expect(breaker.state()).toBe('closed');
    // Two failures, a success, two failures…: the ring fills with failures without ever 5 in a row.
    const pattern = [false, false, true, false, false, true, false, false];
    const changes = pattern.map((ok) => breaker.record(ok));
    expect(changes.slice(0, 7)).toEqual(Array(7).fill(undefined)); // up to 10 of 20
    expect(changes[7]).toBe('opened'); // 11 of the last 20, with only 2 in a row
    expect(breaker.cause).toBe('11 of the last 20 calls failed');
    expect(breaker.cause).toMatch(/of the last 20 calls failed/);
  });
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

describe('classifyError', () => {
  it('moves only what provably was not delivered or was refused for capacity', () => {
    expect(classifyError(new UndeliverableError('no responders', 'unroutable'))).toMatchObject({ kind: 'undelivered', movable: true });
    expect(classifyError(new UndeliverableError('aborted', 'aborted'))).toMatchObject({ kind: 'aborted', movable: false });
    expect(classifyError(new MessagingTimeoutError('deadline', 1))).toMatchObject({ kind: 'timeout', movable: false });
    expect(classifyError(new RemoteError('busy', 'capacity', { retryAfterMs: 1500 }))).toEqual({ kind: 'capacity', movable: true, retryAfterMs: 1500 });
    expect(classifyError(new RemoteError('boom', 'internal'))).toMatchObject({ kind: 'remote', movable: false });
    expect(classifyError(Object.assign(new Error('14 UNAVAILABLE: No connection established'), { code: 14, details: 'No connection established. Last error: connect ECONNREFUSED 127.0.0.1:7420' }))).toMatchObject({ kind: 'undelivered', movable: true });
    expect(classifyError(Object.assign(new Error('14 UNAVAILABLE: stream reset'), { code: 14, details: 'stream reset' }))).toMatchObject({ kind: 'failure', movable: false });
    expect(classifyError(Object.assign(new Error('8 RESOURCE_EXHAUSTED'), { code: 8, metadata: { get: () => ['2'] } }))).toEqual({ kind: 'capacity', movable: true, retryAfterMs: 2000 });
    expect(classifyError(Object.assign(new Error('4 DEADLINE_EXCEEDED'), { code: 4 }))).toMatchObject({ kind: 'timeout' });
    expect(classifyError(Object.assign(new Error('13 INTERNAL'), { code: 13 }))).toMatchObject({ kind: 'remote' });
    expect(classifyError(Object.assign(new Error('429 from http://x/execute: busy'), { status: 429, retryAfterMs: 1000 }))).toEqual({ kind: 'capacity', movable: true, retryAfterMs: 1000 });
    expect(classifyError(Object.assign(new Error('500 from http://x/execute: boom'), { status: 500 }))).toMatchObject({ kind: 'remote' });
    expect(classifyError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toMatchObject({ kind: 'undelivered', movable: true });
    expect(classifyError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }))).toMatchObject({ kind: 'undelivered' });
    expect(classifyError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toMatchObject({ kind: 'failure', movable: false });
    expect(classifyError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))).toMatchObject({ kind: 'timeout' });
    expect(classifyError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toMatchObject({ kind: 'aborted' });
    expect(classifyError(new Error('socket hang up'))).toMatchObject({ kind: 'failure', movable: false });
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Simulations
// ---------------------------------------------------------------------------

describe('Auto simulations', () => {
  it('scores the expected time to finish: a direct kind’s penalty grows near the limit, a broker’s with depth ÷ consumers', () => {
    const w = world({ queue: { [JETSTREAM]: { depth: 40, consumers: 2 } } });
    const grpc = online(GRPC, 'grpc');
    const js = online(JETSTREAM, 'jetstream');
    const idle = scoreParts(grpc, PRODUCTION, w.inputs, { pluginId: 'p' });
    expect(idle).toMatchObject({ baseMs: 4, queueMs: 0, errorMs: 0, total: 4 });
    // 20 waiting over 2 consumers at the prior's 12 ms each.
    expect(scoreParts(js, PRODUCTION, w.inputs, { pluginId: 'p' })).toMatchObject({ baseMs: 12, queueMs: 240, total: 252 });
    // 12 of 16 in flight (75 %): 3× the base in queueing; at 80 % it is 4×, at 95 % 19×.
    const inflight = Array.from({ length: 12 }, () => w.start());
    expect(scoreParts(grpc, PRODUCTION, w.inputs, { pluginId: 'p' }).queueMs).toBeCloseTo(12, 5);
    // The latency objective doubles queueing; throughput halves a buffering broker's.
    expect(scoreParts(grpc, PRODUCTION, w.inputs, { pluginId: 'p', objective: 'latency' }).queueMs).toBeCloseTo(24, 5);
    expect(scoreParts(js, PRODUCTION, w.inputs, { pluginId: 'p', objective: 'throughput' }).queueMs).toBe(120);
    inflight.forEach((c) => c.done());
    expect(spillThreshold(16)).toBe(12);
    expect(spillThreshold(16, 'latency')).toBe(16);
    expect(spillThreshold(16, 'throughput')).toBe(9);
    expect(spillThreshold(2)).toBe(1);
    expect(isInteractive(PRODUCTION)).toBe(false);
    expect(isInteractive(MANUAL)).toBe(true);
    expect(isInteractive({ method: 'LoadOptions' })).toBe(true);
    expect(isInteractive({ method: 'Execute', mode: 'mcp' })).toBe(true);
    expect(isInteractive({ method: 'ReceiveWebhook', mode: 'production' })).toBe(true);
  });

  it('low traffic stays direct: every call goes over gRPC, the main kind settles on it, nothing is said', async () => {
    const w = world();
    for (let i = 0; i < 50; i++) {
      expect(await w.call()).toMatchObject({ kind: 'grpc', reason: 'auto.latency' });
      w.advance(200);
      await w.tick();
    }
    expect(w.auto.mainOf('p')).toBe('grpc');
    expect(w.events).toEqual([]);
    expect(w.auto.summary('p', 'grpc', [GRPC])).toMatchObject({ p50Ms: 4, p95Ms: 4, inflight: 0, limit: 16, errorRate: 0, calls: 50, breaker: 'closed', main: true });
    // The Plugins page sees one choice for the next call: gRPC, no detail.
    expect(w.choose()).toEqual({ endpoint: GRPC, kind: 'grpc', reason: 'auto.latency' });
  });

  it('bursts spill over to the buffering broker past 80 % of maxConcurrency, with the feed line, and come back', async () => {
    const w = world();
    await w.tick(); // main: gRPC
    const inflight = Array.from({ length: 12 }, () => w.start());
    expect(inflight.every((c) => c.choice.kind === 'grpc')).toBe(true);
    const spilled = w.start();
    expect(spilled.choice).toEqual({ endpoint: JETSTREAM, kind: 'jetstream', reason: 'auto.spillover', detail: 'gRPC at 12 of 16 calls' });
    expect(w.events.at(-1)).toMatchObject({ type: 'plugin.transport', change: 'spillover', kind: 'jetstream', message: expect.stringMatching(/^Text Toolkit now spills over to NATS JetStream: gRPC at 12 of 16 calls/) });
    // More of the burst keeps spilling, with one feed line only.
    const more = Array.from({ length: 5 }, () => w.start());
    expect(more.every((c) => c.choice.kind === 'jetstream' && c.choice.reason === 'auto.spillover')).toBe(true);
    expect(w.events.filter((e) => e.type === 'plugin.transport' && e.change === 'spillover')).toHaveLength(1);
    expect(w.auto.summary('p', 'jetstream', [JETSTREAM])).toMatchObject({ inflight: 6, spilling: true });
    // NATS core doesn't buffer: never a spill-over target.
    expect(more.some((c) => c.choice.kind === 'nats')).toBe(false);
    for (const c of [...inflight, spilled, ...more]) c.done();
    await Promise.all([...inflight, spilled, ...more].map((c) => c.promise));
    // The burst is over: direct again, and after the hold the feed says so.
    expect(w.choose()).toMatchObject({ kind: 'grpc', reason: 'auto.latency' });
    w.advance(AUTO.SPILL_HOLD_MS + 1);
    await w.call();
    expect(w.events.at(-1)).toMatchObject({ change: 'direct', kind: 'grpc', message: 'Text Toolkit back on gRPC' });
  });

  it('objectives: latency spills only when the plugin is full, throughput sooner', () => {
    const latency = world({ policy: { mode: 'auto', objective: 'latency' } });
    const busy = Array.from({ length: 15 }, () => latency.start());
    expect(latency.choose().kind).toBe('grpc');
    busy.push(latency.start());
    expect(latency.choose()).toMatchObject({ kind: 'jetstream', reason: 'auto.spillover', detail: 'gRPC at 16 of 16 calls' });
    const throughput = world({ policy: { mode: 'auto', objective: 'throughput' } });
    Array.from({ length: 9 }, () => throughput.start());
    expect(throughput.choose()).toMatchObject({ kind: 'jetstream', reason: 'auto.spillover' });
  });

  it('oversized calls skip small-message brokers and stay direct, even in a burst; a brokers-only plugin says so', () => {
    const w = world();
    Array.from({ length: 14 }, () => w.start());
    const big = { ...PRODUCTION, payloadBytes: 2 * 1024 * 1024 };
    expect(w.choose(big)).toEqual({ endpoint: GRPC, kind: 'grpc', reason: 'auto.size' });
    expect(w.choose({ ...PRODUCTION, payloadBytes: 512 * 1024 })).toMatchObject({ kind: 'jetstream', reason: 'auto.spillover' });
    const brokers = world({ kinds: [JETSTREAM, NATS] });
    expect(() => brokers.choose(big)).toThrow('too large for every online transport');
    expect(brokers.choose({ ...PRODUCTION, payloadBytes: 1024 })).toMatchObject({ kind: expect.stringMatching(/^(nats|jetstream)$/), reason: 'auto.latency' }); // equal priors
    expect(brokers.choose(MANUAL)).toMatchObject({ kind: 'nats' }); // interactive: the non-buffering low-latency broker first
  });

  it('interactive calls never spill to a buffering broker while direct is healthy', () => {
    const w = world();
    Array.from({ length: 16 }, () => w.start());
    expect(w.choose(MANUAL)).toMatchObject({ kind: 'grpc', reason: 'auto.latency' });
    expect(w.choose({ method: 'Execute', mode: 'mcp' })).toMatchObject({ kind: 'grpc' });
    expect(w.choose({ method: 'LoadOptions', mode: 'manual' })).toMatchObject({ kind: 'grpc' });
    expect(w.choose({ method: 'TestCredentials', mode: 'manual' })).toMatchObject({ kind: 'grpc' });
    expect(w.choose({ method: 'ReceiveWebhook', mode: 'production' })).toMatchObject({ kind: 'grpc' });
    expect(w.choose(PRODUCTION)).toMatchObject({ kind: 'jetstream', reason: 'auto.spillover' });
  });

  it('failover and recovery through the breaker: refused connections open it, the trial probe closes it', async () => {
    const w = world();
    await w.tick();
    expect(w.auto.mainOf('p')).toBe('grpc');
    const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    w.endpoints.get(GRPC)!.fail = refused;
    w.endpoints.get(GRPC)!.health = false;
    for (let i = 0; i < 5; i++) {
      const { choice, done, promise } = w.start();
      expect(choice.kind).toBe('grpc');
      done();
      await expect(promise).rejects.toThrow('fetch failed');
      // The registry would move each of these once (provably undelivered); here the next call shows the state.
    }
    expect(w.auto.breakerOf(GRPC).state()).toBe('open');
    expect(w.events.at(-1)).toMatchObject({ change: 'breaker.open', endpoint: GRPC, message: 'Text Toolkit: breaker open on grpc://127.0.0.1:7420 (5 failures in a row); half-open in 15 s' });
    // Production and interactive calls go to HTTP with the breaker as the reason; nobody spills while HTTP is healthy.
    expect(w.choose()).toEqual({ endpoint: HTTP, kind: 'http', reason: 'auto.breaker', detail: 'breaker open on grpc://127.0.0.1:7420' });
    expect(w.choose(MANUAL)).toMatchObject({ kind: 'http', reason: 'auto.breaker' });
    expect(w.auto.summary('p', 'grpc', [GRPC])).toMatchObject({ breaker: 'open', errorRate: 1, calls: 5 });
    // Both direct kinds down: interactive calls take the low-latency, non-buffering broker first.
    w.endpoints.get(HTTP)!.fail = refused;
    w.endpoints.get(HTTP)!.health = false;
    for (let i = 0; i < 5; i++) await w.call(MANUAL);
    expect(w.auto.breakerOf(HTTP).state()).toBe('open');
    expect(w.choose(MANUAL)).toMatchObject({ kind: 'nats', reason: 'auto.breaker' });
    expect(w.choose()).toMatchObject({ kind: expect.stringMatching(/^(nats|jetstream)$/), reason: 'auto.breaker' });
    // 15 s on: half-open; the probe is the trial. gRPC is back, HTTP still refuses.
    w.endpoints.get(GRPC)!.health = true;
    w.endpoints.get(GRPC)!.fail = undefined;
    w.advance(AUTO.PROBE_MS);
    await w.tick();
    expect(w.auto.breakerOf(GRPC).state()).toBe('closed');
    expect(w.auto.breakerOf(HTTP).state()).toBe('open');
    expect(w.events.filter((e) => e.type === 'plugin.transport' && e.change === 'breaker.closed').at(-1)).toMatchObject({ endpoint: GRPC, message: 'Text Toolkit: breaker closed on grpc://127.0.0.1:7420; back on gRPC' });
    // HTTP's trial probe failed: open again, and the feed said so.
    expect(w.events.at(-1)).toMatchObject({ change: 'breaker.open', endpoint: HTTP, message: expect.stringContaining('the trial call failed') });
    expect(w.choose()).toMatchObject({ kind: 'grpc', reason: 'auto.latency' });
    // Timeouts count against the endpoint too, node errors in a reply don't.
    w.endpoints.get(GRPC)!.fail = () => Object.assign(new Error('500 from grpc: node failed'), { status: 500 });
    for (let i = 0; i < 6; i++) await w.call();
    expect(w.auto.breakerOf(GRPC).state()).toBe('closed');
    w.endpoints.get(GRPC)!.fail = () => Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    for (let i = 0; i < 5; i++) await w.call();
    expect(w.auto.breakerOf(GRPC).state()).toBe('open');
  });

  it('no flapping: the main kind switches only after three 10 s windows at ≥ 20 % better and a 60 s hold', async () => {
    const w = world();
    await w.tick();
    expect(w.auto.mainOf('p')).toBe('grpc');
    // HTTP measures much faster than gRPC from now on (a slow gRPC proxy, say).
    w.endpoints.get(GRPC)!.latencyMs = 20;
    w.endpoints.get(HTTP)!.latencyMs = 5;
    const sample = async () => {
      for (let i = 0; i < 5; i++) {
        await w.call(); // over the main kind
        await w.call({ method: 'LoadOptions', mode: 'manual' }); // interactive: main too
      }
      // The challenger needs measurements of its own: the probes give it some, and the odd call it gets.
      for (let i = 0; i < 3; i++) w.auto.stats.probe('p', HTTP, 'http', 5, true);
      for (let i = 0; i < 3; i++) w.auto.stats.probe('p', GRPC, 'grpc', 20, true);
    };
    for (let window = 1; window <= 3; window++) {
      await sample();
      w.advance(AUTO.WINDOW_MS);
      await w.tick();
      expect(w.auto.mainOf('p')).toBe('grpc'); // three windows in, but the 60 s hold is not over
      expect(w.choose()).toMatchObject({ kind: 'grpc' });
    }
    while (w.clock() - 1_700_000_000_000 < AUTO.HOLD_MS) {
      await sample();
      w.advance(AUTO.WINDOW_MS);
      await w.tick();
    }
    expect(w.auto.mainOf('p')).toBe('http');
    expect(w.events.at(-1)).toMatchObject({ change: 'switch', kind: 'http', message: expect.stringMatching(/^Text Toolkit now prefers HTTP over gRPC: \d+ % faster for 30 s/) });
    expect(w.choose()).toMatchObject({ kind: 'http', reason: 'auto.latency' });
    expect(w.choose(MANUAL)).toMatchObject({ kind: 'http' });
    // gRPC gets fast again for one window: no switch back; a 15 % edge never switches.
    w.endpoints.get(GRPC)!.latencyMs = 2;
    await sample();
    w.advance(AUTO.WINDOW_MS);
    await w.tick();
    expect(w.auto.mainOf('p')).toBe('http');
    w.endpoints.get(GRPC)!.latencyMs = 4.3;
    for (let i = 0; i < 8; i++) {
      await sample();
      w.advance(AUTO.WINDOW_MS);
      await w.tick();
    }
    expect(w.auto.mainOf('p')).toBe('http');
    expect(w.events.filter((e) => e.type === 'plugin.transport' && e.change === 'switch')).toHaveLength(1);
  });

  it('capacity refusals hold the endpoint for Retry-After, move the call once and feed spill-over', async () => {
    const w = world();
    await w.tick();
    w.endpoints.get(GRPC)!.fail = () => Object.assign(new Error('429 from grpc: busy'), { status: 429, retryAfterMs: 1000 });
    const { choice, done, promise } = w.start();
    expect(choice.kind).toBe('grpc');
    done();
    await expect(promise).rejects.toThrow('429');
    expect(w.auto.classify(await promise.catch((e: unknown) => e))).toMatchObject({ kind: 'capacity', movable: true });
    expect(w.events.at(-1)).toMatchObject({ change: 'capacity', endpoint: GRPC, message: 'Text Toolkit: gRPC refused a call (capacity, retry after 1 s) — moved once, spilling over meanwhile' });
    // The moved call (the registry leaves the refusing endpoint out) and the next production calls spill over: the plugin is full.
    expect(w.choose(PRODUCTION, GRPC)).toMatchObject({ kind: 'jetstream', reason: 'auto.spillover', detail: 'HTTP at 16 of 16 calls' });
    expect(w.choose()).toMatchObject({ kind: 'jetstream', reason: 'auto.spillover' });
    // Interactive calls take the other direct kind meanwhile.
    expect(w.choose(MANUAL)).toEqual({ endpoint: HTTP, kind: 'http', reason: 'auto.breaker', detail: 'gRPC asked to wait 1 s (capacity)' });
    expect(w.auto.summary('p', 'grpc', [GRPC]).retryAfterUntil).toBeDefined();
    // A refusal is not a failure: the breaker stays closed.
    expect(w.auto.breakerOf(GRPC).state()).toBe('closed');
    w.advance(1001);
    w.endpoints.get(GRPC)!.fail = undefined;
    expect(w.choose()).toMatchObject({ kind: 'grpc', reason: 'auto.latency' });
  });

  it('keeps pinned and allow-list policies as they are', () => {
    const pinned = world({ policy: { mode: 'pinned', pinned: 'http', objective: 'balanced' } });
    Array.from({ length: 16 }, () => pinned.start());
    expect(pinned.choose()).toEqual({ endpoint: HTTP, kind: 'http', reason: 'pinned' });
    const allowed = world({ policy: { mode: 'auto', allowed: ['grpc', 'nats'], objective: 'balanced' } });
    Array.from({ length: 16 }, () => allowed.start());
    expect(allowed.choose()).toMatchObject({ kind: 'grpc', reason: 'auto.latency' }); // NATS core can't buffer: no spill-over target
    expect(allowed.choose(MANUAL)).toMatchObject({ kind: 'grpc' });
  });
});

// ---------------------------------------------------------------------------
// The registry: a 429 moves the call once
// ---------------------------------------------------------------------------

describe('registry: capacity refusals move once', () => {
  const PLUGIN_ID = 'tp-auto-echo';
  const spans = new InMemorySpanExporter();
  const plugin = definePlugin({
    info: { id: PLUGIN_ID, name: 'Auto Echo', version: '1.0.0' },
    nodes: [
      defineNode({
        description: { name: 'echo', displayName: 'Echo', description: '', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
        execute: (ctx) => ctx.getInputData().map((item) => ({ json: { ...item.json, echoed: true } })),
      }),
    ],
  });
  const servers: Server[] = [];
  const refusing = { left: 0, seen: 0 };
  const A = 'http://127.0.0.1:7422';
  const B = 'http://127.0.0.1:7423';

  const listen = (port: number, refuse: boolean) => {
    const handle = createFetchHandler(plugin);
    const server = createServer(async (req, res) => {
      if (refuse && req.url?.endsWith('/execute')) {
        refusing.seen++;
        if (refusing.left > 0) {
          refusing.left--;
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
          return void res.end(JSON.stringify({ error: 'capacity: 2 running, 2 waiting' }));
        }
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const response = await handle(new Request(`http://plugin${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, ...(chunks.length && { body: Buffer.concat(chunks) }) }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    servers.push(server);
    return new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  };
  const execute = async (mode: 'manual' | 'trigger' = 'trigger') => {
    const resolved = registry.resolve(`${PLUGIN_ID}.echo`);
    if ('error' in resolved) throw new Error(resolved.error);
    return resolved.execute({ protocol: PROTOCOL_VERSION, executionId: 'ex1', workflowId: 'wf1', mode, node: { id: 'n1', name: 'Echo', type: `${PLUGIN_ID}.echo`, typeVersion: 1 }, parameters: {}, itemParameters: [{}], inputs: [[{ json: { a: 1 } }]] });
  };
  const rpcSpans = () => spans.getFinishedSpans().filter((s) => s.name === 'plugin.rpc Execute');

  beforeAll(async () => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spans })] }));
    await listen(7422, true);
    await listen(7423, false);
    await registry.addEndpoint(A, 'manual');
    await registry.addEndpoint(B, 'manual');
  });

  afterAll(async () => {
    registry.remove(PLUGIN_ID);
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    trace.disable();
  });

  beforeEach(() => spans.reset());

  it('moves a 429 once to the other endpoint (auto.failover on the span), holds the refusing endpoint for Retry-After, then returns', async () => {
    refusing.left = 1;
    const response = await execute();
    expect(response.outputs?.[0]?.[0]?.json).toMatchObject({ a: 1, echoed: true });
    const reasons = rpcSpans().map((s) => [s.attributes['server.port'], s.attributes['landflow.transport.reason']]);
    expect(reasons).toEqual([
      [7422, 'only'],
      [7423, 'auto.failover'],
    ]);
    const summary = registry.list().find((p) => p.id === PLUGIN_ID)!;
    expect(summary.endpoints.find((e) => e.endpoint === A)?.auto?.retryAfterUntil).toBeDefined();
    expect(summary.transports?.find((t) => t.kind === 'http')?.auto).toMatchObject({ breaker: 'closed', inflight: 0, calls: 1 });
    // While the hold lasts, calls go to B straight away…
    spans.reset();
    await execute();
    expect(rpcSpans().map((s) => s.attributes['server.port'])).toEqual([7423]);
    // …and a second refusal in a row is not moved twice: refusing again after the hold ends.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    refusing.left = 1;
    spans.reset();
    await execute();
    expect(rpcSpans().map((s) => s.attributes['server.port'])).toEqual([7422, 7423]);
    expect(refusing.seen).toBe(2);
  });

  it('shows the feed line and the span reason for the moved call, and keeps the breaker closed (a refusal is not a failure)', () => {
    expect(transportAuto.breakerOf(A).state()).toBe('closed');
    expect(transportAuto.summary(PLUGIN_ID, 'http', [A, B])).toMatchObject({ calls: 3, errorRate: 0 });
  });
});
