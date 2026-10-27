/**
 * Queue mode's coordinator, leader election and relay (lib/server/cluster): the job stream (enqueue, take, ack,
 * touch, stalled takeover, requeue), keys with a time to live (leases, claims), cross-process concurrency (admit,
 * FIFO drain, slot leases), rate limits, pub/sub and heartbeats; leader election with fencing tokens and failover;
 * the relay (no echo, inboxes); the RESP client's parser; the startup checks.
 *
 * Every coordinator test runs on the in-process double (MemoryCoordinator). With LANDFLOW_INTEGRATION=queue they also
 * run on a real Valkey (LANDFLOW_TEST_VALKEY_URL, default redis://127.0.0.1:56379, the landflow-infra one) under a
 * throwaway key prefix.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Coordinator, QueueJob } from '@/lib/server/cluster/coordinator';
import { MemoryCoordinator, MemoryHub } from '@/lib/server/cluster/memory';
import { ValkeyCoordinator } from '@/lib/server/cluster/valkey';
import { LeaderElector } from '@/lib/server/cluster/leader';
import { Relay } from '@/lib/server/cluster/relay';
import { encodeCommand, parseValkeyUrl, RespClient, RespError, RespParser } from '@/lib/server/cluster/resp';
import { checkClusterConfig, clusterConfig, ClusterConfigError, leaseMs } from '@/lib/server/cluster/config';
import { ClusterRateLimiter, exclusive, LockTimeoutError } from '@/lib/server/cluster/limits';

vi.setConfig({ testTimeout: 20_000 });

const integration = process.env.LANDFLOW_INTEGRATION?.split(',').includes('queue');
const valkeyUrl = process.env.LANDFLOW_TEST_VALKEY_URL ?? 'redis://127.0.0.1:56379';

interface Backend {
  name: string;
  /** Coordinators that share one server, like processes would. */
  connect: () => Coordinator;
  /** Move time (memory) or wait (Valkey). */
  advance: (ms: number) => Promise<void>;
  clock: () => number;
}

const opened: Coordinator[] = [];
/** Throwaway key prefixes used on the real Valkey, deleted at the end. */
const prefixes: string[] = [];
afterAll(async () => {
  await Promise.allSettled(opened.map((c) => c.close()));
  if (!prefixes.length) return;
  const client = new RespClient({ url: valkeyUrl, name: 'test-cleanup' });
  try {
    for (const prefix of prefixes) {
      let cursor = '0';
      do {
        const [next, keys] = (await client.call('SCAN', cursor, 'MATCH', `${prefix}:*`, 'COUNT', 500)) as [string, string[]];
        cursor = String(next);
        if (keys.length) await client.call('DEL', ...keys);
      } while (cursor !== '0');
    }
  } finally {
    await client.close();
  }
});

function memoryBackend(): Backend {
  let now = Date.now();
  const hub = new MemoryHub(() => now);
  return {
    name: 'memory',
    connect: () => {
      const coordinator = new MemoryCoordinator(hub);
      opened.push(coordinator);
      return coordinator;
    },
    advance: async (ms) => {
      now += ms;
    },
    clock: () => now,
  };
}

function valkeyBackend(): Backend {
  const prefix = `lftest-${randomUUID().slice(0, 8)}`;
  prefixes.push(prefix);
  return {
    name: 'valkey',
    connect: () => {
      const coordinator = new ValkeyCoordinator(valkeyUrl, prefix, `test-${opened.length}`);
      opened.push(coordinator);
      return coordinator;
    },
    advance: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    clock: Date.now,
  };
}

const job = (executionId: string, extra: Partial<QueueJob> = {}): QueueJob => ({
  executionId,
  workflowId: 'wf_q',
  expect: 'queued',
  record: { executionId, workflowId: 'wf_q', workflowName: 'q', mode: 'webhook', status: 'running', startedAt: new Date().toISOString(), finishedAt: '', durationMs: 0, runData: {}, executionOrder: [] },
  workflow: { id: 'wf_q', name: 'q', nodes: [], connections: [] },
  engine: { startNodeId: 'Start' },
  enqueuedAt: new Date().toISOString(),
  ...extra,
});

