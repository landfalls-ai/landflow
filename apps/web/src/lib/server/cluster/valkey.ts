/**
 * The Coordinator on Valkey (or Redis 7+). Keys live under `<prefix>:`:
 *
 * - `jobs`: the job stream, consumed by the `workers` group (one consumer per worker process);
 * - `k:<key>`: leases, claims and markers with a time to live;
 * - `leader` (`<id>|<token>`, with a TTL) and `leader:epoch` (the fencing token counter);
 * - `slots:<workflowId>` / `fifo:<workflowId>`: sorted sets of the runs holding a concurrency slot (score: lease
 *   expiry) and of the runs waiting for one (score: when they were queued);
 * - `rate:<key>`: sliding-window rate limit stamps; `instances` / `instance-info`: heartbeats;
 * - `ch:<name>`: pub/sub channels.
 *
 * The atomic parts (leader election, admission, draining, rate limits) are Lua scripts that read the server's clock,
 * so hosts with skewed clocks agree on leases.
 *
 * High availability: with Sentinel (LANDFLOW_VALKEY_SENTINELS) every connection of this coordinator (commands,
 * pub/sub, blocking reads) asks the sentinels for the primary, and all of them reconnect when the sentinels announce a
 * failover (`+switch-master`). Valkey Cluster is not supported: the job stream is one key (so one shard), and the
 * scripts above touch several keys at once (leader + epoch, slots + FIFO, instances + their info), which Cluster only
 * allows within one hash slot, so every key would share one hash tag and live on one node anyway (README).
 */
import { createHash } from 'node:crypto';
import type { AdmitResult, Coordinator, Delivery, InstanceInfo, Leadership, QueueJob, SlotRule } from './coordinator';
import { askSentinels, RespClient, RespError, type RespAddress, type RespArg, type RespOptions, type RespValue, type SentinelOptions } from './resp';

const GROUP = 'workers';
const NOW = `local t = redis.call('TIME') local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)`;

const SCRIPTS = {
  campaign: `
    local cur = redis.call('GET', KEYS[1])
    if not cur then
      local token = redis.call('INCR', KEYS[2])
      redis.call('SET', KEYS[1], ARGV[1] .. '|' .. token, 'PX', ARGV[2])
      return {ARGV[1], token, 1}
    end
    local sep = string.find(cur, '|', 1, true)
    local holder = string.sub(cur, 1, sep - 1)
    local token = tonumber(string.sub(cur, sep + 1))
    if holder == ARGV[1] then
      redis.call('PEXPIRE', KEYS[1], ARGV[2])
      return {holder, token, 1}
    end
    return {holder, token, 0}`,
  resign: `
    local cur = redis.call('GET', KEYS[1])
    if cur and string.sub(cur, 1, string.len(ARGV[1]) + 1) == ARGV[1] .. '|' then return redis.call('DEL', KEYS[1]) end
    return 0`,
  extendIf: `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`,
  deleteIf: `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`,
  incr: `local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end return n`,
  admit: `${NOW}
    redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
    local running = redis.call('ZCARD', KEYS[1])
    local queued = redis.call('ZCARD', KEYS[2])
    local limit = tonumber(ARGV[3])
    if (limit < 0 or running + tonumber(ARGV[4]) < limit) and queued == 0 then
      redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
      return 'run'
    end
    if ARGV[5] == 'skip' then return 'skip' end
    if queued >= tonumber(ARGV[6]) then return 'full' end
    return 'queue'`,
  drain: `${NOW}
    redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
    local limit = tonumber(ARGV[2])
    local waiting = tonumber(ARGV[3])
    local started = {}
    for i = 1, 100 do
      if limit >= 0 and redis.call('ZCARD', KEYS[1]) + waiting >= limit then break end
      local head = redis.call('ZRANGE', KEYS[2], 0, 0)
      if #head == 0 then break end
      redis.call('ZREM', KEYS[2], head[1])
      redis.call('ZADD', KEYS[1], now + tonumber(ARGV[1]), head[1])
      table.insert(started, head[1])
    end
    return started`,
  hold: `${NOW}
    for i = 1, #KEYS do redis.call('ZADD', KEYS[i], now + tonumber(ARGV[1]), ARGV[i + 1]) end
    return #KEYS`,
  rate: `${NOW}
    redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - tonumber(ARGV[2]))
    if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[1]) then
      redis.call('ZADD', KEYS[1], now, now .. '-' .. ARGV[3])
      redis.call('PEXPIRE', KEYS[1], ARGV[2])
      return 0
    end
    local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
    return math.max(1, tonumber(oldest[2]) + tonumber(ARGV[2]) - now)`,
  heartbeat: `${NOW}
    redis.call('ZADD', KEYS[1], now + tonumber(ARGV[3]), ARGV[1])
    redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
    return 1`,
  instances: `${NOW}
    local gone = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)
    for _, id in ipairs(gone) do redis.call('HDEL', KEYS[2], id) end
    redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
    local ids = redis.call('ZRANGE', KEYS[1], 0, -1)
    if #ids == 0 then return {} end
    return redis.call('HMGET', KEYS[2], unpack(ids))`,
} as const;

