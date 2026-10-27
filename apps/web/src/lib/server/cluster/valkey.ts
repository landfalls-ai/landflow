/**
 * The Coordinator on Valkey (or Redis 7+). Keys live under `<prefix>:`:
 *
 * - `jobs`, `jobs:high`, `jobs:low`: the job streams by priority (normal, high, low), each consumed by the `workers` group (one
 *   consumer per worker process); a worker reads high first and takes a low job after every LOW_EVERY others (./coordinator).
 *   Delivery ids of the other two carry a prefix (`h|`, `l|`) that says which stream they belong to;
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
 * failover (`+switch-master`).
 *
 * Valkey Cluster (LANDFLOW_VALKEY_CLUSTER): the job stream is one key and the scripts above touch several keys at once
 * (leader + epoch, slots + FIFO, instances + their info), which Cluster only allows within one hash slot, so the prefix
 * becomes a hash tag (`{landflow}:jobs`, `{landflow}:k:…`): every key lives on the one node that owns that slot, and the
 * connections (commands, pub/sub, blocking reads) go to that node, ask the cluster again on MOVED / CLUSTERDOWN and follow
 * its failovers. That makes managed cluster-mode Valkey work; it can't scale the queue out (README).
 */
import { createHash } from 'node:crypto';
import { priorityOrder, type AdmitResult, type Coordinator, type Delivery, type InstanceInfo, type Leadership, type QueueJob, type SlotRule } from './coordinator';
import { askCluster, askSentinels, hashSlot, parseValkeyUrl, RespClient, RespError, type RespAddress, type RespArg, type RespOptions, type RespValue, type SentinelOptions, type ClusterOptions } from './resp';

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

type Priority = 'high' | 'normal' | 'low';
const PREFIX: Record<Priority, string> = { high: 'h|', normal: '', low: 'l|' };
const SUFFIX: Record<Priority, string> = { high: ':high', normal: '', low: ':low' };
const PRIORITIES: Priority[] = ['high', 'normal', 'low'];
const priorityOfId = (id: string): { priority: Priority; raw: string } => (id.startsWith('h|') ? { priority: 'high', raw: id.slice(2) } : id.startsWith('l|') ? { priority: 'low', raw: id.slice(2) } : { priority: 'normal', raw: id });

