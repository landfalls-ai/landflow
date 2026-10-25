/**
 * The Coordinator as an in-process double with Valkey's semantics: a stream with one consumer group (pending entries,
 * idle times, takeover), keys with a time to live, leader election with fencing tokens, slot and FIFO sets, rate
 * limits, pub/sub and heartbeats. Several MemoryCoordinators on one MemoryHub act like processes sharing a Valkey
 * (tests of failover, takeover and relays); `clock` lets a test move time.
 */
import type { AdmitResult, Coordinator, Delivery, InstanceInfo, Leadership, QueueJob, SlotRule } from './coordinator';

interface Entry {
  id: string;
  job: string;
}

interface PendingEntry {
  consumer: string;
  deliveredAt: number;
}

export class MemoryHub {
  readonly entries = new Map<string, Entry>();
  /** Entries not yet delivered, oldest first. */
  readonly undelivered: string[] = [];
  readonly pending = new Map<string, PendingEntry>();
  readonly keys = new Map<string, { value: string; expiresAt?: number }>();
  readonly zsets = new Map<string, Map<string, number>>();
  readonly channels = new Map<string, Set<(message: string) => void>>();
  readonly instanceInfo = new Map<string, { info: InstanceInfo; expiresAt: number }>();
  private seq = 0;
  private readonly takers = new Set<() => void>();

  constructor(readonly clock: () => number = Date.now) {}

  nextId(): string {
    return `${this.clock()}-${++this.seq}`;
  }

  /** Wake blocked takers (a job arrived). */
  wake() {
    for (const wake of [...this.takers]) wake();
  }

  waitForEntry(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.takers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.takers.add(done);
    });
  }

  key(name: string): string | undefined {
    const entry = this.keys.get(name);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.clock()) {
      this.keys.delete(name);
      return undefined;
    }
    return entry.value;
  }

  zset(name: string): Map<string, number> {
    let set = this.zsets.get(name);
    if (!set) {
      set = new Map();
      this.zsets.set(name, set);
    }
    return set;
  }

  /** Members by score, lowest first. */
  sorted(name: string): string[] {
    return [...this.zset(name).entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([member]) => member);
  }

  expire(name: string) {
    const now = this.clock();
    for (const [member, score] of this.zset(name)) if (score <= now) this.zset(name).delete(member);
  }
}

export class MemoryCoordinator implements Coordinator {
  readonly kind = 'memory' as const;
  private closed = false;
  private readonly subscriptions = new Set<() => void>();

  constructor(readonly hub: MemoryHub = new MemoryHub()) {}

  private get now(): number {
    return this.hub.clock();
  }

  async enqueue(job: QueueJob): Promise<string> {
    const id = this.hub.nextId();
    this.hub.entries.set(id, { id, job: JSON.stringify(job) });
    this.hub.undelivered.push(id);
    this.hub.wake();
    return id;
  }

  private deliveries(ids: string[]): Delivery[] {
    return ids.flatMap((id) => {
      const entry = this.hub.entries.get(id);
      return entry ? [{ id, job: JSON.parse(entry.job) as QueueJob }] : [];
    });
  }

  async take(consumer: string, count: number, blockMs: number): Promise<Delivery[]> {
    const deadline = Date.now() + blockMs;
    for (;;) {
      if (this.closed) return [];
      if (this.hub.undelivered.length) {
        const ids = this.hub.undelivered.splice(0, count);
        for (const id of ids) this.hub.pending.set(id, { consumer, deliveredAt: this.now });
        return this.deliveries(ids);
      }
      const left = deadline - Date.now();
      if (left <= 0) return [];
      await this.hub.waitForEntry(Math.min(left, 50));
    }
  }

  async ack(id: string): Promise<void> {
    this.hub.pending.delete(id);
    this.hub.entries.delete(id);
  }

