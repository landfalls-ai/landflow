/**
 * `@landflow/transports/valkey`: the Valkey / Redis Streams driver (kind `valkey`; docs/protocol.md §14.9).
 *
 * - A channel is a stream (`<keyPrefix><channel>`); an entry's fields carry the CloudEvents headers (`h:<name>`) and the
 *   body (`b`), so the core runs in binary mode and stream tooling can read the attributes.
 * - **Shared** channels use a consumer group per `ConsumeOptions.group` (created at `0`, so events published before the
 *   first consumer wait for it): `XREADGROUP` with `COUNT` = free prefetch slots on a connection of the subscription's
 *   own (blocking reads), `XACK` on ack. Pending entries of a consumer that died are reclaimed with `XAUTOCLAIM` after
 *   `claimIdleMs`; in-flight entries send a keep-alive (`XCLAIM … JUSTID` by their owner) so a slow call is not stolen.
 *   `nack({ requeue: true })` and a closing consumer hand their entries to a parking consumer (`_orphans`) with their
 *   idle time already past `claimIdleMs`, so a survivor reclaims them on its next loop; the delivery count from
 *   `XPENDING` is the attempt.
 * - **Broadcast** channels (reply, registry, control) are read with `XREAD` from the id current at subscribe time.
 * - Streams are trimmed on every `XADD`: `MINID ~ now - ttlMs` for channels declared with a TTL, else `MAXLEN ~ maxLen`.
 * - `stats()`: `XINFO GROUPS` lag as depth, live consumers (`XINFO CONSUMERS`, idle below a threshold) as consumers.
 *
 * The client is `iovalkey` (the Valkey project's maintained fork of ioredis), imported lazily in `connect()`.
 */
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { Redis } from 'iovalkey';
import {
  NotConnectedError,
  type BrokerCapabilities,
  type BrokerConfig,
  type BrokerDriver,
  type ChannelSpec,
  type ChannelStats,
  type ConsumeHandler,
  type ConsumeOptions,
  type Delivery,
  type PublishOptions,
  type PublishOutcome,
  type Subscription,
  type WireEvent,
} from '../../driver';
import type { BrokerTarget, ConnectionOptions, DriverModule } from '../index';

const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
export const DEFAULT_MAX_LEN = 10_000;
export const DEFAULT_CLAIM_IDLE_MS = 30_000;
export const DEFAULT_BLOCK_MS = 1_000;
/** The parking consumer that owns requeued entries until a live consumer reclaims them. */
export const ORPHANS_CONSUMER = '_orphans';
const HEADER_FIELD = 'h:';
const BODY_FIELD = 'b';

export interface ValkeyConfig extends BrokerConfig {
  /** `redis://host:6379`, `rediss://` (TLS), `valkey://`, `valkeys://`; the database may follow (`/0`). */
  url: string;
  username?: string;
  password?: string;
  db?: number;
  tls?: boolean;
  /** Prepended to every stream key (default none; channel names already start with the channel prefix). */
  keyPrefix?: string;
  /** Largest event accepted (default 1 MiB), lowered to the server's `proto-max-bulk-len`. */
  maxMessageBytes?: number;
  /** `MAXLEN ~` for streams without a channel TTL (default 10 000 entries). */
  maxLen?: number;
  /** Pending entries idle this long are reclaimed by another consumer (default 30 s). */
  claimIdleMs?: number;
  /** How long one blocking read waits (default 1 s); bounds how fast a closed subscription stops. */
  blockMs?: number;
}

export const VALKEY_CAPABILITIES: BrokerCapabilities = {
  replies: 'reply-channel',
  workSharing: true,
  buffering: true,
  ttl: false,
  undeliverable: 'inferred',
  persistence: 'disk',
  maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
  latency: 'low',
  headers: true,
  orderingKeys: false,
  nack: true,
  attempts: true,
};