function parseEntries(entries: RespValue, priority: Priority = 'normal'): Delivery[] {
  if (!Array.isArray(entries)) return [];
  const out: Delivery[] = [];
  for (const entry of entries) {
    if (!Array.isArray(entry) || !Array.isArray(entry[1])) continue;
    const fields = entry[1] as RespValue[];
    const index = fields.findIndex((value, i) => i % 2 === 0 && value === 'job');
    if (index < 0) continue;
    try {
      out.push({ id: PREFIX[priority] + String(entry[0]), job: JSON.parse(String(fields[index + 1])) as QueueJob });
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
  private readonly connection: Pick<RespOptions, 'resolve' | 'primaryOnly' | 'cluster'>;
  /** The key prefix (in cluster mode wrapped in a hash tag). */
  private readonly prefix: string;
  private groupReady?: Promise<void>;
  private readonly claimCursors: Record<Priority, string> = { high: '0-0', normal: '0-0', low: '0-0' };
  /** Jobs taken since the last low-priority one (priorityOrder). */
  private sinceLow = 0;

  constructor(
    private readonly url: string,
    prefix: string,
    private readonly name = 'landflow',
    options: { sentinel?: SentinelOptions; cluster?: Pick<ClusterOptions, 'nodes' | 'natMap'> } = {},
  ) {
    const { sentinel, cluster } = options;
    this.prefix = cluster ? `{${prefix}}` : prefix;
    if (cluster) {
      const { username, password, tls } = parseValkeyUrl(url);
      const seeds: ClusterOptions = { nodes: [...cluster.nodes], natMap: cluster.natMap, username, password, tls };
      const slot = hashSlot(this.prefix);
      this.connection = { resolve: () => askCluster(seeds, slot), primaryOnly: true, cluster: true };
    } else this.connection = sentinel ? { resolve: () => askSentinels(sentinel), primaryOnly: true } : {};
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

  private streamOf(priority: Priority): string {
    return this.key(`jobs${SUFFIX[priority]}`);
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
    this.groupReady ??= Promise.all(
      PRIORITIES.map((priority) =>
        this.cmd.call('XGROUP', 'CREATE', this.streamOf(priority), GROUP, '0', 'MKSTREAM').then(
          () => undefined,
          (error: Error) => {
            if (error instanceof RespError && error.message.startsWith('BUSYGROUP')) return;
            throw error;
          },
        ),
      ),
    ).then(
      () => undefined,
      (error: Error) => {
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
    const priority = job.priority ?? 'normal';
    return PREFIX[priority] + String(await this.cmd.call('XADD', this.streamOf(priority), '*', 'job', JSON.stringify(job)));
  }

  /** What the streams gave, kept in the order they were asked in, and counted for the low-priority turn. */
  private tally(taken: Delivery[]): Delivery[] {
    for (const delivery of taken) this.sinceLow = priorityOfId(delivery.id).priority === 'low' ? 0 : this.sinceLow + 1;
    return taken;
  }

  async take(consumer: string, count: number, blockMs: number): Promise<Delivery[]> {
    // Whatever is waiting now, high priority first (a low job goes first after LOW_EVERY others).
    const taken: Delivery[] = [];
    for (const priority of priorityOrder(this.sinceLow)) {
      if (taken.length >= count) break;
      const reply = await this.withGroup(() => this.cmd.call('XREADGROUP', 'GROUP', GROUP, consumer, 'COUNT', count - taken.length, 'STREAMS', this.streamOf(priority), '>'));
      if (Array.isArray(reply)) taken.push(...reply.flatMap((stream) => (Array.isArray(stream) ? parseEntries(stream[1], priority) : [])));
    }
    if (taken.length || blockMs <= 0) return this.tally(taken);
    // Nothing: wait on all three streams for the first job (a few may arrive together: the surplus goes back).
    this.blocking ??= new RespClient({ url: this.url, name: `${this.name}:block`, timeoutMs: 0, ...this.connection });
    const blocking = this.blocking;
    const reply = await this.withGroup(() =>
      blocking.callWithTimeout(blockMs + 10_000, 'XREADGROUP', 'GROUP', GROUP, consumer, 'COUNT', count, 'BLOCK', blockMs, 'STREAMS', ...PRIORITIES.map((p) => this.streamOf(p)), ...PRIORITIES.map(() => '>')),
    );
    if (!Array.isArray(reply)) return [];
    const got = reply.flatMap((stream) => {
      if (!Array.isArray(stream)) return [];
      const priority = PRIORITIES.find((p) => this.streamOf(p) === String(stream[0])) ?? 'normal';
      return parseEntries(stream[1], priority);
    });
    got.sort((a, b) => PRIORITIES.indexOf(priorityOfId(a.id).priority) - PRIORITIES.indexOf(priorityOfId(b.id).priority));
    for (const extra of got.slice(count)) await this.requeue(extra);
    return this.tally(got.slice(0, count));
  }

  async ack(id: string): Promise<void> {
    const { priority, raw } = priorityOfId(id);
    await Promise.all([this.cmd.call('XACK', this.streamOf(priority), GROUP, raw), this.cmd.call('XDEL', this.streamOf(priority), raw)]);
  }

  async touch(consumer: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    for (const priority of PRIORITIES) {
      const raw = ids.map(priorityOfId).filter((entry) => entry.priority === priority).map((entry) => entry.raw);
      if (raw.length) await this.withGroup(() => this.cmd.call('XCLAIM', this.streamOf(priority), GROUP, consumer, 0, ...raw, 'JUSTID'));
    }
  }

  async claimStalled(consumer: string, minIdleMs: number, count: number): Promise<Delivery[]> {
    const taken: Delivery[] = [];
    for (const priority of PRIORITIES) {
      if (taken.length >= count) break;
      const reply = await this.withGroup(() => this.cmd.call('XAUTOCLAIM', this.streamOf(priority), GROUP, consumer, Math.floor(minIdleMs), this.claimCursors[priority], 'COUNT', count - taken.length));
      if (!Array.isArray(reply)) continue;
      this.claimCursors[priority] = String(reply[0] ?? '0-0');
      // Entries deleted while pending: nothing to run, drop them from the pending list.
      const deleted = Array.isArray(reply[2]) ? reply[2].map(String) : [];
      if (deleted.length) await this.cmd.call('XACK', this.streamOf(priority), GROUP, ...deleted).catch(() => {});
      taken.push(...parseEntries(reply[1], priority));
    }
    return taken;
  }

  async requeue(delivery: Delivery): Promise<void> {
    await this.enqueue(delivery.job);
    await this.ack(delivery.id);
  }

  async queueStats(): Promise<{ waiting: number; active: number }> {
    let waiting = 0;
    let active = 0;
    for (const priority of PRIORITIES) {
      const stream = this.streamOf(priority);
      const [length, pending] = await Promise.all([this.cmd.call('XLEN', stream), this.withGroup(() => this.cmd.call('XPENDING', stream, GROUP))]);
      const pend = Array.isArray(pending) ? Number(pending[0] ?? 0) : 0;
      active += pend;
      waiting += Math.max(0, Number(length ?? 0) - pend);
    }
    return { waiting, active };
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