type ScriptName = keyof typeof SCRIPTS;
const SHA = Object.fromEntries(Object.entries(SCRIPTS).map(([name, body]) => [name, createHash('sha1').update(body).digest('hex')])) as Record<ScriptName, string>;

function parseEntries(entries: RespValue): Delivery[] {
  if (!Array.isArray(entries)) return [];
  const out: Delivery[] = [];
  for (const entry of entries) {
    if (!Array.isArray(entry) || !Array.isArray(entry[1])) continue;
    const fields = entry[1] as RespValue[];
    const index = fields.findIndex((value, i) => i % 2 === 0 && value === 'job');
    if (index < 0) continue;
    try {
      out.push({ id: String(entry[0]), job: JSON.parse(String(fields[index + 1])) as QueueJob });
    } catch {
      // A malformed entry: skipped (and left for its consumer's pending list).
    }
  }
  return out;
}

export class ValkeyCoordinator implements Coordinator {
  readonly kind = 'valkey' as const;
  private readonly cmd: RespClient;
  private readonly sub: RespClient;
  private blocking?: RespClient;
  /** Sentinel: a connection to one of the sentinels that hears failovers. */
  private readonly watcher?: RespClient;
  private readonly connection: Pick<RespOptions, 'resolve' | 'primaryOnly'>;
  private groupReady?: Promise<void>;
  private claimCursor = '0-0';

  constructor(
    private readonly url: string,
    private readonly prefix: string,
    private readonly name = 'landflow',
    options: { sentinel?: SentinelOptions } = {},
  ) {
    const { sentinel } = options;
    this.connection = sentinel ? { resolve: () => askSentinels(sentinel), primaryOnly: true } : {};
    this.cmd = new RespClient({ url, name: `${name}:cmd`, ...this.connection });
    this.sub = new RespClient({ url, name: `${name}:sub`, subscriber: true, timeoutMs: 10_000, ...this.connection });
    if (sentinel) this.watcher = this.watchFailovers(sentinel);
  }

  /** Reconnect every connection when the sentinels promote another primary (calls in flight fail and are retried by their callers). */
  private watchFailovers(sentinel: SentinelOptions): RespClient {
    let next = 0;
    const credentials = sentinel.password ? `${encodeURIComponent(sentinel.username ?? '')}:${encodeURIComponent(sentinel.password)}@` : '';
    const watcher = new RespClient({
      url: `${sentinel.tls ? 'rediss' : 'redis'}://${credentials}sentinel`,
      name: `${this.name}:sentinel`,
      subscriber: true,
      // Waits for a sentinel however long it takes.
      timeoutMs: 0,
      resolve: async () => sentinel.sentinels[next++ % sentinel.sentinels.length],
    });
    void watcher
      .subscribe('+switch-master', (message) => {
        if (message.split(' ')[0] !== sentinel.masterName) return;
        for (const client of [this.cmd, this.sub, this.blocking]) client?.reconnect();
      })
      .catch(() => {});
    return watcher;
  }

  /** The server the command connection uses (with Sentinel: the primary it last found). */
  get primary(): RespAddress | undefined {
    return this.cmd.address;
  }

  private key(...parts: string[]): string {
    return [this.prefix, ...parts].join(':');
  }

  private get stream(): string {
    return this.key('jobs');
  }

  /** Wait until the command connection is up (or fail after `timeoutMs`). */
  async ping(timeoutMs = 5_000): Promise<void> {
    await this.cmd.callWithTimeout(timeoutMs, 'PING');
  }

  private async script(name: ScriptName, keys: string[], args: RespArg[]): Promise<RespValue> {
    try {
      return await this.cmd.call('EVALSHA', SHA[name], keys.length, ...keys, ...args);
    } catch (error) {
      if (!(error instanceof RespError) || !error.message.startsWith('NOSCRIPT')) throw error;
      return this.cmd.call('EVAL', SCRIPTS[name], keys.length, ...keys, ...args);
    }
  }

  private ensureGroup(): Promise<void> {
    this.groupReady ??= this.cmd.call('XGROUP', 'CREATE', this.stream, GROUP, '0', 'MKSTREAM').then(
      () => undefined,
      (error: Error) => {
        if (error instanceof RespError && error.message.startsWith('BUSYGROUP')) return;
        this.groupReady = undefined;
        throw error;
      },
    );
    return this.groupReady;
  }