/** The config for a connection URL; `options.username`/`password`/`tls`/`db`/`keyPrefix` win over the URL. */
export function valkeyConfigFrom(connectionId: string, url: string, options: ConnectionOptions = {}): ValkeyConfig {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error(`Valkey URL "${url}" must look like redis://host:6379[/db] (or rediss:// for TLS)`);
  }
  const scheme = parsed.protocol.replace(/:$/, '');
  if (!['redis', 'rediss', 'valkey', 'valkeys'].includes(scheme)) throw new Error(`Valkey URL "${url}" must use redis://, rediss://, valkey:// or valkeys://`);
  if (!parsed.hostname) throw new Error(`Valkey URL "${url}" has no host`);
  const tls = options.tls ?? (scheme === 'rediss' || scheme === 'valkeys');
  const path = parsed.pathname.replace(/^\//, '');
  let db: number | undefined;
  const dbOption = options.db !== undefined && options.db !== '' ? Number(options.db) : path ? Number(path) : undefined;
  if (dbOption !== undefined) {
    if (!Number.isInteger(dbOption) || dbOption < 0) throw new Error(`Valkey database index "${options.db ?? path}" must be a non-negative integer`);
    db = dbOption;
  }
  const username = (typeof options.username === 'string' && options.username) || (parsed.username ? decodeURIComponent(parsed.username) : undefined);
  const password = (typeof options.password === 'string' && options.password) || (parsed.password ? decodeURIComponent(parsed.password) : undefined);
  const config: ValkeyConfig = {
    connectionId,
    url: `${tls ? 'rediss' : 'redis'}://${parsed.host}`,
    ...(options.prefix && { prefix: options.prefix }),
    ...(username && { username }),
    ...(password && { password }),
    ...(db !== undefined && { db }),
    ...(tls && { tls: true }),
  };
  if (typeof options.keyPrefix === 'string' && options.keyPrefix) config.keyPrefix = options.keyPrefix;
  for (const key of ['maxMessageBytes', 'maxLen', 'claimIdleMs', 'blockMs'] as const) {
    const value = Number(options[key]);
    if (Number.isFinite(value) && value > 0) config[key] = value;
  }
  return config;
}

/** The stream entry fields for an event: `h:<header>` per header and `b` for the body. */
export function toFields(event: WireEvent): (string | Buffer)[] {
  const fields: (string | Buffer)[] = [];
  for (const [name, value] of Object.entries(event.headers)) fields.push(HEADER_FIELD + name.toLowerCase(), value);
  fields.push(BODY_FIELD, Buffer.from(event.body.buffer, event.body.byteOffset, event.body.byteLength));
  return fields;
}

/** The inverse of `toFields` (field names and header values are UTF-8; the body stays bytes). */
export function fromFields(fields: Buffer[]): WireEvent {
  const headers: Record<string, string> = {};
  let body: Uint8Array = new Uint8Array(0);
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const name = fields[i].toString('utf8');
    if (name === BODY_FIELD) body = new Uint8Array(fields[i + 1]);
    else if (name.startsWith(HEADER_FIELD)) headers[name.slice(HEADER_FIELD.length).toLowerCase()] = fields[i + 1].toString('utf8');
  }
  return { headers, body };
}

type Entry = [id: Buffer, fields: Buffer[] | null];
type ReadReply = [key: Buffer, entries: Entry[]][] | null;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isBusyGroup = (error: unknown) => /BUSYGROUP/.test((error as Error)?.message ?? '');
const isNoKey = (error: unknown) => /no such key/i.test((error as Error)?.message ?? '');

/** `XINFO` replies are flat `[name, value, name, value…]` arrays. */
function asRecord(flat: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) out[String(flat[i])] = flat[i + 1];
  return out;
}

