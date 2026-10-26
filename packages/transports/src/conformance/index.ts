/**
 * `@landflow/transports/conformance`: the driver conformance suite (docs/transports.md "Brokers": "every driver passes the
 * same conformance kit against a local container").
 *
 * Call `runConformance(target)` at the top level of a vitest file. It declares two `describe` blocks:
 * - **driver**: every `BrokerDriver` member and every `BrokerCapabilities` claim (publish/consume, header round trip,
 *   work sharing across two consumers, broadcast, ack/nack/redelivery, a dying consumer, unroutable reporting, buffering,
 *   TTL, prefetch, native request/reply, stats, size);
 * - **core**: `MessagingClient` + `MessagingServer` end to end over the driver (call/reply, deadline, cancel, at most once
 *   vs at least once, a replica crash mid-call, discovery with registry proofs, manifest mismatch, tampered and unsigned
 *   events, size limits, concurrency, drain, instance channels, stats).
 *
 * Cases a capability rules out are skipped with the reason. Channel names get a random prefix per run, so several runs can
 * share one broker. Tests that need a broker must gate the whole file on an env var and skip with a message otherwise:
 *
 *     const url = process.env.LANDFLOW_TEST_KAFKA;
 *     if (!url) describe.skip('kafka driver (set LANDFLOW_TEST_KAFKA=127.0.0.1:59092)', () => {});
 *     else runConformance({ name: 'kafka', driver: () => kafkaDriver(), config: { connectionId: 'kafka-test', brokers: [url] } });
 */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecuteRequest, ExecuteResponse, PluginManifest } from '@landflow/protocol';
import { MessagingClient } from '../client';
import { Codec, silentLogger } from '../codec';
import { channelNames, channelSpecs } from '../channels';
import { NotConnectedError, type BrokerConfig, type BrokerDriver, type Delivery, type WireEvent } from '../driver';
import { hostSource, requestType } from '../envelope';
import { MemoryClaimStore } from '../claim';
import { CancelledError, ClaimUnavailableError, ManifestMismatchError, MessagingError, RemoteError, TimeoutError, UndeliverableError, ConnectionLostError } from '../errors';
import { Keyring } from '../security';
import { MessagingServer, type DispatchContext, type Dispatcher } from '../server';

export interface ConformanceTarget<C extends BrokerConfig = BrokerConfig> {
  /** Shown in test names. */
  name: string;
  /** A new, unconnected driver each time; all of them reach the same broker. */
  driver: () => BrokerDriver<C>;
  config: C;
  /** How long to wait for an asynchronous delivery (default 2 s; raise for slow brokers). */
  deliveryTimeoutMs?: number;
  /**
   * Optional: alter or drop events in flight (the memory broker's `tap`). Enables the cases that watch the wire
   * (ciphertext only, tampered replies). Real brokers do not have one; those cases are skipped.
   */
  tap?: (fn: (channel: string, event: WireEvent) => WireEvent | null) => () => void;
}