  async touch(consumer: string, ids: string[]): Promise<void> {
    for (const id of ids) if (this.hub.entries.has(id)) this.hub.pending.set(id, { consumer, deliveredAt: this.now });
  }

  async claimStalled(consumer: string, minIdleMs: number, count: number): Promise<Delivery[]> {
    const ids: string[] = [];
    for (const [id, pending] of this.hub.pending) {
      if (ids.length >= count) break;
      if (this.now - pending.deliveredAt < minIdleMs) continue;
      if (!this.hub.entries.has(id)) {
        this.hub.pending.delete(id);
        continue;
      }
      this.hub.pending.set(id, { consumer, deliveredAt: this.now });
      ids.push(id);
    }
    return this.deliveries(ids);
  }

  async requeue(delivery: Delivery): Promise<void> {
    await this.enqueue(delivery.job);
    await this.ack(delivery.id);
  }

  async queueStats(): Promise<{ waiting: number; active: number }> {
    return { waiting: this.hub.undelivered.length, active: this.hub.pending.size };
  }

  async setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
    if (this.hub.key(key) !== undefined) return false;
    this.hub.keys.set(key, { value, expiresAt: this.now + ttlMs });
    return true;
  }

  async get(key: string): Promise<string | undefined> {
    return this.hub.key(key);
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.hub.keys.set(key, { value, ...(ttlMs && { expiresAt: this.now + ttlMs }) });
  }

  async getMany(keys: string[]): Promise<Array<string | undefined>> {
    return keys.map((key) => this.hub.key(key));
  }

  async setMany(entries: Array<[string, string]>, ttlMs: number): Promise<void> {
    for (const [key, value] of entries) this.hub.keys.set(key, { value, expiresAt: this.now + ttlMs });
  }

  async extendIfValue(key: string, value: string, ttlMs: number): Promise<boolean> {
    if (this.hub.key(key) !== value) return false;
    this.hub.keys.set(key, { value, expiresAt: this.now + ttlMs });
    return true;
  }

  async deleteIfValue(key: string, value: string): Promise<boolean> {
    if (this.hub.key(key) !== value) return false;
    this.hub.keys.delete(key);
    return true;
  }

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) this.hub.keys.delete(key);
  }

  async incr(key: string, ttlMs: number): Promise<number> {
    const current = Number(this.hub.key(key) ?? 0) + 1;
    const existing = this.hub.keys.get(key);
    this.hub.keys.set(key, { value: String(current), expiresAt: current === 1 || !existing?.expiresAt ? this.now + ttlMs : existing.expiresAt });
    return current;
  }

  async campaign(id: string, ttlMs: number): Promise<Leadership> {
    const current = this.hub.key('\0leader');
    if (current === undefined) {
      const token = Number(this.hub.key('\0leader:epoch') ?? 0) + 1;
      this.hub.keys.set('\0leader:epoch', { value: String(token) });
      this.hub.keys.set('\0leader', { value: `${id}|${token}`, expiresAt: this.now + ttlMs });
      return { holder: id, token, mine: true };
    }
    const [holder, token] = current.split('|');
    if (holder === id) this.hub.keys.set('\0leader', { value: current, expiresAt: this.now + ttlMs });
    return { holder, token: Number(token), mine: holder === id };
  }

  async resign(id: string): Promise<void> {
    if (this.hub.key('\0leader')?.startsWith(`${id}|`)) this.hub.keys.delete('\0leader');
  }

  async leadership(): Promise<Leadership> {
    const current = this.hub.key('\0leader');
    if (!current) return { token: Number(this.hub.key('\0leader:epoch') ?? 0), mine: false };
    const [holder, token] = current.split('|');
    return { holder, token: Number(token), mine: false };
  }

  async admit(workflowId: string, executionId: string, rule: SlotRule, leaseMs: number): Promise<AdmitResult> {
    const slots = `slots:${workflowId}`;
    this.hub.expire(slots);
    const running = this.hub.zset(slots).size;
    const queued = this.hub.zset(`fifo:${workflowId}`).size;
    if (running + rule.waiting < rule.slots && queued === 0) {
      this.hub.zset(slots).set(executionId, this.now + leaseMs);
      return 'run';
    }
    if (rule.overflow === 'skip') return 'skip';
    if (queued >= rule.queueSize) return 'full';
    return 'queue';
  }

  async addToQueue(workflowId: string, executionId: string, queuedAtMs: number): Promise<void> {
    const fifo = this.hub.zset(`fifo:${workflowId}`);
    if (!fifo.has(executionId)) fifo.set(executionId, queuedAtMs);
  }

  async holdSlots(entries: Array<{ workflowId: string; executionId: string }>, leaseMs: number): Promise<void> {
    for (const entry of entries) this.hub.zset(`slots:${entry.workflowId}`).set(entry.executionId, this.now + leaseMs);
  }

  async releaseSlot(workflowId: string, executionId: string): Promise<void> {
    this.hub.zset(`slots:${workflowId}`).delete(executionId);
  }

  async drain(workflowId: string, rule: SlotRule, leaseMs: number): Promise<string[]> {
    const slots = `slots:${workflowId}`;
    const fifo = `fifo:${workflowId}`;
    this.hub.expire(slots);
    const started: string[] = [];
    while (started.length < 100 && this.hub.zset(slots).size + rule.waiting < rule.slots) {
      const head = this.hub.sorted(fifo)[0];
      if (!head) break;
      this.hub.zset(fifo).delete(head);
      this.hub.zset(slots).set(head, this.now + leaseMs);
      started.push(head);
    }
    return started;
  }

  async removeFromQueue(workflowId: string, executionId: string): Promise<void> {
    this.hub.zset(`fifo:${workflowId}`).delete(executionId);
  }

  async isQueued(workflowId: string, executionId: string): Promise<boolean> {
    return this.hub.zset(`fifo:${workflowId}`).has(executionId);
  }

  async slotUsage(workflowId: string): Promise<{ running: number; queued: number }> {
    this.hub.expire(`slots:${workflowId}`);
    return { running: this.hub.zset(`slots:${workflowId}`).size, queued: this.hub.zset(`fifo:${workflowId}`).size };
  }

  async rateLimit(key: string, limit: number, intervalMs: number): Promise<number> {
    const set = this.hub.zset(`rate:${key}`);
    const now = this.now;
    for (const [member, score] of set) if (score <= now - intervalMs) set.delete(member);
    if (set.size < limit) {
      set.set(`${now}-${Math.random()}`, now);
      return 0;
    }
    const oldest = Math.min(...set.values());
    return Math.max(1, oldest + intervalMs - now);
  }

  async publish(channel: string, message: string): Promise<void> {
    // Delivered asynchronously, like a server round trip.
    const handlers = [...(this.hub.channels.get(channel) ?? [])];
    queueMicrotask(() => {
      for (const handler of handlers) handler(message);
    });
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<() => Promise<void>> {
    let set = this.hub.channels.get(channel);
    if (!set) {
      set = new Set();
      this.hub.channels.set(channel, set);
    }
    set.add(handler);
    const unsubscribe = () => {
      set.delete(handler);
    };
    this.subscriptions.add(unsubscribe);
    return async () => {
      unsubscribe();
      this.subscriptions.delete(unsubscribe);
    };
  }

  async heartbeat(info: InstanceInfo, ttlMs: number): Promise<void> {
    this.hub.instanceInfo.set(info.id, { info, expiresAt: this.now + ttlMs });
  }

  async instances(): Promise<InstanceInfo[]> {
    const now = this.now;
    return [...this.hub.instanceInfo.values()].filter((entry) => entry.expiresAt > now).map((entry) => entry.info);
  }

  async forget(id: string): Promise<void> {
    this.hub.instanceInfo.delete(id);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions.clear();
    this.hub.wake();
  }
}