export class ValkeyDriver implements BrokerDriver<ValkeyConfig> {
  readonly kind = 'valkey';
  readonly capabilities: BrokerCapabilities = { ...VALKEY_CAPABILITIES };
  /** This process's consumer name in every group. */
  readonly consumerName = `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
  private client?: Redis;
  private config?: ValkeyConfig;
  private closing = false;
  private readonly specs = new Map<string, ChannelSpec>();
  private readonly subscriptions = new Set<Subscription>();

  async connect(config: ValkeyConfig): Promise<void> {
    if (this.client) throw new Error('Valkey driver is already connected');
    const { Redis } = await import('iovalkey');
    const url = new URL(config.url);
    const client = new Redis({
      host: url.hostname,
      port: url.port ? Number(url.port) : 6379,
      ...(config.username && { username: config.username }),
      ...(config.password && { password: config.password }),
      ...(config.db !== undefined && { db: config.db }),
      ...(config.tls && { tls: {} }),
      connectionName: `landflow-${config.connectionId}`,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(200 * times, 2_000),
    });
    client.on('error', () => {}); // reported through the rejected commands; an unhandled 'error' would crash the process
    try {
      await client.connect();
    } catch (error) {
      client.disconnect();
      throw error;
    }
    this.client = client;
    this.config = config;
    const wanted = config.maxMessageBytes ?? this.capabilities.maxMessageBytes;
    let serverMax: number | undefined;
    try {
      const reply = (await client.config('GET', 'proto-max-bulk-len')) as unknown;
      const value = Array.isArray(reply) ? Number(reply[1]) : Number((reply as Record<string, string>)?.['proto-max-bulk-len']);
      if (Number.isFinite(value) && value > 0) serverMax = value;
    } catch {
      /* CONFIG may be disabled on managed services: keep the configured limit */
    }
    this.capabilities.maxMessageBytes = serverMax ? Math.min(wanted, serverMax) : wanted;
  }

  async declare(channels: ChannelSpec[]): Promise<void> {
    this.ensureReady();
    for (const spec of channels) this.specs.set(spec.name, spec);
  }

  async publish(channel: string, event: WireEvent, _options?: PublishOptions): Promise<PublishOutcome> {
    const client = this.ensureReady();
    const ttl = this.specs.get(channel)?.ttlMs;
    const trim = ttl ? ['MINID', '~', String(Date.now() - ttl)] : ['MAXLEN', '~', String(this.config!.maxLen ?? DEFAULT_MAX_LEN)];
    await client.xadd(this.key(channel), ...trim, '*', ...toFields(event));
    return 'accepted';
  }

  async consume(channel: string, options: ConsumeOptions, onEvent: ConsumeHandler): Promise<Subscription> {
    const client = this.ensureReady();
    const conn = client.duplicate();
    conn.on('error', () => {});
    await conn.connect();
    try {
      const subscription = options.group ? await this.consumeGroup(conn, channel, options.group, options, onEvent) : await this.consumeBroadcast(conn, channel, onEvent);
      this.subscriptions.add(subscription);
      return subscription;
    } catch (error) {
      conn.disconnect();
      throw error;
    }
  }

  async stats(channel: string): Promise<ChannelStats> {
    const client = this.ensureReady();
    const key = this.key(channel);
    let groups: unknown[];
    try {
      groups = (await client.xinfo('GROUPS', key)) as unknown[];
    } catch (error) {
      if (isNoKey(error)) return { depth: 0, consumers: 0 };
      throw error;
    }
    const liveMs = Math.max(3 * (this.config!.blockMs ?? DEFAULT_BLOCK_MS), Math.floor((this.config!.claimIdleMs ?? DEFAULT_CLAIM_IDLE_MS) / 2));
    let depth = 0;
    let consumers = 0;
    for (const raw of groups) {
      const group = asRecord(raw);
      const lag = Number(group.lag);
      if (Number.isFinite(lag)) depth = Math.max(depth, lag);
      const members = (await client.xinfo('CONSUMERS', key, String(group.name))) as unknown[];
      for (const member of members.map(asRecord)) {
        if (member.name === ORPHANS_CONSUMER) continue;
        const idle = Number(member.idle);
        if (!Number.isFinite(idle) || idle <= liveMs) consumers++;
      }
    }
    return { depth, consumers };
  }

  async close(): Promise<void> {
    const client = this.client;
    if (!client || this.closing) return;
    this.closing = true;
    await Promise.allSettled([...this.subscriptions].map((s) => s.close()));
    this.subscriptions.clear();
    this.client = undefined;
    await client.quit().catch(() => client.disconnect());
  }

  private key(channel: string): string {
    return (this.config?.keyPrefix ?? '') + channel;
  }

  private ensureReady(): Redis {
    if (!this.client || this.closing || this.client.status !== 'ready') throw new NotConnectedError('valkey driver is not connected');
    return this.client;
  }

  // --- consumer groups (shared channels) ------------------------------------------------------------------------------------

  private async consumeGroup(conn: Redis, channel: string, group: string, options: ConsumeOptions, onEvent: ConsumeHandler): Promise<Subscription> {
    const client = this.client!;
    const key = this.key(channel);
    const me = this.consumerName;
    const claimIdleMs = this.config!.claimIdleMs ?? DEFAULT_CLAIM_IDLE_MS;
    const blockMs = this.config!.blockMs ?? DEFAULT_BLOCK_MS;
    const manual = options.ackMode === 'manual';
    await client.xgroup('CREATE', key, group, '0', 'MKSTREAM').catch((error: unknown) => {
      if (!isBusyGroup(error)) throw error;
    });
    const inFlight = new Map<string, true>();
    let closed = false;
    let wake: (() => void) | undefined;
    const slotFreed = () => {
      wake?.();
      wake = undefined;
    };
    // Keep the entries this consumer holds from looking idle to XAUTOCLAIM while their calls run.
    const keepAlive = setInterval(() => {
      if (inFlight.size === 0 || closed || client.status !== 'ready') return;
      void client.xclaim(key, group, me, 0, ...inFlight.keys(), 'JUSTID').catch(() => {});
    }, Math.max(1_000, Math.floor(claimIdleMs / 3)));
    keepAlive.unref?.();
    const park = (ids: string[]) => (ids.length === 0 ? Promise.resolve() : client.xclaim(key, group, ORPHANS_CONSUMER, 0, ...ids, 'IDLE', String(claimIdleMs), 'JUSTID').then(() => {}));
    const deliver = (id: string, fields: Buffer[], attempt: number) => {
      if (manual) inFlight.set(id, true);
      let settled = !manual;
      const settle = () => {
        if (settled) return false;
        settled = true;
        inFlight.delete(id);
        slotFreed();
        return true;
      };
      const delivery: Delivery = {
        attempt,
        ack: async () => {
          if (!settle()) return;
          await client.xack(key, group, id);
        },
        nack: async ({ requeue = false } = {}) => {
          if (!settle()) return;
          if (requeue && !closed) await park([id]);
          else await client.xack(key, group, id);
        },
      };
      if (!manual) void client.xack(key, group, id).catch(() => {});
      onEvent(fromFields(fields), delivery).catch(() => delivery.nack({ requeue: false }));
    };
    const attemptsOf = async (ids: string[]): Promise<Map<string, number>> => {
      const counts = new Map<string, number>();
      if (ids.length === 0) return counts;
      const pending = (await conn.xpending(key, group, ids[0], ids[ids.length - 1], ids.length + inFlight.size, me)) as unknown[];
      for (const row of pending) if (Array.isArray(row)) counts.set(String(row[0]), Number(row[3]));
      return counts;
    };
    const loop = async () => {
      while (!closed) {
        const free = options.prefetch - inFlight.size;
        if (free <= 0) {
          await new Promise<void>((resolve) => (wake = resolve));
          continue;
        }
        try {
          // 1. Entries whose consumer died (or parked them), oldest first.
          const claimed = (await conn.callBuffer('XAUTOCLAIM', key, group, me, String(claimIdleMs), '0-0', 'COUNT', String(free))) as [Buffer, Entry[], Buffer[]?];
          const entries = (claimed?.[1] ?? []).filter((entry): entry is [Buffer, Buffer[]] => Array.isArray(entry[1]));
          if (entries.length > 0) {
            const ids = entries.map(([id]) => id.toString());
            const attempts = await attemptsOf(ids);
            for (const [id, fields] of entries) deliver(id.toString(), fields, Math.max(2, attempts.get(id.toString()) ?? 2));
            continue;
          }
          // 2. New entries, blocking until one arrives.
          const reply = (await conn.callBuffer('XREADGROUP', 'GROUP', group, me, 'COUNT', String(free), 'BLOCK', String(blockMs), 'STREAMS', key, '>')) as ReadReply;
          for (const [id, fields] of reply?.[0]?.[1] ?? []) if (fields) deliver(id.toString(), fields, 1);
        } catch {
          if (!closed) await sleep(conn.status === 'ready' ? 100 : 500);
        }
      }
    };
    void loop();
    const subscription: Subscription = {
      channel,
      close: async () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        this.subscriptions.delete(subscription);
        slotFreed();
        conn.disconnect(); // interrupts the blocking read
        // As if this consumer had died, only sooner: what it holds becomes claimable now, then it leaves the group.
        const held = [...inFlight.keys()];
        inFlight.clear();
        if (client.status === 'ready') {
          await park(held).catch(() => {});
          await client.xgroup('DELCONSUMER', key, group, me).catch(() => {});
        }
      },
    };
    return subscription;
  }

  // --- broadcast channels ------------------------------------------------------------------------------------------------------

  private async consumeBroadcast(conn: Redis, channel: string, onEvent: ConsumeHandler): Promise<Subscription> {
    const key = this.key(channel);
    const blockMs = this.config!.blockMs ?? DEFAULT_BLOCK_MS;
    const last = (await this.client!.xrevrange(key, '+', '-', 'COUNT', 1)) as [string, string[]][];
    let lastId = last[0]?.[0] ?? '0-0';
    let closed = false;
    const noop: Delivery = { attempt: 1, ack: async () => {}, nack: async () => {} };
    const loop = async () => {
      while (!closed) {
        try {
          const reply = (await conn.callBuffer('XREAD', 'COUNT', '256', 'BLOCK', String(blockMs), 'STREAMS', key, lastId)) as ReadReply;
          for (const [id, fields] of reply?.[0]?.[1] ?? []) {
            lastId = id.toString();
            if (fields) onEvent(fromFields(fields), noop).catch(() => {});
          }
        } catch {
          if (!closed) await sleep(conn.status === 'ready' ? 100 : 500);
        }
      }
    };
    void loop();
    const subscription: Subscription = {
      channel,
      close: async () => {
        if (closed) return;
        closed = true;
        this.subscriptions.delete(subscription);
        conn.disconnect();
      },
    };
    return subscription;
  }
}

/** A new, unconnected Valkey driver. */
export const valkeyDriver = (): BrokerDriver<ValkeyConfig> => new ValkeyDriver();

const valkeyModule: DriverModule<ValkeyConfig> = {
  kind: 'valkey',
  label: 'Valkey / Redis Streams',
  capabilities: VALKEY_CAPABILITIES,
  exampleUrl: 'redis://127.0.0.1:56379/0',
  fields: [
    { name: 'keyPrefix', label: 'Key prefix', type: 'string', placeholder: 'landflow:', hint: 'Prepended to every stream key; leave empty unless the keyspace is shared.' },
    { name: 'db', label: 'Database', type: 'number', placeholder: '0', hint: 'The database index; the URL path (/0) sets it too.' },
  ],
  create: valkeyDriver,
  configFrom: valkeyConfigFrom,
};

export default valkeyModule;

export interface ValkeyTargetOptions extends Omit<ValkeyConfig, 'connectionId'> {
  /** Default `env-valkey`: the connection the host reads from `LANDFLOW_TRANSPORT_VALKEY_URL`. */
  connectionId?: string;
}

/** The SDK's broker target for Valkey Streams: `valkey({ url: 'redis://127.0.0.1:56379' })`. */
export function valkey(options: ValkeyTargetOptions): BrokerTarget<ValkeyConfig> {
  const { connectionId = 'env-valkey', ...rest } = options;
  if (!rest.url) throw new Error('valkey(): "url" is required');
  return { kind: 'valkey', config: { connectionId, ...rest }, driver: valkeyDriver };
}