  /** Run a group command; if the group vanished (Valkey restarted without persistence), create it and retry once. */
  private async withGroup<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureGroup();
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof RespError) || !error.message.startsWith('NOGROUP')) throw error;
      this.groupReady = undefined;
      await this.ensureGroup();
      return fn();
    }
  }

  // ---- job queue -------------------------------------------------------------

  async enqueue(job: QueueJob): Promise<string> {
    return String(await this.cmd.call('XADD', this.stream, '*', 'job', JSON.stringify(job)));
  }

  async take(consumer: string, count: number, blockMs: number): Promise<Delivery[]> {
    this.blocking ??= new RespClient({ url: this.url, name: `${this.name}:block`, timeoutMs: 0, ...this.connection });
    const blocking = this.blocking;
    const reply = await this.withGroup(() => blocking.callWithTimeout(blockMs + 10_000, 'XREADGROUP', 'GROUP', GROUP, consumer, 'COUNT', count, 'BLOCK', blockMs, 'STREAMS', this.stream, '>'));
    if (!Array.isArray(reply)) return [];
    return reply.flatMap((stream) => (Array.isArray(stream) ? parseEntries(stream[1]) : []));
  }

  async ack(id: string): Promise<void> {
    await Promise.all([this.cmd.call('XACK', this.stream, GROUP, id), this.cmd.call('XDEL', this.stream, id)]);
  }

  async touch(consumer: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.withGroup(() => this.cmd.call('XCLAIM', this.stream, GROUP, consumer, 0, ...ids, 'JUSTID'));
  }

  async claimStalled(consumer: string, minIdleMs: number, count: number): Promise<Delivery[]> {
    const reply = await this.withGroup(() => this.cmd.call('XAUTOCLAIM', this.stream, GROUP, consumer, Math.floor(minIdleMs), this.claimCursor, 'COUNT', count));
    if (!Array.isArray(reply)) return [];
    this.claimCursor = String(reply[0] ?? '0-0');
    // Entries deleted while pending: nothing to run, drop them from the pending list.
    const deleted = Array.isArray(reply[2]) ? reply[2].map(String) : [];
    if (deleted.length) await this.cmd.call('XACK', this.stream, GROUP, ...deleted).catch(() => {});
    return parseEntries(reply[1]);
  }

  async requeue(delivery: Delivery): Promise<void> {
    await this.cmd.call('XADD', this.stream, '*', 'job', JSON.stringify(delivery.job));
    await this.ack(delivery.id);
  }

  async queueStats(): Promise<{ waiting: number; active: number }> {
    const [length, pending] = await Promise.all([this.cmd.call('XLEN', this.stream), this.withGroup(() => this.cmd.call('XPENDING', this.stream, GROUP))]);
    const active = Array.isArray(pending) ? Number(pending[0] ?? 0) : 0;
    return { waiting: Math.max(0, Number(length ?? 0) - active), active };
  }

  // ---- keys ------------------------------------------------------------------

  async setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
    return (await this.cmd.call('SET', this.key('k', key), value, 'NX', 'PX', Math.max(1, Math.floor(ttlMs)))) === 'OK';
  }

  async get(key: string): Promise<string | undefined> {
    const value = await this.cmd.call('GET', this.key('k', key));
    return value === null ? undefined : String(value);
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    await this.cmd.call('SET', this.key('k', key), value, ...(ttlMs ? ['PX', Math.max(1, Math.floor(ttlMs))] : []));
  }

  async getMany(keys: string[]): Promise<Array<string | undefined>> {
    if (!keys.length) return [];
    const reply = await this.cmd.call('MGET', ...keys.map((key) => this.key('k', key)));
    return (Array.isArray(reply) ? reply : []).map((value) => (value === null ? undefined : String(value)));
  }

  async setMany(entries: Array<[string, string]>, ttlMs: number): Promise<void> {
    await Promise.all(entries.map(([key, value]) => this.cmd.call('SET', this.key('k', key), value, 'PX', Math.max(1, Math.floor(ttlMs)))));
  }

  async extendIfValue(key: string, value: string, ttlMs: number): Promise<boolean> {
    return Number(await this.script('extendIf', [this.key('k', key)], [value, Math.max(1, Math.floor(ttlMs))])) === 1;
  }

  async deleteIfValue(key: string, value: string): Promise<boolean> {
    return Number(await this.script('deleteIf', [this.key('k', key)], [value])) === 1;
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.cmd.call('DEL', ...keys.map((key) => this.key('k', key)));
  }

  async incr(key: string, ttlMs: number): Promise<number> {
    return Number(await this.script('incr', [this.key('k', key)], [Math.max(1, Math.floor(ttlMs))]));
  }

  // ---- leader election -------------------------------------------------------

  async campaign(id: string, ttlMs: number): Promise<Leadership> {
    const reply = (await this.script('campaign', [this.key('leader'), this.key('leader', 'epoch')], [id, Math.floor(ttlMs)])) as RespValue[];
    return { holder: String(reply[0]), token: Number(reply[1]), mine: Number(reply[2]) === 1 };
  }

  async resign(id: string): Promise<void> {
    await this.script('resign', [this.key('leader')], [id]);
  }

  async leadership(): Promise<Leadership> {
    const [current, epoch] = await Promise.all([this.cmd.call('GET', this.key('leader')), this.cmd.call('GET', this.key('leader', 'epoch'))]);
    if (current === null) return { token: Number(epoch ?? 0), mine: false };
    const [holder, token] = String(current).split('|');
    return { holder, token: Number(token), mine: false };
  }

  // ---- concurrency -------------------------------------------------------------

  async admit(workflowId: string, executionId: string, rule: SlotRule, leaseMs: number): Promise<AdmitResult> {
    const slots = Number.isFinite(rule.slots) ? rule.slots : -1;
    const reply = await this.script('admit', [this.key('slots', workflowId), this.key('fifo', workflowId)], [executionId, Math.floor(leaseMs), slots, rule.waiting, rule.overflow, rule.queueSize]);
    return String(reply) as AdmitResult;
  }

  async addToQueue(workflowId: string, executionId: string, queuedAtMs: number): Promise<void> {
    await this.cmd.call('ZADD', this.key('fifo', workflowId), 'NX', queuedAtMs, executionId);
  }

  async holdSlots(entries: Array<{ workflowId: string; executionId: string }>, leaseMs: number): Promise<void> {
    if (!entries.length) return;
    await this.script(
      'hold',
      entries.map((entry) => this.key('slots', entry.workflowId)),
      [Math.floor(leaseMs), ...entries.map((entry) => entry.executionId)],
    );
  }

  async releaseSlot(workflowId: string, executionId: string): Promise<void> {
    await this.cmd.call('ZREM', this.key('slots', workflowId), executionId);
  }

  async drain(workflowId: string, rule: SlotRule, leaseMs: number): Promise<string[]> {
    const slots = Number.isFinite(rule.slots) ? rule.slots : -1;
    const reply = await this.script('drain', [this.key('slots', workflowId), this.key('fifo', workflowId)], [Math.floor(leaseMs), slots, rule.waiting]);
    return Array.isArray(reply) ? reply.map(String) : [];
  }

  async removeFromQueue(workflowId: string, executionId: string): Promise<void> {
    await this.cmd.call('ZREM', this.key('fifo', workflowId), executionId);
  }

  async isQueued(workflowId: string, executionId: string): Promise<boolean> {
    return (await this.cmd.call('ZSCORE', this.key('fifo', workflowId), executionId)) !== null;
  }

  async slotUsage(workflowId: string): Promise<{ running: number; queued: number }> {
    const [running, queued] = await Promise.all([this.cmd.call('ZCARD', this.key('slots', workflowId)), this.cmd.call('ZCARD', this.key('fifo', workflowId))]);
    return { running: Number(running ?? 0), queued: Number(queued ?? 0) };
  }

  async rateLimit(key: string, limit: number, intervalMs: number): Promise<number> {
    const member = Math.random().toString(36).slice(2, 10);
    return Number(await this.script('rate', [this.key('rate', key)], [Math.max(1, Math.floor(limit)), Math.max(1, Math.floor(intervalMs)), member]));
  }

  // ---- pub/sub -----------------------------------------------------------------

  async publish(channel: string, message: string): Promise<void> {
    await this.cmd.call('PUBLISH', this.key('ch', channel), message);
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<() => Promise<void>> {
    return this.sub.subscribe(this.key('ch', channel), (message) => handler(message));
  }

  // ---- instances ---------------------------------------------------------------

  async heartbeat(info: InstanceInfo, ttlMs: number): Promise<void> {
    await this.script('heartbeat', [this.key('instances'), this.key('instance-info')], [info.id, JSON.stringify(info), Math.floor(ttlMs)]);
  }

  async instances(): Promise<InstanceInfo[]> {
    const reply = await this.script('instances', [this.key('instances'), this.key('instance-info')], []);
    if (!Array.isArray(reply)) return [];
    return reply.flatMap((value) => {
      if (value === null) return [];
      try {
        return [JSON.parse(String(value)) as InstanceInfo];
      } catch {
        return [];
      }
    });
  }

  async forget(id: string): Promise<void> {
    await Promise.all([this.cmd.call('ZREM', this.key('instances'), id), this.cmd.call('HDEL', this.key('instance-info'), id)]);
  }

  async close(): Promise<void> {
    await Promise.all([this.cmd.close(), this.sub.close(), this.blocking?.close(), this.watcher?.close()]);
  }
}
