/**
 * Fake-clock tests of the timed behaviour: heartbeats every 10 s, instance expiry after the announce TTL, stats sampling
 * every 5 s, deadlines on both sides, and the cancelled-call memory. The memory broker delivers on microtasks, so only
 * the core's timers move with the clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecuteRequest } from '@landflow/protocol';
import { MessagingClient, MessagingServer, TimeoutError, Keyring, silentLogger, type DispatchContext } from '../src';
import { MemoryBroker } from '../src/memory';

const keyring = new Keyring('clock-secret');
const config = { connectionId: 'mem' };
const manifest = { hash: 'abcdef0123456789' };

/** Let the broker's microtask deliveries and the core's promise chains settle without moving the clock. */
async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

const execute = (): ExecuteRequest => ({
  protocol: 'landflow.plugin/v1',
  executionId: 'e',
  mode: 'manual',
  node: { id: 'n', name: 'n', type: 'p.n', typeVersion: 1 },
  parameters: {},
  itemParameters: [],
  inputs: [[]],
});

describe('with a fake clock', () => {
  let broker: MemoryBroker;
  const cleanups: (() => Promise<unknown>)[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
    broker = new MemoryBroker();
  });
  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
    vi.useRealTimers();
  });
  const start = async (dispatch: (context: DispatchContext) => Promise<unknown> = async () => ({ outputs: [] }), extra: Partial<ConstructorParameters<typeof MessagingServer>[0]> = {}) => {
    const client = await MessagingClient.start({ driver: broker.driver(), config, keyring, registrySecret: null, log: silentLogger });
    const server = await MessagingServer.start({ driver: broker.driver(), config, keyring, pluginId: 'p', version: '1', manifest, dispatch: (_m, _b, c) => dispatch(c) as never, registrySecret: null, log: silentLogger, ...extra });
    cleanups.push(() => client.close(), () => server.stop());
    await settle();
    return { client, server };
  };

  it('heartbeats every 10 s and the host forgets an instance 30 s after its last one', async () => {
    const { client, server } = await start();
    expect(server.counters.announces).toBe(1);
    expect(client.plugin('p')?.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.counters.announces).toBe(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(server.counters.announces).toBe(4);
    expect(client.plugin('p')?.instances).toHaveLength(1);
    expect(client.plugin('p')?.lastSeen).toBe(Date.now());
    // The plugin dies without a withdraw: its heartbeats stop.
    const events: string[] = [];
    client.on('plugin', (e) => events.push(e.type));
    await server.driver.close();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(client.plugin('p')?.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(client.plugin('p')?.instances).toHaveLength(0);
    expect(events).toEqual(['expired']);
    await expect(client.call('p', 'Health', {})).rejects.toMatchObject({ reason: 'no_consumers' });
  });

  it('samples stats every 5 s', async () => {
    const { client } = await start();
    expect(client.stats('p')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.stats('p')).toMatchObject({ consumers: 1, sampledAt: Date.now() });
  });

  it('fails a call at its deadline on the host, aborts it on the plugin and never replies late', async () => {
    let context: DispatchContext | undefined;
    const { client, server } = await start((c) => {
      context = c;
      return new Promise((_, reject) => c.signal.addEventListener('abort', () => reject(c.signal.reason)));
    });
    let error: unknown;
    const call = client.call('p', 'Execute', execute(), { timeoutMs: 5_000 }).catch((e) => (error = e));
    await settle();
    expect(context?.deadline).toBe(Date.now() + 5_000);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(error).toBeUndefined();
    expect(context?.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await call;
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as TimeoutError).deadline).toBe(Date.now());
    expect(context?.signal.aborted).toBe(true);
    await settle();
    expect(server.counters.replied).toBe(0);
    expect(server.counters.expired).toBe(1);
  });

  it('drops a request whose deadline passed in transit and refuses a deadline already in the past', async () => {
    const dispatched: DispatchContext[] = [];
    const { client, server } = await start(async (c) => {
      dispatched.push(c);
      return { outputs: [] };
    });
    await expect(client.call('p', 'Health', {}, { deadline: Date.now() - 1 })).rejects.toBeInstanceOf(TimeoutError);
    // Hold the request on the broker by exhausting the plugin's concurrency, then let the deadline pass before it is taken.
    const slow = new MemoryBroker({ latencyMs: 2_000 });
    const slowClient = await MessagingClient.start({ driver: slow.driver(), config, keyring, registrySecret: null, log: silentLogger });
    const slowServer = await MessagingServer.start({ driver: slow.driver(), config, keyring, pluginId: 'p', version: '1', manifest, dispatch: async () => ({ outputs: [] }) as never, registrySecret: null, log: silentLogger });
    cleanups.push(() => slowClient.close(), () => slowServer.stop());
    const late = slowClient.call('p', 'Health', {}, { timeoutMs: 1_000 }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await late).toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(slowServer.counters.expired).toBe(1);
    expect(slowServer.counters.dispatched).toBe(0);
    expect(server.counters.dispatched).toBe(0);
    expect(dispatched).toHaveLength(0);
  });

  it('remembers a cancel that arrives before its request for a minute', async () => {
    const { client, server } = await start();
    // Simulate the race: the cancel reaches the plugin while the request is still on the wire (latency on the request only).
    const requests = client.names.request('p');
    const raw = broker.driver();
    await raw.connect(config);
    const held: (() => Promise<unknown>)[] = [];
    const untap = broker.tap((channel, event) => {
      if (channel !== requests) return event;
      // Drop the live request and re-publish it later, after the cancel.
      held.push(() => raw.publish(requests, event));
      return null;
    });
    const controller = new AbortController();
    const call = client.call('p', 'Execute', execute(), { timeoutMs: 10_000, signal: controller.signal }).catch((e) => e);
    await settle();
    controller.abort();
    await settle();
    untap();
    expect(held).toHaveLength(1);
    await held[0]();
    await settle(50);
    expect(server.counters.cancelled).toBe(1);
    expect(server.counters.dispatched).toBe(0);
    await call;
    await raw.close();
  });
});