const SECRET = 'conformance-transport-secret';
const REGISTRY_SECRET = 'conformance-registry-secret';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Per-test timeout: real brokers rebalance for seconds, so it grows with `deliveryTimeoutMs` (vitest's default is 5 s). */
const testTimeout = (wait: number) => Math.max(5_000, wait * 8);

export async function waitFor(predicate: () => boolean, timeoutMs: number, what = 'condition'): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const sampleEvent = (body = 'hello'): WireEvent => ({
  headers: { 'content-type': 'application/json', specversion: '1.0', id: randomBytes(8).toString('hex'), type: 'dev.landflow.plugin.v1.health.request', lfsig: 'a'.repeat(64) },
  body: encoder.encode(body),
});

export function runConformance<C extends BrokerConfig>(target: ConformanceTarget<C>): void {
  runDriverConformance(target);
  runCoreConformance(target);
}

/** Every interface member and capability claim. */
export function runDriverConformance<C extends BrokerConfig>(target: ConformanceTarget<C>): void {
  const wait = target.deliveryTimeoutMs ?? 2_000;
  describe(`${target.name} driver conformance`, { timeout: testTimeout(wait) }, () => {
    const run = randomBytes(4).toString('hex');
    const caps = target.driver().capabilities;
    const drivers: BrokerDriver<C>[] = [];
    const connected = async () => {
      const driver = target.driver();
      await driver.connect(target.config);
      drivers.push(driver);
      return driver;
    };
    const channel = (name: string, delivery: 'shared' | 'broadcast' = 'shared') => ({ name: `lfconf.${run}.${name}`, role: 'request' as const, delivery, durable: delivery === 'shared' });
    afterEach(async () => {
      await Promise.allSettled(drivers.splice(0).map((d) => d.close()));
    });

    it('declares its kind and complete capabilities', () => {
      expect(caps.replies === 'native' || caps.replies === 'reply-channel').toBe(true);
      expect(typeof caps.workSharing).toBe('boolean');
      expect(typeof caps.buffering).toBe('boolean');
      expect(typeof caps.ttl).toBe('boolean');
      expect(['reported', 'inferred', 'unknown']).toContain(caps.undeliverable);
      expect(['memory', 'disk']).toContain(caps.persistence);
      expect(caps.maxMessageBytes).toBeGreaterThan(1024);
      expect(['low', 'medium', 'high']).toContain(caps.latency);
      expect(typeof caps.headers).toBe('boolean');
      expect(typeof caps.orderingKeys).toBe('boolean');
      expect(typeof caps.nack).toBe('boolean');
      expect(typeof caps.attempts).toBe('boolean');
      expect(target.driver().kind).toMatch(/^[a-z][a-z0-9]*$/);
      if (caps.replies === 'native') expect(typeof target.driver().request).toBe('function');
    });

    it('refuses to publish before connecting, with NotConnectedError', async () => {
      const driver = target.driver();
      await expect(driver.publish(channel('nc').name, sampleEvent())).rejects.toBeInstanceOf(NotConnectedError);
    });

    it('connects, declares channels (idempotently) and closes twice without error', async () => {
      const driver = await connected();
      await driver.declare([channel('declare'), channel('declare')]);
      await driver.declare([channel('declare')]);
      await driver.close();
      await driver.close();
    });

    it('delivers a published event to a consumer with its body intact', async () => {
      const driver = await connected();
      const spec = channel('roundtrip');
      await driver.declare([spec]);
      const got: WireEvent[] = [];
      await driver.consume(spec.name, { group: spec.name, prefetch: 4, ackMode: 'manual' }, async (event, delivery) => {
        got.push(event);
        await delivery.ack();
      });
      const outcome = await driver.publish(spec.name, sampleEvent('body-1'));
      expect(outcome).toBe('accepted');
      await waitFor(() => got.length === 1, wait, 'delivery');
      expect(decoder.decode(got[0].body)).toBe('body-1');
    });

    it(caps.headers ? 'carries headers by their bare lower-case names' : 'carries at least the body when it has no headers', async () => {
      const driver = await connected();
      const spec = channel('headers');
      await driver.declare([spec]);
      const got: WireEvent[] = [];
      await driver.consume(spec.name, { group: spec.name, prefetch: 4, ackMode: 'auto' }, async (event) => {
        got.push(event);
      });
      const sent = sampleEvent('h');
      sent.headers.lfdeadline = '1700000000000';
      sent.headers.subject = 'twilio.message';
      await driver.publish(spec.name, sent);
      await waitFor(() => got.length === 1, wait, 'delivery');
      if (caps.headers) {
        const { 'content-type': _ct, ...expected } = sent.headers;
        for (const [name, value] of Object.entries(expected)) expect(got[0].headers[name]).toBe(value);
        for (const name of Object.keys(got[0].headers)) expect(name).toBe(name.toLowerCase());
      }
      expect(decoder.decode(got[0].body)).toBe('h');
    });

    it(caps.workSharing ? 'shares one channel between two consumers in a group, each event delivered once' : 'skips work sharing (not supported)', async () => {
      if (!caps.workSharing) return;
      const a = await connected();
      const b = await connected();
      const spec = channel('share');
      await a.declare([spec]);
      const seen = { a: [] as string[], b: [] as string[] };
      const slow = (who: 'a' | 'b') => async (event: WireEvent, delivery: Delivery) => {
        seen[who].push(decoder.decode(event.body));
        await sleep(10);
        await delivery.ack();
      };
      await a.consume(spec.name, { group: spec.name, prefetch: 1, ackMode: 'manual' }, slow('a'));
      await b.consume(spec.name, { group: spec.name, prefetch: 1, ackMode: 'manual' }, slow('b'));
      const bodies = Array.from({ length: 20 }, (_, i) => `m${i}`);
      for (const body of bodies) await a.publish(spec.name, sampleEvent(body));
      await waitFor(() => seen.a.length + seen.b.length === 20, wait * 2, 'all deliveries');
      expect([...seen.a, ...seen.b].sort()).toEqual([...bodies].sort());
      expect(seen.a.length).toBeGreaterThan(0);
      expect(seen.b.length).toBeGreaterThan(0);
    });

    it('delivers every event to every consumer without a group (broadcast)', async () => {
      const driver = await connected();
      const spec = channel('broadcast', 'broadcast');
      await driver.declare([spec]);
      const a: string[] = [];
      const b: string[] = [];
      await driver.consume(spec.name, { prefetch: 8, ackMode: 'auto' }, async (e) => void a.push(decoder.decode(e.body)));
      await driver.consume(spec.name, { prefetch: 8, ackMode: 'auto' }, async (e) => void b.push(decoder.decode(e.body)));
      await driver.publish(spec.name, sampleEvent('x'));
      await driver.publish(spec.name, sampleEvent('y'));
      await waitFor(() => a.length === 2 && b.length === 2, wait, 'both consumers');
      expect(a).toEqual(['x', 'y']);
      expect(b).toEqual(['x', 'y']);
    });

    it(caps.nack ? 'redelivers after nack({ requeue: true }) and not after nack({ requeue: false })' : 'drops on nack (nack not supported)', async () => {
      const driver = await connected();
      const spec = channel('nack');
      await driver.declare([spec]);
      const attempts: number[] = [];
      const bodies: string[] = [];
      await driver.consume(spec.name, { group: spec.name, prefetch: 4, ackMode: 'manual' }, async (event, delivery) => {
        const body = decoder.decode(event.body);
        bodies.push(body);
        attempts.push(delivery.attempt);
        if (body === 'requeue' && delivery.attempt === 1) return delivery.nack({ requeue: true });
        if (body === 'drop') return delivery.nack({ requeue: false });
        return delivery.ack();
      });
      await driver.publish(spec.name, sampleEvent('requeue'));
      await driver.publish(spec.name, sampleEvent('drop'));
      if (caps.nack) {
        await waitFor(() => bodies.filter((b) => b === 'requeue').length === 2, wait, 'redelivery');
        if (caps.attempts) expect(attempts).toContain(2);
      } else await waitFor(() => bodies.length === 2, wait, 'deliveries');
      await sleep(50);
      expect(bodies.filter((b) => b === 'drop')).toHaveLength(1);
      expect(bodies.filter((b) => b === 'requeue')).toHaveLength(caps.nack ? 2 : 1);
    });

    it(caps.workSharing ? 'hands the unacknowledged deliveries of a closed consumer to another one' : 'skips consumer death (no work sharing)', async () => {
      if (!caps.workSharing) return;
      const a = await connected();
      const b = await connected();
      const spec = channel('death');
      await a.declare([spec]);
      let aGot = false;
      const bGot: WireEvent[] = [];
      const subA = await a.consume(spec.name, { group: spec.name, prefetch: 1, ackMode: 'manual' }, async () => {
        aGot = true; // never acks
      });
      await a.publish(spec.name, sampleEvent('orphan'));
      await waitFor(() => aGot, wait, 'first delivery');
      await b.consume(spec.name, { group: spec.name, prefetch: 1, ackMode: 'manual' }, async (event, delivery) => {
        bGot.push(event);
        await delivery.ack();
      });
      await subA.close();
      await waitFor(() => bGot.length === 1, wait * 2, 'redelivery to the survivor');
      expect(decoder.decode(bGot[0].body)).toBe('orphan');
    });

    it(`reports an event nobody can take as ${caps.undeliverable === 'reported' ? 'unroutable' : 'accepted (undeliverable: ' + caps.undeliverable + ')'}`, async () => {
      const driver = await connected();
      const spec = channel('nobody');
      await driver.declare([spec]);
      const outcome = await driver.publish(spec.name, sampleEvent());
      expect(outcome).toBe(caps.undeliverable === 'reported' ? 'unroutable' : 'accepted');
    });

    it(caps.buffering && caps.undeliverable !== 'reported' ? 'holds events published before a consumer arrives' : 'skips buffering (not claimed, or publishes to nobody are reported)', async () => {
      if (!caps.buffering || caps.undeliverable === 'reported') return;
      const driver = await connected();
      const spec = channel('buffer');
      await driver.declare([spec]);
      await driver.publish(spec.name, sampleEvent('early'));
      const got: string[] = [];
      await driver.consume(spec.name, { group: spec.name, prefetch: 4, ackMode: 'auto' }, async (e) => void got.push(decoder.decode(e.body)));
      await waitFor(() => got.length === 1, wait, 'buffered delivery');
      expect(got).toEqual(['early']);
    });

    it(caps.ttl && caps.buffering && caps.undeliverable !== 'reported' ? 'drops an event whose ttlMs passed before delivery' : 'skips TTL (not claimed or not observable)', async () => {
      if (!caps.ttl || !caps.buffering || caps.undeliverable === 'reported') return;
      const driver = await connected();
      const spec = channel('ttl');
      await driver.declare([spec]);
      await driver.publish(spec.name, sampleEvent('stale'), { ttlMs: 20 });
      await sleep(120);
      const got: string[] = [];
      await driver.consume(spec.name, { group: spec.name, prefetch: 4, ackMode: 'auto' }, async (e) => void got.push(decoder.decode(e.body)));
      await driver.publish(spec.name, sampleEvent('fresh'), { ttlMs: 60_000 });
      await waitFor(() => got.length >= 1, wait, 'fresh delivery');
      await sleep(50);
      expect(got).toEqual(['fresh']);
    });

    it('holds further deliveries while prefetch is exhausted', async () => {
      const driver = await connected();
      const spec = channel('prefetch');
      await driver.declare([spec]);
      const deliveries: Delivery[] = [];
      await driver.consume(spec.name, { group: spec.name, prefetch: 1, ackMode: 'manual' }, async (_e, delivery) => void deliveries.push(delivery));
      await driver.publish(spec.name, sampleEvent('1'));
      await driver.publish(spec.name, sampleEvent('2'));
      await waitFor(() => deliveries.length === 1, wait, 'first delivery');
      await sleep(100);
      expect(deliveries).toHaveLength(1);
      await deliveries[0].ack();
      await waitFor(() => deliveries.length === 2, wait, 'second delivery after ack');
      await deliveries[1].ack();
    });

    it(caps.orderingKeys ? 'keeps events with one ordering key in order' : 'skips ordering keys (not claimed)', async () => {
      if (!caps.orderingKeys) return;
      const driver = await connected();
      const spec = channel('order');
      await driver.declare([spec]);
      const got: string[] = [];
      await driver.consume(spec.name, { group: spec.name, prefetch: 1, ackMode: 'manual' }, async (e, d) => {
        got.push(decoder.decode(e.body));
        await d.ack();
      });
      const bodies = Array.from({ length: 10 }, (_, i) => `o${i}`);
      for (const body of bodies) await driver.publish(spec.name, sampleEvent(body), { orderingKey: 'exec-1' });
      await waitFor(() => got.length === 10, wait, 'all deliveries');
      expect(got).toEqual(bodies);
    });

    it(caps.replies === 'native' ? 'answers a native request through Delivery.reply, and reports timeout / unroutable' : 'skips native request/reply (reply-channel broker)', async () => {
      if (caps.replies !== 'native') return;
      const driver = await connected();
      const spec = channel('native');
      await driver.declare([spec]);
      if (caps.undeliverable === 'reported') expect((await driver.request!(spec.name, sampleEvent('q'), { timeoutMs: 500 })).outcome).toBe('unroutable');
      let answer = true;
      await driver.consume(spec.name, { group: spec.name, prefetch: 4, ackMode: 'manual' }, async (event, delivery) => {
        await delivery.ack();
        if (answer) await delivery.reply!({ headers: { ...event.headers, type: 'dev.landflow.plugin.v1.health.response' }, body: encoder.encode('a:' + decoder.decode(event.body)) });
      });
      const replied = await driver.request!(spec.name, sampleEvent('q'), { timeoutMs: wait });
      expect(replied.outcome).toBe('replied');
      if (replied.outcome === 'replied') {
        expect(decoder.decode(replied.event.body)).toBe('a:q');
        if (caps.headers) expect(replied.event.headers.type).toBe('dev.landflow.plugin.v1.health.response');
      }
      answer = false;
      expect((await driver.request!(spec.name, sampleEvent('q'), { timeoutMs: 100 })).outcome).toBe('timeout');
    });

    it(target.driver().stats ? 'reports consumers (and depth where it can) in stats' : 'has no stats (optional)', async () => {
      const driver = await connected();
      if (!driver.stats) return;
      const spec = channel('stats');
      await driver.declare([spec]);
      const before = await driver.stats(spec.name);
      if (before.consumers !== undefined) expect(before.consumers).toBe(0);
      const deliveries: Delivery[] = [];
      await driver.consume(spec.name, { group: spec.name, prefetch: 1, ackMode: 'manual' }, async (_e, d) => void deliveries.push(d));
      let during = await driver.stats(spec.name);
      for (let i = 0; i < 50 && during.consumers !== undefined && during.consumers < 1; i++) {
        await sleep(wait / 50);
        during = await driver.stats(spec.name);
      }
      if (during.consumers !== undefined) expect(during.consumers).toBeGreaterThanOrEqual(1);
      if (caps.buffering) {
        await driver.publish(spec.name, sampleEvent('1'));
        await driver.publish(spec.name, sampleEvent('2'));
        await waitFor(() => deliveries.length === 1, wait, 'first delivery');
        const queued = await driver.stats(spec.name);
        if (queued.depth !== undefined) expect(queued.depth + (queued.lag ?? 0)).toBeGreaterThanOrEqual(1);
        for (const d of deliveries) await d.ack();
      }
    });

    it('carries an event of half maxMessageBytes', async () => {
      const driver = await connected();
      const spec = channel('big');
      await driver.declare([spec]);
      const got: WireEvent[] = [];
      await driver.consume(spec.name, { group: spec.name, prefetch: 1, ackMode: 'auto' }, async (e) => void got.push(e));
      const big = sampleEvent('x'.repeat(Math.min(Math.floor(caps.maxMessageBytes / 2), 4 * 1024 * 1024)));
      await driver.publish(spec.name, big);
      await waitFor(() => got.length === 1, wait * 3, 'big delivery');
      expect(got[0].body.byteLength).toBe(big.body.byteLength);
    });
  });
}

type Seen = { method: string; context: DispatchContext; body: unknown };

/** The core end to end over the driver. */
export function runCoreConformance<C extends BrokerConfig>(target: ConformanceTarget<C>): void {
  const wait = target.deliveryTimeoutMs ?? 2_000;
  describe(`${target.name} core conformance`, { timeout: testTimeout(wait) }, () => {
    const caps = target.driver().capabilities;
    const keyring = new Keyring(SECRET);
    const prefix = `lfcore${randomBytes(3).toString('hex')}`;
    const config = { ...target.config, prefix } as C;
    const names = channelNames(prefix);
    const cleanups: (() => Promise<unknown>)[] = [];
    const manifest = (pluginId: string): PluginManifest => ({
      protocol: 'landflow.plugin/v1',
      plugin: { id: pluginId, name: 'Conformance', version: '1.0.0', language: 'typescript' },
      nodes: [
        { name: 'echo', displayName: 'Echo', description: '', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
        { name: 'lookup', displayName: 'Lookup', description: '', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [], idempotent: true },
      ],
      maxConcurrency: 2,
    });
    const execute = (pluginId: string, node = 'echo', extra: Partial<ExecuteRequest> = {}): ExecuteRequest => ({
      protocol: 'landflow.plugin/v1',
      executionId: 'exec-1',
      mode: 'manual',
      node: { id: 'n1', name: node, type: `${pluginId}.${node}`, typeVersion: 1 },
      parameters: {},
      itemParameters: [{}],
      inputs: [[{ json: { hello: 'world' } }]],
      credentials: { api: { token: 'top-secret-token' } },
      ...extra,
    });
    const echoDispatcher = (seen: Seen[] = [], hook?: (context: DispatchContext, body: unknown) => Promise<unknown> | unknown): Dispatcher => async (method, body, context) => {
      seen.push({ method, context, body });
      const hooked = await hook?.(context, body);
      if (hooked !== undefined) return hooked as never;
      if (method === 'Execute') return { outputs: [(body as unknown as ExecuteRequest).inputs[0]] } satisfies ExecuteResponse as never;
      if (method === 'Health') return { status: 'ok', uptimeMs: 1, pluginId: 'x', version: '1' } as never;
      if (method === 'LoadOptions') return { options: [{ name: 'A', value: 'a' }] } as never;
      return {} as never;
    };
    const startServer = async (pluginId: string, dispatch: Dispatcher, extra: Partial<ConstructorParameters<typeof MessagingServer<C>>[0]> = {}) => {
      const server = await MessagingServer.start<C>({ driver: target.driver(), config, keyring, pluginId, version: '1.0.0', manifest: manifest(pluginId), dispatch, registrySecret: REGISTRY_SECRET, announceIntervalMs: 250, drainTimeoutMs: 200, log: silentLogger, ...extra });
      cleanups.push(() => server.stop());
      return server;
    };
    const startClient = async (extra: Partial<ConstructorParameters<typeof MessagingClient<C>>[0]> = {}) => {
      const client = await MessagingClient.start<C>({ driver: target.driver(), config, keyring, registrySecret: REGISTRY_SECRET, statsIntervalMs: 0, log: silentLogger, ...extra });
      cleanups.push(() => client.close());
      return client;
    };
    const pluginId = () => `conf-${randomBytes(3).toString('hex')}`;
    const announced = (client: MessagingClient<C>, id: string, instances = 1) => waitFor(() => (client.plugin(id)?.instances.length ?? 0) >= instances, wait, `announce of ${id}`);

    afterEach(async () => {
      await Promise.allSettled(cleanups.splice(0).reverse().map((fn) => fn()));
    });

    it('calls a plugin and gets its reply, with the credentials intact end to end', async () => {
      const id = pluginId();
      const seen: Seen[] = [];
      const server = await startServer(id, echoDispatcher(seen));
      const client = await startClient();
      await announced(client, id);
      const reply = await client.invoke(id, 'Execute', execute(id), { timeoutMs: wait });
      expect(reply.body.outputs[0][0].json).toEqual({ hello: 'world' });
      expect(reply.instanceId).toBe(server.instanceId);
      expect(reply.attributes.type).toBe('dev.landflow.plugin.v1.execute.response');
      expect(reply.attributes.lfmanifest).toBe(server.manifestHash);
      expect((seen[0].body as ExecuteRequest).credentials).toEqual({ api: { token: 'top-secret-token' } });
      expect(seen[0].context.delivery).toBe('at-most-once');
      expect(seen[0].context.attempt).toBe(1);
      const health = await client.call(id, 'Health', {}, { timeoutMs: wait });
      expect(health.status).toBe('ok');
      expect(seen[1].context.delivery).toBe('at-least-once');
    });

    it(target.tap ? 'puts only ciphertext on the wire' : 'skips the wire inspection (no tap)', async () => {
      if (!target.tap) return;
      const id = pluginId();
      await startServer(id, echoDispatcher());
      const client = await startClient();
      await announced(client, id);
      const bodies: string[] = [];
      const untap = target.tap((channel, event) => {
        if (channel === names.request(id) || channel.startsWith(`${prefix}.v1.reply.`) || channel.endsWith(':reply')) bodies.push(Buffer.from(event.body).toString('latin1') + JSON.stringify(event.headers));
        return event;
      });
      await client.call(id, 'Execute', execute(id), { timeoutMs: wait });
      untap();
      expect(bodies.length).toBeGreaterThanOrEqual(1);
      for (const body of bodies) {
        expect(body).not.toContain('top-secret-token');
        expect(body).not.toContain('hello');
      }
    });

    it('fails with TimeoutError at the deadline and aborts the dispatcher', async () => {
      const id = pluginId();
      const seen: Seen[] = [];
      await startServer(id, echoDispatcher(seen, (context) => new Promise((_, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason)))));
      const client = await startClient();
      await announced(client, id);
      const error = await client.call(id, 'Execute', execute(id), { timeoutMs: 300 }).catch((e) => e);
      expect(error).toBeInstanceOf(TimeoutError);
      expect((error as MessagingError).knowledge).toBe('maybe-delivered');
      await waitFor(() => seen.length === 1 && seen[0].context.signal.aborted, wait, 'dispatcher abort');
    });

    it('sends a cancel when the caller aborts; the plugin aborts the call', async () => {
      const id = pluginId();
      const seen: Seen[] = [];
      const server = await startServer(id, echoDispatcher(seen, (context) => new Promise((_, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason)))));
      const client = await startClient();
      await announced(client, id);
      const controller = new AbortController();
      const promise = client.call(id, 'Execute', execute(id), { timeoutMs: wait * 2, signal: controller.signal });
      await waitFor(() => seen.length === 1, wait, 'dispatch');
      controller.abort(new Error('user stopped'));
      await expect(promise).rejects.toBeInstanceOf(CancelledError);
      await waitFor(() => seen[0].context.signal.aborted, wait, 'plugin-side abort');
      expect(server.counters.cancelled).toBe(1);
    });

    it('rejects a call aborted before publishing as undeliverable', async () => {
      const client = await startClient();
      const error = await client.call(pluginId(), 'Health', {}, { signal: AbortSignal.abort() }).catch((e) => e);
      expect(error).toBeInstanceOf(UndeliverableError);
      expect((error as UndeliverableError).reason).toBe('aborted');
    });

    it('uses at most once by default and at least once only for repeatable work', async () => {
      const id = pluginId();
      const seen: Seen[] = [];
      await startServer(id, echoDispatcher(seen));
      const client = await startClient();
      await announced(client, id);
      await client.call(id, 'Execute', execute(id), { timeoutMs: wait });
      await client.call(id, 'Execute', execute(id), { timeoutMs: wait, delivery: 'at-least-once' });
      await client.call(id, 'Execute', execute(id, 'lookup'), { timeoutMs: wait, delivery: 'at-least-once' });
      await client.call(id, 'Execute', execute(id, 'echo', { idempotencyKey: 'k1' }), { timeoutMs: wait, delivery: 'at-least-once', idempotencyKey: 'k1' });
      await client.call(id, 'LoadOptions', { nodeType: `${id}.echo`, method: 'm', parameters: {} }, { timeoutMs: wait });
      expect(seen.map((s) => s.context.delivery)).toEqual(['at-most-once', 'at-most-once', 'at-least-once', 'at-least-once', 'at-least-once']);
      expect(seen[3].context.idempotencyKey).toBe('k1');
    });

    it(caps.workSharing && caps.nack ? 'a replica that dies mid-call: at least once moves to the survivor, at most once times out' : 'skips the replica crash (needs work sharing and nack)', async () => {
      if (!caps.workSharing || !caps.nack) return;
      const id = pluginId();
      const seenA: Seen[] = [];
      const seenB: Seen[] = [];
      const hang = () => new Promise(() => {});
      const a = await startServer(id, echoDispatcher(seenA, hang));
      const client = await startClient();
      await announced(client, id);
      const atLeastOnce = client.call(id, 'Execute', execute(id, 'lookup'), { timeoutMs: wait * 3, delivery: 'at-least-once' });
      const atMostOnce = client.call(id, 'Execute', execute(id, 'echo'), { timeoutMs: 600 });
      void atMostOnce.catch(() => undefined); // it rejects long before the assertion below on a slow broker
      await waitFor(() => seenA.length === 2, wait, 'both calls at replica A');
      const b = await startServer(id, echoDispatcher(seenB));
      await announced(client, id, 2);
      await a.driver.close(); // crash: no stop(), no drain
      const reply = await atLeastOnce;
      expect(reply.outputs[0][0].json).toEqual({ hello: 'world' });
      expect(seenB).toHaveLength(1);
      if (caps.attempts) expect(seenB[0].context.attempt).toBe(2);
      await expect(atMostOnce).rejects.toBeInstanceOf(TimeoutError);
      expect(b.counters.dispatched).toBe(1);
    });

    it('discovers plugins on the registry channel and forgets them on withdraw', async () => {
      const id = pluginId();
      const client = await startClient();
      const events: string[] = [];
      client.on('plugin', (e) => events.push(`${e.type}:${e.plugin.pluginId}`));
      const server = await startServer(id, echoDispatcher());
      await announced(client, id);
      const plugin = client.plugin(id)!;
      expect(plugin.endpoint).toBe(`${target.driver().kind}://${target.config.connectionId}/${id}`);
      expect(plugin.manifestHash).toBe(server.manifestHash);
      expect(plugin.version).toBe('1.0.0');
      expect(plugin.instances[0].instanceId).toBe(server.instanceId);
      expect(plugin.instances[0].maxConcurrency).toBe(2);
      expect(events).toEqual([`announced:${id}`]);
      await server.stop();
      await waitFor(() => client.plugin(id)?.instances.length === 0, wait, 'withdraw');
      expect(events).toEqual([`announced:${id}`, `withdrawn:${id}`]);
      const error = await client.call(id, 'Health', {}, { timeoutMs: 300 }).catch((e) => e);
      expect(error).toBeInstanceOf(UndeliverableError);
      expect((error as UndeliverableError).reason).toBe('no_consumers');
    });

    it('ignores announces without a valid registry proof, and unsigned ones', async () => {
      const id = pluginId();
      const client = await startClient();
      await startServer(id, echoDispatcher(), { registrySecret: 'another-secret' });
      const other = pluginId();
      await startServer(other, echoDispatcher(), { keyring: new Keyring('another-transport-secret') });
      await sleep(200);
      expect(client.plugin(id)).toBeUndefined();
      expect(client.plugin(other)).toBeUndefined();
      const lenient = await startClient({ registrySecret: null });
      await announced(lenient, id);
    });

    it('answers manifest_mismatch after one requeue when the host knows another manifest', async () => {
      const id = pluginId();
      const server = await startServer(id, echoDispatcher());
      const client = await startClient();
      await announced(client, id);
      const error = await client.call(id, 'Health', {}, { timeoutMs: wait, manifestHash: 'deadbeefdeadbeef' }).catch((e) => e);
      expect(error).toBeInstanceOf(ManifestMismatchError);
      expect((error as ManifestMismatchError).actual).toBe(server.manifestHash);
      expect((error as ManifestMismatchError).expected).toBe('deadbeefdeadbeef');
      expect(server.counters.mismatched).toBe(caps.nack ? 2 : 1);
      expect(server.counters.requeued).toBe(caps.nack ? 1 : 0);
      // The announced hash is the default, so a plain call works.
      expect((await client.call(id, 'Health', {}, { timeoutMs: wait })).status).toBe('ok');
    });

    it('drops tampered, unsigned and foreign-key requests without running them', async () => {
      const id = pluginId();
      const seen: Seen[] = [];
      const server = await startServer(id, echoDispatcher(seen));
      const client = await startClient();
      await announced(client, id);
      const raw = target.driver();
      await raw.connect(config);
      cleanups.push(() => raw.close());
      await raw.declare([channelSpecs.request(names.request(id))]);
      const codec = new Codec(keyring, caps);
      const base = () => codec.base(hostSource('attacker'), requestType('Health'), { lfreplyto: names.reply('attacker'), lfdeadline: String(Date.now() + 10_000) });
      // 1. a valid event with one body byte flipped
      const flipped = codec.pack(id, base(), {}, true).wire;
      flipped.body = new Uint8Array(flipped.body);
      flipped.body[flipped.body.length - 1] ^= 0xff;
      await raw.publish(names.request(id), flipped);
      // 2. a header changed after signing (binary mode only; structured mode has no headers to change)
      if (caps.headers) {
        const edited = codec.pack(id, base(), {}, true).wire;
        edited.headers.lfdeadline = String(Date.now() + 60_000);
        await raw.publish(names.request(id), edited);
      }
      // 3. unsigned
      const unsigned = codec.pack(id, base(), {}, true).wire;
      if (caps.headers) delete unsigned.headers.lfsig;
      else unsigned.body = encoder.encode(JSON.stringify({ ...JSON.parse(decoder.decode(unsigned.body)), lfsig: undefined }));
      await raw.publish(names.request(id), unsigned);
      // 4. signed with another secret
      await raw.publish(names.request(id), new Codec(new Keyring('wrong-secret'), caps).pack(id, base(), {}, true).wire);
      const expected = caps.headers ? 4 : 3;
      await waitFor(() => server.counters.dropped === expected, wait, 'drops');
      expect(seen).toHaveLength(0);
      // and a genuine call still works
      expect((await client.call(id, 'Health', {}, { timeoutMs: wait })).status).toBe('ok');
    });

    it(target.tap ? 'drops a tampered reply (the call times out instead of using it)' : 'skips reply tampering (no tap)', async () => {
      if (!target.tap) return;
      const id = pluginId();
      await startServer(id, echoDispatcher());
      const client = await startClient();
      await announced(client, id);
      const untap = target.tap((channel, event) => {
        if (!channel.startsWith(`${prefix}.v1.reply.`) && !channel.endsWith(':reply')) return event;
        const body = new Uint8Array(event.body);
        body[0] ^= 0xff;
        return { ...event, body };
      });
      const error = await client.call(id, 'Health', {}, { timeoutMs: 400 }).catch((e) => e);
      untap();
      expect(error).toBeInstanceOf(TimeoutError);
    });

    it('refuses a call bigger than the broker limit before publishing', async () => {
      const id = pluginId();
      await startServer(id, echoDispatcher());
      const client = await startClient();
      await announced(client, id);
      const huge = execute(id, 'echo', { inputs: [[{ json: { blob: 'x'.repeat(caps.maxMessageBytes + 1024) } }]] });
      const error = await client.call(id, 'Execute', huge, { timeoutMs: wait }).catch((e) => e);
      expect(error).toBeInstanceOf(UndeliverableError);
      expect((error as UndeliverableError).reason).toBe('too_large');
    });

    const claimable = caps.maxMessageBytes <= 12 * 1024 * 1024;
    const blob = (extra = 4096) => 'x'.repeat(caps.maxMessageBytes + extra);

    it(claimable ? 'carries an oversized call and reply by reference through a claim store, deleting the objects after the ack' : 'skips the claim check (limit over 12 MiB)', async () => {
      if (!claimable) return;
      const id = pluginId();
      const claims = new MemoryClaimStore();
      const during: number[] = [];
      // `lookup` is idempotent, so the host's at-least-once request is held until after the reply: its body must still be in the store while the node runs.
      await startServer(id, echoDispatcher([], async () => void during.push(claims.keys().length)), { claims });
      const client = await startClient({ claims });
      await announced(client, id);
      const huge = execute(id, 'lookup', { inputs: [[{ json: { blob: blob() } }]] });
      const reply = await client.invoke(id, 'Execute', huge, { timeoutMs: wait * 4, delivery: 'at-least-once' });
      expect((reply.body.outputs[0][0].json as { blob: string }).blob.length).toBe(caps.maxMessageBytes + 4096);
      expect(claims.counters.puts).toBe(2);
      expect(during).toEqual([1]);
      await waitFor(() => claims.keys().length === 0, wait, 'claims deleted');
      expect(claims.counters.deletes).toBe(2);
    });

    it(claimable ? 'stores only ciphertext in the claim store' : 'skips the claim check (limit over 12 MiB)', async () => {
      if (!claimable) return;
      const id = pluginId();
      const claims = new MemoryClaimStore();
      let stored = '';
      await startServer(id, echoDispatcher([], () => void (stored = decoder.decode([...claims.objects.values()][0]?.subarray(0, 4096) ?? new Uint8Array()))), { claims });
      const client = await startClient({ claims });
      await announced(client, id);
      await client.call(id, 'Execute', execute(id, 'lookup', { inputs: [[{ json: { blob: blob() } }]] }), { timeoutMs: wait * 4, delivery: 'at-least-once' });
      expect(stored.length).toBeGreaterThan(0);
      expect(stored).not.toContain('top-secret-token');
      expect(stored).not.toContain('xxxxxxxx');
    });

    it(claimable ? 'without a claim store an oversized reply answers too_large and a store outage at the sender is undelivered' : 'skips the claim check (limit over 12 MiB)', async () => {
      if (!claimable) return;
      const id = pluginId();
      await startServer(id, echoDispatcher([], () => ({ outputs: [[{ json: { blob: blob() } }]] })));
      const plain = await startClient();
      await announced(plain, id);
      const error = await plain.call(id, 'Execute', execute(id), { timeoutMs: wait }).catch((e) => e);
      expect(error).toBeInstanceOf(RemoteError);
      expect((error as RemoteError).remoteCode).toBe('too_large');
      const claims = new MemoryClaimStore();
      const client = await startClient({ claims });
      await announced(client, id);
      claims.failNext = 'put';
      const down = await client.call(id, 'Execute', execute(id, 'echo', { inputs: [[{ json: { blob: blob() } }]] }), { timeoutMs: wait }).catch((e) => e);
      expect(down).toBeInstanceOf(UndeliverableError);
      expect((down as UndeliverableError).reason).toBe('claim_failed');
    });

    it(claimable && target.tap && caps.headers ? 'fails a call whose request claim is gone, and drops one whose reference was swapped' : 'skips claim tampering (no tap, no headers or limit over 12 MiB)', async () => {
      if (!claimable || !target.tap || !caps.headers) return;
      const id = pluginId();
      const claims = new MemoryClaimStore();
      const seen: Seen[] = [];
      await startServer(id, echoDispatcher(seen), { claims });
      const client = await startClient({ claims });
      await announced(client, id);
      const huge = execute(id, 'echo', { inputs: [[{ json: { blob: blob() } }]] });
      let mode: 'delete' | 'swap' = 'delete';
      const untap = target.tap((channel, event) => {
        const claim = event.headers.lfclaim ?? event.headers['ce-lfclaim'];
        if (!claim || !channel.includes(id)) return event;
        if (mode === 'delete') {
          claims.objects.delete(claim);
          return event;
        }
        const other = claim.replace(/\/[^/]*$/, '/other');
        claims.objects.set(other, claims.objects.get(claim)!);
        return { ...event, headers: Object.fromEntries(Object.entries(event.headers).map(([k, v]) => [k, k.endsWith('lfclaim') ? other : v])) };
      });
      cleanups.push(async () => untap());
      const gone = await client.call(id, 'Execute', huge, { timeoutMs: wait * 2 }).catch((e) => e);
      expect(gone).toBeInstanceOf(ClaimUnavailableError);
      expect((gone as ClaimUnavailableError).knowledge).toBe('not-delivered');
      expect(seen).toHaveLength(0);
      mode = 'swap';
      const swapped = await client.call(id, 'Execute', huge, { timeoutMs: 600 }).catch((e) => e);
      expect(swapped).toBeInstanceOf(TimeoutError);
      expect(seen).toHaveLength(0);
    });

    it(`fails a call to a plugin nobody consumes as ${caps.undeliverable === 'reported' ? 'unroutable' : 'a timeout'}`, async () => {
      const client = await startClient();
      const error = await client.call(pluginId(), 'Health', {}, { timeoutMs: 300 }).catch((e) => e);
      expect(error).toBeInstanceOf(MessagingError);
      if (caps.undeliverable === 'reported') {
        expect(error).toBeInstanceOf(UndeliverableError);
        expect((error as UndeliverableError).reason).toBe('unroutable');
      } else expect(error).toBeInstanceOf(TimeoutError);
    });

    it('runs at most maxConcurrency calls at once per instance', async () => {
      const id = pluginId();
      let active = 0;
      let peak = 0;
      await startServer(id, echoDispatcher([], async () => {
        active++;
        peak = Math.max(peak, active);
        await sleep(60);
        active--;
      }));
      const client = await startClient();
      await announced(client, id);
      await Promise.all(Array.from({ length: 6 }, () => client.call(id, 'Execute', execute(id), { timeoutMs: wait * 3 })));
      expect(peak).toBe(2);
    });

    it('drains: stop() waits for the call in flight and the host gets its reply', async () => {
      const id = pluginId();
      const seen: Seen[] = [];
      const server = await startServer(id, echoDispatcher(seen, () => sleep(150)));
      const client = await startClient();
      await announced(client, id);
      const call = client.call(id, 'Execute', execute(id), { timeoutMs: wait });
      await waitFor(() => seen.length === 1, wait, 'dispatch');
      await server.stop();
      expect(server.inFlightCount).toBe(0);
      expect((await call).outputs).toHaveLength(1);
    });

    it(caps.workSharing ? 'reaches one instance through its instance channel' : 'skips instance channels (no work sharing)', async () => {
      if (!caps.workSharing) return;
      const id = pluginId();
      const a = await startServer(id, echoDispatcher());
      const b = await startServer(id, echoDispatcher());
      const client = await startClient();
      await announced(client, id, 2);
      for (const server of [a, b]) {
        const reply = await client.invoke(id, 'Health', {}, { timeoutMs: wait, instanceId: server.instanceId });
        expect(reply.instanceId).toBe(server.instanceId);
      }
    });

    it(target.driver().stats ? 'samples stats for announced plugins' : 'skips stats (driver has none)', async () => {
      if (!target.driver().stats) return;
      const id = pluginId();
      await startServer(id, echoDispatcher());
      const client = await startClient();
      await announced(client, id);
      await client.sampleStats();
      const stats = client.stats(id);
      expect(stats).toBeDefined();
      expect(stats!.sampledAt).toBeGreaterThan(0);
      if (stats!.consumers !== undefined) expect(stats!.consumers).toBeGreaterThanOrEqual(1);
    });

    it('fails pending calls with ConnectionLostError when the client closes', async () => {
      const id = pluginId();
      await startServer(id, echoDispatcher([], () => sleep(wait)));
      const client = await startClient();
      await announced(client, id);
      const call = client.call(id, 'Execute', execute(id), { timeoutMs: wait * 3 });
      void call.catch(() => undefined); // rejected while close() is still waiting on the broker
      await sleep(50);
      await client.close();
      await expect(call).rejects.toBeInstanceOf(ConnectionLostError);
    });

    it('propagates trace context, attempt and the subject', async () => {
      const id = pluginId();
      const seen: Seen[] = [];
      await startServer(id, echoDispatcher(seen));
      const client = await startClient();
      await announced(client, id);
      const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
      const reply = await client.invoke(id, 'Execute', execute(id), { timeoutMs: wait, traceparent, attempt: 3 });
      expect(seen[0].context.traceparent).toBe(traceparent);
      expect(seen[0].context.source).toBe(hostSource(client.hostInstanceId));
      expect(reply.attributes.traceparent).toBe(traceparent);
      expect(reply.attributes.subject).toBe(`${id}.echo`);
    });
  });
}