const rule = (slots: number, extra: Partial<{ waiting: number; overflow: 'queue' | 'skip'; queueSize: number }> = {}) => ({ slots, waiting: 0, overflow: 'queue' as const, queueSize: 100, ...extra });

const backends: Array<() => Backend> = [memoryBackend, ...(integration ? [valkeyBackend] : [])];

for (const make of backends) {
  const backend = make();
  describe(`coordinator (${backend.name})`, () => {
    it('hands each job to one worker, keeps it pending until acked, and counts what waits and what is held', async () => {
      const main = backend.connect();
      const a = backend.connect();
      const b = backend.connect();
      await main.enqueue(job('ex_1'));
      await main.enqueue(job('ex_2'));
      await main.enqueue(job('ex_3'));
      expect(await main.queueStats()).toEqual({ waiting: 3, active: 0 });
      const first = await a.take('worker-a', 2, 100);
      const second = await b.take('worker-b', 5, 100);
      expect(first.map((d) => d.job.executionId)).toEqual(['ex_1', 'ex_2']);
      expect(second.map((d) => d.job.executionId)).toEqual(['ex_3']);
      expect(first[0].job.engine).toEqual({ startNodeId: 'Start' });
      expect(await main.queueStats()).toEqual({ waiting: 0, active: 3 });
      for (const delivery of [...first, ...second]) await main.ack(delivery.id);
      expect(await main.queueStats()).toEqual({ waiting: 0, active: 0 });
      // Nothing left: a take waits, then comes back empty.
      expect(await a.take('worker-a', 1, 50)).toEqual([]);
    });

    it('wakes a blocked worker when a job arrives', async () => {
      const worker = backend.connect();
      const main = backend.connect();
      const taking = worker.take('worker-a', 1, 3_000);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await main.enqueue(job('ex_wake'));
      const [delivery] = await taking;
      expect(delivery.job.executionId).toBe('ex_wake');
      await main.ack(delivery.id);
    });

    it('lets another worker take over a job its worker stopped touching, but not one it touches', async () => {
      const main = backend.connect();
      const dead = backend.connect();
      const alive = backend.connect();
      const rescuer = backend.connect();
      await main.enqueue(job('ex_dead'));
      await main.enqueue(job('ex_alive'));
      const [lost] = await dead.take('worker-dead', 1, 100);
      const [kept] = await alive.take('worker-alive', 1, 100);
      await backend.advance(400);
      await alive.touch('worker-alive', [kept.id]);
      const claimed = await rescuer.claimStalled('worker-rescuer', 300, 10);
      expect(claimed.map((d) => d.job.executionId)).toEqual(['ex_dead']);
      expect(claimed[0].id).toBe(lost.id);
      // Claimed: it is the rescuer's now, so it isn't idle any more.
      expect(await rescuer.claimStalled('worker-other', 300, 10)).toEqual([]);
      await main.ack(lost.id);
      await main.ack(kept.id);
    });

    it('puts a job back at the end of the queue (a worker shutting down)', async () => {
      const main = backend.connect();
      const worker = backend.connect();
      await main.enqueue(job('ex_back'));
      const [delivery] = await worker.take('worker-a', 1, 100);
      await worker.requeue(delivery);
      expect(await main.queueStats()).toEqual({ waiting: 1, active: 0 });
      const [again] = await worker.take('worker-b', 1, 100);
      expect(again.job.executionId).toBe('ex_back');
      expect(again.id).not.toBe(delivery.id);
      await main.ack(again.id);
    });

    it('hands out high-priority jobs first, then normal, then low, and still takes a low one after a run of the others', async () => {
      const main = backend.connect();
      const worker = backend.connect();
      await main.enqueue(job('p_low_1', { priority: 'low' }));
      await main.enqueue(job('p_normal_1'));
      await main.enqueue(job('p_high_1', { priority: 'high' }));
      await main.enqueue(job('p_normal_2', { priority: 'normal' }));
      await main.enqueue(job('p_high_2', { priority: 'high' }));
      expect(await main.queueStats()).toEqual({ waiting: 5, active: 0 });
      const first = await worker.take('worker-p', 3, 100);
      expect(first.map((d) => d.job.executionId)).toEqual(['p_high_1', 'p_high_2', 'p_normal_1']);
      const second = await worker.take('worker-p', 5, 100);
      expect(second.map((d) => d.job.executionId)).toEqual(['p_normal_2', 'p_low_1']);
      expect(await main.queueStats()).toEqual({ waiting: 0, active: 5 });
      for (const delivery of [...first, ...second]) await main.ack(delivery.id);
      expect(await main.queueStats()).toEqual({ waiting: 0, active: 0 });

      // A steady stream of high jobs does not starve a low one: it goes first after LOW_EVERY (8) others.
      await main.enqueue(job('s_low', { priority: 'low' }));
      for (let n = 0; n < 12; n++) await main.enqueue(job(`s_high_${n}`, { priority: 'high' }));
      const order: string[] = [];
      for (let n = 0; n < 13; n++) {
        const [one] = await worker.take('worker-p', 1, 100);
        order.push(one.job.executionId);
        await main.ack(one.id);
      }
      expect(order.indexOf('s_low')).toBe(8);
      expect(order.slice(0, 8)).toEqual(Array.from({ length: 8 }, (_, n) => `s_high_${n}`));
    });

    it('keeps the priority of a job that goes back, is touched, or is taken over from a dead worker', async () => {
      const main = backend.connect();
      const dead = backend.connect();
      const alive = backend.connect();
      await main.enqueue(job('r_high', { priority: 'high' }));
      await main.enqueue(job('r_low', { priority: 'low' }));
      const lost = await dead.take('worker-dead', 2, 100);
      expect(lost.map((d) => d.job.executionId)).toEqual(['r_high', 'r_low']);
      await dead.touch('worker-dead', lost.map((d) => d.id));
      await backend.advance(600);
      const taken = await alive.claimStalled('worker-alive', 300, 5);
      expect(taken.map((d) => d.job.executionId).sort()).toEqual(['r_high', 'r_low']);
      // Back to the queue: still in its priority's stream (high before normal).
      await alive.requeue(taken.find((d) => d.job.executionId === 'r_high')!);
      await main.enqueue(job('r_normal'));
      const next = await alive.take('worker-alive', 1, 100);
      expect(next[0].job.executionId).toBe('r_high');
      for (const delivery of [...next, ...taken.filter((d) => d.job.executionId === 'r_low')]) await main.ack(delivery.id);
      const [normal] = await alive.take('worker-alive', 1, 100);
      expect(normal.job.executionId).toBe('r_normal');
      await main.ack(normal.id);
      expect(await main.queueStats()).toEqual({ waiting: 0, active: 0 });
    });

    it('keeps leases and claims: set if absent, renew or delete only while holding them, expire', async () => {
      const one = backend.connect();
      const two = backend.connect();
      const key = `lease:${randomUUID()}`;
      expect(await one.setIfAbsent(key, 'one', 500)).toBe(true);
      expect(await two.setIfAbsent(key, 'two', 500)).toBe(false);
      expect(await two.extendIfValue(key, 'two', 500)).toBe(false);
      expect(await one.extendIfValue(key, 'one', 500)).toBe(true);
      expect(await two.deleteIfValue(key, 'two')).toBe(false);
      expect(await two.get(key)).toBe('one');
      await backend.advance(700);
      expect(await two.get(key)).toBeUndefined();
      expect(await two.setIfAbsent(key, 'two', 500)).toBe(true);
      expect(await two.deleteIfValue(key, 'two')).toBe(true);
      await one.setMany([[`${key}:a`, '1'], [`${key}:b`, '2']], 1_000);
      expect(await two.getMany([`${key}:a`, `${key}:b`, `${key}:c`])).toEqual(['1', '2', undefined]);
      expect(await one.incr(`${key}:n`, 1_000)).toBe(1);
      expect(await two.incr(`${key}:n`, 1_000)).toBe(2);
      await one.del(`${key}:a`, `${key}:b`, `${key}:n`);
      expect(await two.getMany([`${key}:a`, `${key}:n`])).toEqual([undefined, undefined]);
    });

    it('admits runs into a workflow’s slots across processes, queues the rest FIFO and drains them as slots free', async () => {
      const one = backend.connect();
      const two = backend.connect();
      const wf = `wf_${randomUUID().slice(0, 6)}`;
      expect(await one.admit(wf, 'r1', rule(2), 60_000)).toBe('run');
      expect(await two.admit(wf, 'r2', rule(2), 60_000)).toBe('run');
      expect(await one.admit(wf, 'r3', rule(2), 60_000)).toBe('queue');
      await one.addToQueue(wf, 'r3', 1);
      await two.addToQueue(wf, 'r4', 2);
      // Once something waits in the queue, a newcomer queues behind it even if a slot frees.
      expect(await two.admit(wf, 'r5', rule(3), 60_000)).toBe('queue');
      expect(await one.admit(wf, 'r6', rule(2, { overflow: 'skip' }), 60_000)).toBe('skip');
      expect(await one.admit(wf, 'r7', rule(2, { queueSize: 2 }), 60_000)).toBe('full');
      expect(await one.slotUsage(wf)).toEqual({ running: 2, queued: 2 });
      expect(await two.drain(wf, rule(2), 60_000)).toEqual([]);
      await one.releaseSlot(wf, 'r1');
      expect(await two.drain(wf, rule(2), 60_000)).toEqual(['r3']);
      expect(await one.isQueued(wf, 'r3')).toBe(false);
      expect(await one.isQueued(wf, 'r4')).toBe(true);
      // A singleton's waiting run holds the slot.
      await one.releaseSlot(wf, 'r2');
      expect(await two.drain(wf, rule(2, { waiting: 1 }), 60_000)).toEqual([]);
      expect(await two.drain(wf, rule(2), 60_000)).toEqual(['r4']);
      await one.removeFromQueue(wf, 'r4');
      expect(await one.slotUsage(wf)).toEqual({ running: 2, queued: 0 });
      // No limit: everything runs.
      expect(await one.admit(`${wf}-free`, 'x', rule(Infinity), 60_000)).toBe('run');
    });

    it('frees the slot of a run whose process stopped renewing it', async () => {
      const one = backend.connect();
      const wf = `wf_${randomUUID().slice(0, 6)}`;
      expect(await one.admit(wf, 'r1', rule(1), 300)).toBe('run');
      expect(await one.admit(wf, 'r2', rule(1, { overflow: 'skip' }), 300)).toBe('skip');
      await one.holdSlots([{ workflowId: wf, executionId: 'r1' }], 300);
      await backend.advance(500);
      expect(await one.admit(wf, 'r2', rule(1), 300)).toBe('run');
    });

    it('rate-limits a key across processes with a sliding window', async () => {
      const one = backend.connect();
      const two = backend.connect();
      const key = `rate:${randomUUID()}`;
      expect(await one.rateLimit(key, 2, 400)).toBe(0);
      expect(await two.rateLimit(key, 2, 400)).toBe(0);
      const wait = await one.rateLimit(key, 2, 400);
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(400);
      await backend.advance(450);
      expect(await two.rateLimit(key, 2, 400)).toBe(0);
    });

    it('elects one leader with a fencing token that grows with every new leadership', async () => {
      const a = backend.connect();
      const b = backend.connect();
      const first = await a.campaign('main-a', 400);
      expect(first).toMatchObject({ holder: 'main-a', mine: true });
      expect(await b.campaign('main-b', 400)).toMatchObject({ holder: 'main-a', mine: false, token: first.token });
      // Renewing keeps the token.
      expect(await a.campaign('main-a', 400)).toMatchObject({ mine: true, token: first.token });
      await a.resign('main-a');
      const second = await b.campaign('main-b', 400);
      expect(second).toMatchObject({ holder: 'main-b', mine: true });
      expect(second.token).toBeGreaterThan(first.token);
      // A leader that stops renewing loses it after its TTL.
      await backend.advance(600);
      const third = await a.campaign('main-a', 400);
      expect(third).toMatchObject({ holder: 'main-a', mine: true });
      expect(third.token).toBeGreaterThan(second.token);
      expect(await b.leadership()).toMatchObject({ holder: 'main-a', token: third.token });
      await a.resign('main-a');
    });

    it('delivers pub/sub messages to every subscriber, and lists instances with a current heartbeat', async () => {
      const one = backend.connect();
      const two = backend.connect();
      const channel = `ch-${randomUUID()}`;
      const got: string[] = [];
      const unsubscribe = await two.subscribe(channel, (message) => got.push(message));
      await one.publish(channel, 'hello');
      await vi.waitFor(() => expect(got).toEqual(['hello']));
      await unsubscribe();
      await one.publish(channel, 'gone');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(got).toEqual(['hello']);

      const id = `worker-${randomUUID().slice(0, 6)}`;
      const info = { id, role: 'worker' as const, hostname: 'h', pid: 1, startedAt: new Date().toISOString(), lastSeen: new Date().toISOString(), active: 2, concurrency: 5 };
      await one.heartbeat(info, 400);
      expect((await two.instances()).find((i) => i.id === id)).toMatchObject({ role: 'worker', active: 2 });
      await backend.advance(600);
      expect((await two.instances()).find((i) => i.id === id)).toBeUndefined();
      await one.heartbeat(info, 10_000);
      await one.forget(id);
      expect((await two.instances()).find((i) => i.id === id)).toBeUndefined();
    });

    it('rate-limits node calls across processes with the cluster limiter', async () => {
      const one = backend.connect();
      const two = backend.connect();
      const key = `wf:${randomUUID()}`;
      const limitA = new ClusterRateLimiter(() => one);
      const limitB = new ClusterRateLimiter(() => two);
      const limit = { limit: 2, intervalSeconds: 0.3 };
      expect(await limitA.acquire(key, limit)).toBeLessThan(50);
      expect(await limitB.acquire(key, limit)).toBeLessThan(50);
      if (backend.name === 'valkey') {
        const started = Date.now();
        await limitA.acquire(key, limit);
        expect(Date.now() - started).toBeGreaterThanOrEqual(150);
      }
      const controller = new AbortController();
      controller.abort();
      await expect(limitB.acquire(key, limit, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('runs one holder of a cluster lock at a time', async () => {
      const one = backend.connect();
      const two = backend.connect();
      const name = `lock-${randomUUID()}`;
      const order: string[] = [];
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const first = exclusive(one, name, async () => {
        order.push('first in');
        await held;
        order.push('first out');
      });
      await vi.waitFor(() => expect(order).toEqual(['first in']));
      const second = exclusive(two, name, async () => order.push('second'), { waitMs: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(order).toEqual(['first in']);
      release();
      await Promise.all([first, second]);
      expect(order).toEqual(['first in', 'first out', 'second']);
      await one.setIfAbsent(`lock:${name}`, 'someone', 10_000);
      await expect(exclusive(two, name, async () => 1, { waitMs: 50 })).rejects.toBeInstanceOf(LockTimeoutError);
    });
  });

  describe(`leader election (${backend.name})`, () => {
    it('fails over to another main when the leader stops renewing, and stops acting before its lease can run out', async () => {
      const a = backend.connect();
      const b = backend.connect();
      const events: string[] = [];
      const ttl = 600;
      const electorA = new LeaderElector(a, `main-a-${backend.name}`, ttl, { onElected: (t) => void events.push(`a+${t}`), onDemoted: (r) => void events.push(`a-:${r}`) }, backend.clock);
      const electorB = new LeaderElector(b, `main-b-${backend.name}`, ttl, { onElected: (t) => void events.push(`b+${t}`), onDemoted: () => void events.push('b-') }, backend.clock);
      await electorA.tick();
      await electorB.tick();
      expect(electorA.isLeader()).toBe(true);
      expect(electorB.isLeader()).toBe(false);
      expect(electorB.status().holder).toBe(`main-a-${backend.name}`);
      // A goes quiet (a crash, a pause): B can only win once A's key expired, and A steps down on its own first.
      if (backend.name === 'memory') {
        await backend.advance(ttl - 100);
        expect(electorA.isLeader()).toBe(false);
        await electorB.tick();
        expect(electorB.isLeader()).toBe(false);
        await backend.advance(200);
      } else {
        await backend.advance(ttl + 100);
        expect(electorA.isLeader()).toBe(false);
      }
      await electorB.tick();
      expect(electorB.isLeader()).toBe(true);
      const tokenB = electorB.status().token;
      expect(tokenB).toBeGreaterThan(Number(events[0].slice(2)));
      // A comes back: it sees B lead and stays a follower.
      await electorA.tick();
      expect(electorA.isLeader()).toBe(false);
      expect(events).toContain(`b+${tokenB}`);
      expect(events.some((e) => e.startsWith('a-:'))).toBe(true);
      // B stops on purpose: it resigns, so A takes over on its next campaign without waiting for the TTL.
      await electorB.stop();
      await electorA.tick();
      expect(electorA.isLeader()).toBe(true);
      expect(electorA.status().token).toBeGreaterThan(tokenB);
      await electorA.stop();
    });

    it('steps down when it cannot reach the coordinator', async () => {
      const a = backend.connect();
      let now = Date.now();
      const failing = Object.create(a) as Coordinator;
      let broken = false;
      failing.campaign = (id, ttl) => (broken ? Promise.reject(new Error('connection lost')) : a.campaign(id, ttl));
      const reasons: string[] = [];
      const elector = new LeaderElector(failing, `main-x-${backend.name}-${randomUUID().slice(0, 4)}`, 1_000, { onDemoted: (reason) => void reasons.push(reason) }, () => now);
      await elector.tick();
      expect(elector.isLeader()).toBe(true);
      broken = true;
      await elector.tick();
      expect(elector.isLeader()).toBe(true);
      now += 900;
      await elector.tick();
      expect(elector.isLeader()).toBe(false);
      expect(reasons).toEqual(['the leadership lease could not be renewed in time']);
      broken = false;
      await elector.stop();
      await a.resign(elector.id);
    });
  });

  describe(`relay (${backend.name})`, () => {
    it('broadcasts to the other processes, never back to the sender, and delivers inbox messages to one instance', async () => {
      const one = new Relay(backend.connect(), 'main-1');
      const two = new Relay(backend.connect(), 'main-2');
      const worker = new Relay(backend.connect(), 'worker-1');
      const atOne: unknown[] = [];
      const atTwo: Array<[unknown, string]> = [];
      const inbox: unknown[] = [];
      await one.listen('control', (message) => atOne.push(message));
      await two.listen('control', (message, origin) => atTwo.push([message, origin]));
      await one.receive((message) => inbox.push(message));
      await one.broadcast('control', { t: 'stop-all' });
      await worker.send('main-1', { t: 'done', id: 'ex_1' });
      await worker.send('main-2', { t: 'done', id: 'ex_2' });
      await vi.waitFor(() => expect(atTwo).toEqual([[{ t: 'stop-all' }, 'main-1']]));
      await vi.waitFor(() => expect(inbox).toEqual([{ t: 'done', id: 'ex_1' }]));
      expect(atOne).toEqual([]);
      await Promise.all([one.close(), two.close(), worker.close()]);
    });
  });
}

describe('RESP', () => {
  it('encodes commands and parses replies split across chunks', () => {
    expect(encodeCommand(['SET', 'k', 'v', 'PX', 10]).toString()).toBe('*5\r\n$3\r\nSET\r\n$1\r\nk\r\n$1\r\nv\r\n$2\r\nPX\r\n$2\r\n10\r\n');
    const parser = new RespParser();
    const wire = Buffer.from('+OK\r\n:42\r\n$5\r\nhé\r\n\r\n*2\r\n$1\r\na\r\n*1\r\n$-1\r\n-ERR nope\r\n*-1\r\n');
    const values: unknown[] = [];
    for (let i = 0; i < wire.length; i += 3) {
      parser.push(wire.subarray(i, i + 3));
      for (let reply = parser.next(); reply; reply = parser.next()) values.push(reply.value);
    }
    expect(values.slice(0, 4)).toEqual(['OK', 42, 'hé\r\n', ['a', [null]]]);
    expect(values[4]).toBeInstanceOf(RespError);
    expect((values[4] as RespError).message).toBe('ERR nope');
    expect(values[5]).toBeNull();
  });

  it('reads Valkey URLs', () => {
    expect(parseValkeyUrl('redis://127.0.0.1:56379')).toMatchObject({ host: '127.0.0.1', port: 56379, tls: false });
    expect(parseValkeyUrl('rediss://user:p%40ss@cache.example:6380/2')).toMatchObject({ host: 'cache.example', port: 6380, tls: true, username: 'user', password: 'p@ss', db: 2 });
  });
});

describe('startup checks', () => {
  const env = (vars: Record<string, string>) => ({ ...vars }) as NodeJS.ProcessEnv;

  it('reads the settings with their defaults', () => {
    const config = clusterConfig(env({ LANDFLOW_EXECUTIONS_MODE: 'queue', LANDFLOW_WORKER_CONCURRENCY: '4', LANDFLOW_INSTANCE_ID: 'main a', LANDFLOW_STALLED_SECONDS: '60' }));
    expect(config).toMatchObject({ mode: 'queue', role: 'main', instanceId: 'main_a', stableId: true, workerConcurrency: 4, stalledMs: 60_000, heartbeatMs: 5_000, leaderTtlMs: 10_000, prefix: 'landflow' });
    expect(leaseMs(config)).toBe(20_000);
    expect(clusterConfig(env({})).mode).toBe('regular');
    expect(clusterConfig(env({ LANDFLOW_ROLE: 'worker' })).instanceId).toMatch(/^worker-/);
  });

  it('refuses SQLite in queue mode unless every process is on one host, and a worker outside queue mode', () => {
    const queue = clusterConfig(env({ LANDFLOW_EXECUTIONS_MODE: 'queue' }));
    expect(() => checkClusterConfig(queue, env({}))).toThrow(ClusterConfigError);
    expect(() => checkClusterConfig(queue, env({}))).toThrow(/LANDFLOW_QUEUE_ALLOW_SQLITE/);
    const single = clusterConfig(env({ LANDFLOW_EXECUTIONS_MODE: 'queue', LANDFLOW_QUEUE_ALLOW_SQLITE: 'true' }));
    expect(checkClusterConfig(single, env({ LANDFLOW_QUEUE_ALLOW_SQLITE: 'true' })).join('\n')).toMatch(/filesystem binary store/);
    expect(() => checkClusterConfig(clusterConfig(env({ LANDFLOW_ROLE: 'worker' })), env({}))).toThrow(/needs queue mode/);
    expect(checkClusterConfig(clusterConfig(env({})), env({}))).toEqual([]);
    const complete = env({ LANDFLOW_EXECUTIONS_MODE: 'queue', LANDFLOW_DB: 'postgres', LANDFLOW_BINARY_STORE: 's3', LANDFLOW_ENCRYPTION_KEY: 'k', LANDFLOW_BINARY_SECRET: 's', LANDFLOW_INSTANCE_ID: 'main-1' });
    expect(checkClusterConfig(clusterConfig(complete), complete)).toEqual([]);
    expect(checkClusterConfig(queue, { ...complete, LANDFLOW_INSTANCE_ID: undefined }).join('\n')).toMatch(/LANDFLOW_INSTANCE_ID/);
  });
});
