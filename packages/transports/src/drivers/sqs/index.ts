/**
 * `@landflow/transports/sqs`: the Amazon SQS driver (kind `sqs`; docs/protocol.md §14.9).
 *
 * - **Local only by default.** The connection names an explicit endpoint (`http://127.0.0.1:54566` for LocalStack) and
 *   static credentials (`test`/`test` when none are given); the AWS default endpoint and credential chain (`~/.aws`, the
 *   instance role) are used only with `allowAws: true` and no static credentials. Without an endpoint and without
 *   `allowAws`, `sqsConfigFrom()` refuses, so no test or misconfigured process can reach the real service by accident.
 * - A **shared** channel is one standard queue (`<queuePrefix><channel>` with `.` → `_`; names over 80 characters are
 *   shortened with a hash). Consumers long-poll it (`ReceiveMessage`, `MaxNumberOfMessages` = free prefetch slots, at
 *   most 10); a received message is invisible for `visibilityTimeoutSeconds` and in-flight deliveries extend their
 *   visibility (`ChangeMessageVisibilityBatch`) so a slow call is not redelivered. `ack()` = `DeleteMessage`,
 *   `nack({ requeue: true })` and a closing consumer = `ChangeMessageVisibility 0` (immediate redelivery), `attempt` =
 *   `ApproximateReceiveCount`. Standard queues, not FIFO: FIFO would give ordering keys (`MessageGroupId`) at the price
 *   of 300 messages/s per group, head-of-line blocking per group and `.fifo` names; the core keeps a run's calls in order
 *   on its own and `orderingKeys` is not claimed.
 * - **Broadcast** channels (reply, registry, control) have no fan-out in SQS: every consumer creates a queue of its own
 *   (`<queue>--bc-<consumerId>`, retention = the channel TTL, deleted on `close()`) and a publisher sends the event to
 *   every queue listed under that prefix (`ListQueues`, cached for `fanoutRefreshMs`). The reply channel therefore is
 *   "a reply queue per host"; SNS would fan out natively but adds a second service, a queue policy per queue and the
 *   same orphaned-queue problem after a crash, for channels that carry heartbeats and cancels.
 * - **Mode**: structured (`headers: false`). SQS allows 10 message attributes and the envelope has up to 19, so the core
 *   sends one JSON document and the driver carries two attributes: `content-type` and, when the body is not valid SQS
 *   text (any byte sequence outside `#x9 | #xA | #xD | #x20–#xD7FF | #xE000–#xFFFD | #x10000–#x10FFFF`), `lf-encoding:
 *   base64`. A structured event is always JSON text, so the base64 path is a fallback.
 * - **Size**: SQS accepts 1 MiB per message since 2025 (`MaximumMessageSize`, set on every queue the driver creates;
 *   the service default is still 256 KiB). No per-message TTL: queues get a retention period (`retentionSeconds`, the
 *   channel TTL for broadcast queues) and the core checks the deadline. `stats()` reports depth
 *   (`ApproximateNumberOfMessages`); SQS cannot count consumers, so `undeliverable` is `unknown`.
 *
 * The client is `@aws-sdk/client-sqs` (v3), imported lazily in `connect()`.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Message, SQSClient } from '@aws-sdk/client-sqs';
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
import { CHANNEL_VERSION } from '../../channels';

/** SQS's maximum message size (1 MiB since 2025; the per-queue default is still 256 KiB, so the driver sets the attribute). */
export const SQS_MAX_MESSAGE_BYTES = 1024 * 1024;
export const DEFAULT_REGION = 'us-east-1';
export const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 30;
export const DEFAULT_WAIT_TIME_SECONDS = 5;
export const DEFAULT_RETENTION_SECONDS = 3600;
export const DEFAULT_FANOUT_REFRESH_MS = 2_000;
/** The dummy credentials LocalStack accepts; used when an endpoint is set and no credentials are given. */
export const DUMMY_CREDENTIALS = { accessKeyId: 'test', secretAccessKey: 'test' } as const;
const QUEUE_NAME_MAX = 80;
const BROADCAST_INFIX = '--bc-';
const CONTENT_TYPE_ATTRIBUTE = 'content-type';
const ENCODING_ATTRIBUTE = 'lf-encoding';
const MIN_RETENTION_SECONDS = 60;

export interface SqsConfig extends BrokerConfig {
  /** The SQS endpoint, `http://127.0.0.1:54566` (LocalStack) or `https://sqs.<region>.amazonaws.com`. Absent only with `allowAws`. */
  endpoint?: string;
  region: string;
  /** Static credentials; `test`/`test` when absent and an endpoint is set. The default chain is used only with `allowAws` and no credentials. */
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** Opt in to the AWS default endpoint and credential chain. Never set in tests. */
  allowAws?: boolean;
  /** Prepended to every queue name (default none; channel names already start with the channel prefix). */
  queuePrefix?: string;
  /** Largest event accepted (default and maximum 1 MiB); also the `MaximumMessageSize` of queues the driver creates. */
  maxMessageBytes?: number;
  /** How long a received message stays invisible (default 30 s); in-flight deliveries extend it. Redelivery after a hard crash waits this long. */
  visibilityTimeoutSeconds?: number;
  /** `ReceiveMessage` long-poll wait (default 5 s, at most 20). A closing subscription waits for its poll in flight (aborting it would let the server hand the poll a message nobody tracks). */
  waitTimeSeconds?: number;
  /** `MessageRetentionPeriod` of request and instance queues (default 1 h; at least 60 s). Broadcast queues use the channel TTL. */
  retentionSeconds?: number;
  /** How long a publisher caches the list of a broadcast channel's consumer queues (default 2 s). */
  fanoutRefreshMs?: number;
}

export const SQS_CAPABILITIES: BrokerCapabilities = {
  replies: 'reply-channel',
  workSharing: true,
  buffering: true,
  ttl: false,
  undeliverable: 'unknown',
  persistence: 'disk',
  maxMessageBytes: SQS_MAX_MESSAGE_BYTES,
  latency: 'high',
  headers: false,
  orderingKeys: false,
  nack: true,
  attempts: true,
};

const truthy = (value: unknown) => value === true || value === 'true' || value === '1' || value === 1;
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/**
 * The config for a connection: `url` is the endpoint (`http://127.0.0.1:54566`, `https://sqs.eu-west-1.amazonaws.com`, or
 * `sqs://host:port`, which is plain HTTP unless `tls`); `sqs://aws` means the default AWS endpoint and needs `allowAws`.
 * Fields: `region` (also `?region=` on the URL; default `us-east-1`), `endpoint` (wins over the URL), `allowAws`,
 * `queuePrefix`, the numeric tunables; `username`/`password` are the access key id and secret access key.
 */
export function sqsConfigFrom(connectionId: string, url: string, options: ConnectionOptions = {}): SqsConfig {
  const raw = url.trim();
  let parsed: URL | undefined;
  if (raw) {
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`SQS URL "${url}" must be the endpoint, http://127.0.0.1:54566 (LocalStack) or https://sqs.<region>.amazonaws.com`);
    }
  }
  const scheme = parsed?.protocol.replace(/:$/, '');
  if (scheme && !['http', 'https', 'sqs'].includes(scheme)) throw new Error(`SQS URL "${url}" must use http://, https:// or sqs://`);
  const allowAws = truthy(options.allowAws);
  let endpoint = text(options.endpoint);
  if (!endpoint && parsed && parsed.hostname && !(scheme === 'sqs' && parsed.hostname === 'aws')) {
    if (scheme === 'sqs') endpoint = `${options.tls ? 'https' : 'http'}://${parsed.host}`;
    else endpoint = `${scheme}://${parsed.host}${parsed.pathname.replace(/\/$/, '')}`;
  }
  if (endpoint) {
    try {
      const check = new URL(endpoint);
      if (!['http:', 'https:'].includes(check.protocol) || !check.hostname) throw new Error('scheme');
    } catch {
      throw new Error(`SQS endpoint "${endpoint}" must be an http:// or https:// URL`);
    }
  } else if (!allowAws) {
    throw new Error('SQS needs an explicit endpoint (http://127.0.0.1:54566 for LocalStack): the default AWS endpoint is used only with allowAws');
  }
  const region = text(options.region) ?? text(parsed?.searchParams.get('region')) ?? (scheme === 'sqs' && parsed?.hostname === 'aws' && parsed.pathname.length > 1 ? parsed.pathname.slice(1) : undefined) ?? DEFAULT_REGION;
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new Error(`SQS region "${region}" must look like us-east-1`);
  const accessKeyId = text(options.username) ?? text(options.accessKeyId);
  const secretAccessKey = text(options.password) ?? text(options.secretAccessKey);
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) throw new Error('SQS credentials need both an access key id (username) and a secret access key (password)');
  const config: SqsConfig = {
    connectionId,
    region,
    ...(options.prefix && { prefix: options.prefix }),
    ...(endpoint && { endpoint }),
    ...(accessKeyId && secretAccessKey && { accessKeyId, secretAccessKey }),
    ...(text(options.sessionToken) && { sessionToken: text(options.sessionToken) }),
    ...(allowAws && { allowAws: true }),
  };
  if (text(options.queuePrefix)) config.queuePrefix = text(options.queuePrefix);
  for (const key of ['maxMessageBytes', 'visibilityTimeoutSeconds', 'waitTimeSeconds', 'retentionSeconds', 'fanoutRefreshMs'] as const) {
    const value = Number(options[key]);
    if (Number.isFinite(value) && value > 0) config[key] = value;
  }
  if (config.maxMessageBytes && config.maxMessageBytes > SQS_MAX_MESSAGE_BYTES) throw new Error(`SQS maxMessageBytes ${config.maxMessageBytes} is above the service limit of ${SQS_MAX_MESSAGE_BYTES}`);
  return config;
}

/** Shorten a queue name to `max` characters, keeping a readable head and a hash of the whole. */
function fit(name: string, max: number): string {
  if (name.length <= max) return name;
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 16);
  return `${name.slice(0, max - hash.length - 1)}-${hash}`;
}

/** The queue name of a channel: `[A-Za-z0-9_-]{1,80}` (`.` and other characters become `_`). */
export function queueNameOf(channel: string, queuePrefix = ''): string {
  return fit((queuePrefix + channel).replace(/[^A-Za-z0-9_-]/g, '_'), QUEUE_NAME_MAX);
}

/** The prefix shared by the per-consumer queues of a broadcast channel. */
export function broadcastPrefixOf(channel: string, queuePrefix = ''): string {
  return fit((queuePrefix + channel).replace(/[^A-Za-z0-9_-]/g, '_'), QUEUE_NAME_MAX - BROADCAST_INFIX.length - 10) + BROADCAST_INFIX;
}

/**
 * Whether a channel is a broadcast one, from its role in the name (`<prefix>.v1.reply…`, `.registry`, `.control…`): a
 * plugin publishes replies to a host's reply channel without ever declaring it, so the spec alone cannot tell.
 */
export function isBroadcastChannel(channel: string, spec?: ChannelSpec): boolean {
  if (spec) return spec.delivery === 'broadcast';
  const marker = `.${CHANNEL_VERSION}.`;
  const at = channel.indexOf(marker);
  if (at < 0) return false;
  const role = channel.slice(at + marker.length).split('.')[0];
  return role === 'reply' || role === 'registry' || role === 'control';
}

/** Whether text can travel as an SQS message body (XML 1.0 characters only). */
export function isSqsText(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code === 0x9 || code === 0xa || code === 0xd) continue;
    if (code < 0x20 || (code > 0xd7ff && code < 0xe000) || code === 0xfffe || code === 0xffff) return false;
  }
  return true;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** The SQS message for an event: the body as text when it is valid SQS text, else base64 with `lf-encoding: base64`. */
export function toSqsMessage(event: WireEvent): { body: string; attributes: Record<string, { DataType: 'String'; StringValue: string }> } {
  const attributes: Record<string, { DataType: 'String'; StringValue: string }> = {};
  const contentType = event.headers[CONTENT_TYPE_ATTRIBUTE] ?? event.headers['Content-Type'];
  if (contentType) attributes[CONTENT_TYPE_ATTRIBUTE] = { DataType: 'String', StringValue: contentType };
  if (event.body.byteLength === 0) {
    attributes[ENCODING_ATTRIBUTE] = { DataType: 'String', StringValue: 'empty' };
    return { body: '-', attributes };
  }
  let decoded: string | undefined;
  try {
    decoded = utf8.decode(event.body);
  } catch {
    decoded = undefined;
  }
  if (decoded !== undefined && isSqsText(decoded)) return { body: decoded, attributes };
  attributes[ENCODING_ATTRIBUTE] = { DataType: 'String', StringValue: 'base64' };
  return { body: Buffer.from(event.body.buffer, event.body.byteOffset, event.body.byteLength).toString('base64'), attributes };
}

/** The inverse of `toSqsMessage`. */
export function fromSqsMessage(message: Pick<Message, 'Body' | 'MessageAttributes'>): WireEvent {
  const headers: Record<string, string> = {};
  const contentType = message.MessageAttributes?.[CONTENT_TYPE_ATTRIBUTE]?.StringValue;
  if (contentType) headers[CONTENT_TYPE_ATTRIBUTE] = contentType;
  const encoding = message.MessageAttributes?.[ENCODING_ATTRIBUTE]?.StringValue;
  const raw = message.Body ?? '';
  const body = encoding === 'empty' ? new Uint8Array(0) : encoding === 'base64' ? new Uint8Array(Buffer.from(raw, 'base64')) : new TextEncoder().encode(raw);
  return { headers, body };
}

type Sqs = typeof import('@aws-sdk/client-sqs');
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const errorName = (error: unknown) => (error as { name?: string })?.name ?? '';
const isMissingQueue = (error: unknown) => /QueueDoesNotExist|NonExistentQueue/.test(errorName(error)) || /NonExistentQueue/.test((error as Error)?.message ?? '');
const chunk = <T>(items: T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

interface Fanout {
  at: number;
  urls: Set<string>;
}

export class SqsDriver implements BrokerDriver<SqsConfig> {
  readonly kind = 'sqs';
  readonly capabilities: BrokerCapabilities = { ...SQS_CAPABILITIES };
  private sqs?: Sqs;
  private client?: SQSClient;
  private config?: SqsConfig;
  private closing = false;
  private readonly specs = new Map<string, ChannelSpec>();
  /** Queue URL by channel (shared channels). */
  private readonly urls = new Map<string, string>();
  /** Per-consumer queues of broadcast channels this driver created, by channel. */
  private readonly localFanout = new Map<string, Set<string>>();
  private readonly fanout = new Map<string, Fanout>();
  private readonly subscriptions = new Set<Subscription>();
  /** Instance channels this driver declared: their queues die with the process (`close()` deletes them). */
  private readonly ownedInstances = new Set<string>();

  async connect(config: SqsConfig): Promise<void> {
    if (this.client) throw new Error('SQS driver is already connected');
    if (!config.endpoint && !config.allowAws) throw new Error('SQS needs an explicit endpoint (http://127.0.0.1:54566 for LocalStack) unless allowAws is set');
    if (!config.region) throw new Error('SQS needs a region');
    const sqs = await import('@aws-sdk/client-sqs');
    const credentials = config.accessKeyId && config.secretAccessKey
      ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, ...(config.sessionToken && { sessionToken: config.sessionToken }) }
      : config.allowAws ? undefined : { ...DUMMY_CREDENTIALS };
    const client = new sqs.SQSClient({ region: config.region, ...(config.endpoint && { endpoint: config.endpoint }), ...(credentials && { credentials }), maxAttempts: 3 });
    try {
      // One cheap call proves the endpoint answers and the credentials are accepted; nothing is created.
      await client.send(new sqs.ListQueuesCommand({ QueueNamePrefix: queueNameOf(config.prefix ?? 'landflow', config.queuePrefix), MaxResults: 1 }), { abortSignal: AbortSignal.timeout(10_000) });
    } catch (error) {
      client.destroy();
      throw new Error(`SQS at ${config.endpoint ?? `the AWS endpoint for ${config.region}`} is not reachable: ${(error as Error).message}`);
    }
    this.sqs = sqs;
    this.client = client;
    this.config = config;
    this.capabilities.maxMessageBytes = Math.min(config.maxMessageBytes ?? SQS_MAX_MESSAGE_BYTES, SQS_MAX_MESSAGE_BYTES);
  }

  async declare(channels: ChannelSpec[]): Promise<void> {
    this.ensureReady();
    for (const spec of channels) {
      this.specs.set(spec.name, spec);
      if (spec.delivery === 'shared') await this.ensureQueue(spec.name);
      if (spec.role === 'instance') this.ownedInstances.add(spec.name);
    }
  }

  async publish(channel: string, event: WireEvent, _options?: PublishOptions): Promise<PublishOutcome> {
    const { client, sqs } = this.ensureReady();
    const { body, attributes } = toSqsMessage(event);
    if (isBroadcastChannel(channel, this.specs.get(channel))) {
      const urls = await this.fanoutUrls(channel);
      await Promise.all(
        [...urls].map((url) =>
          client.send(new sqs.SendMessageCommand({ QueueUrl: url, MessageBody: body, MessageAttributes: attributes })).catch((error: unknown) => {
            if (!isMissingQueue(error)) throw error;
            this.fanout.get(channel)?.urls.delete(url); // that consumer is gone
          }),
        ),
      );
      return 'accepted';
    }
    const url = await this.ensureQueue(channel);
    await client.send(new sqs.SendMessageCommand({ QueueUrl: url, MessageBody: body, MessageAttributes: attributes }));
    return 'accepted';
  }

  async consume(channel: string, options: ConsumeOptions, onEvent: ConsumeHandler): Promise<Subscription> {
    this.ensureReady();
    const subscription = options.group ? await this.consumeShared(channel, options, onEvent) : await this.consumeBroadcast(channel, options, onEvent);
    this.subscriptions.add(subscription);
    return subscription;
  }

  async stats(channel: string): Promise<ChannelStats> {
    const { client, sqs } = this.ensureReady();
    const url = this.urls.get(channel) ?? (await this.queueUrl(queueNameOf(channel, this.config!.queuePrefix)).catch(() => undefined));
    if (!url) return { depth: 0 };
    try {
      const reply = await client.send(new sqs.GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages'] }));
      const depth = Number(reply.Attributes?.ApproximateNumberOfMessages);
      return { depth: Number.isFinite(depth) ? depth : 0 };
    } catch (error) {
      if (isMissingQueue(error)) return { depth: 0 };
      throw error;
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    if (!client || this.closing) return;
    this.closing = true;
    await Promise.allSettled([...this.subscriptions].map((s) => s.close()));
    this.subscriptions.clear();
    // Instance queues belong to this process: nobody else will ever consume them.
    for (const channel of this.ownedInstances) {
      const url = this.urls.get(channel);
      if (url) await client.send(new this.sqs!.DeleteQueueCommand({ QueueUrl: url })).catch(() => {});
    }
    this.client = undefined;
    client.destroy();
  }

  /** Delete the queues of channels (tests and operators): the shared queue and every per-consumer broadcast queue. */
  async deleteQueues(...channels: string[]): Promise<void> {
    const { client, sqs } = this.ensureReady();
    for (const channel of channels) {
      const names = new Set<string>([queueNameOf(channel, this.config!.queuePrefix)]);
      const listed = await client.send(new sqs.ListQueuesCommand({ QueueNamePrefix: broadcastPrefixOf(channel, this.config!.queuePrefix) }));
      for (const url of listed.QueueUrls ?? []) names.add(url.slice(url.lastIndexOf('/') + 1));
      for (const name of names) {
        const url = await this.queueUrl(name).catch(() => undefined);
        if (url) await client.send(new sqs.DeleteQueueCommand({ QueueUrl: url })).catch(() => {});
      }
      this.urls.delete(channel);
      this.fanout.delete(channel);
    }
  }

  private ensureReady(): { client: SQSClient; sqs: Sqs } {
    if (!this.client || !this.sqs || this.closing) throw new NotConnectedError('sqs driver is not connected');
    return { client: this.client, sqs: this.sqs };
  }

  /** Queue URLs are rewritten onto the configured endpoint: LocalStack returns `sqs.<region>.localhost`, which does not resolve. */
  private rewrite(url: string): string {
    const endpoint = this.config?.endpoint;
    if (!endpoint) return url;
    try {
      const base = new URL(endpoint);
      const parsed = new URL(url);
      return `${base.origin}${base.pathname.replace(/\/$/, '')}${parsed.pathname}`;
    } catch {
      return url;
    }
  }

  private async queueUrl(name: string): Promise<string> {
    const { client, sqs } = this.ensureReady();
    const reply = await client.send(new sqs.GetQueueUrlCommand({ QueueName: name }));
    return this.rewrite(reply.QueueUrl!);
  }

  private async createQueue(name: string, attributes: Record<string, string>): Promise<string> {
    const { client, sqs } = this.ensureReady();
    try {
      const reply = await client.send(new sqs.CreateQueueCommand({ QueueName: name, Attributes: attributes }));
      return this.rewrite(reply.QueueUrl!);
    } catch (error) {
      if (errorName(error) === 'QueueNameExists' || errorName(error) === 'QueueAlreadyExists') return this.queueUrl(name); // same name, other attributes: use it as is
      throw error;
    }
  }

  private queueAttributes(ttlMs?: number, visibility?: number): Record<string, string> {
    const config = this.config!;
    const retention = ttlMs ? Math.ceil(ttlMs / 1000) : (config.retentionSeconds ?? DEFAULT_RETENTION_SECONDS);
    return {
      MaximumMessageSize: String(this.capabilities.maxMessageBytes),
      MessageRetentionPeriod: String(Math.min(14 * 86_400, Math.max(MIN_RETENTION_SECONDS, retention))),
      VisibilityTimeout: String(visibility ?? config.visibilityTimeoutSeconds ?? DEFAULT_VISIBILITY_TIMEOUT_SECONDS),
    };
  }

  /** The URL of a shared channel's queue, creating the queue on first use. */
  private async ensureQueue(channel: string): Promise<string> {
    const cached = this.urls.get(channel);
    if (cached) return cached;
    const url = await this.createQueue(queueNameOf(channel, this.config!.queuePrefix), this.queueAttributes(this.specs.get(channel)?.ttlMs));
    this.urls.set(channel, url);
    return url;
  }

  /** Every per-consumer queue of a broadcast channel: this driver's own at once, the others as listed (cached). */
  private async fanoutUrls(channel: string): Promise<Set<string>> {
    const { client, sqs } = this.ensureReady();
    const refresh = this.config!.fanoutRefreshMs ?? DEFAULT_FANOUT_REFRESH_MS;
    let entry = this.fanout.get(channel);
    if (!entry || Date.now() - entry.at > refresh) {
      const urls = new Set<string>();
      let token: string | undefined;
      do {
        const listed = await client.send(new sqs.ListQueuesCommand({ QueueNamePrefix: broadcastPrefixOf(channel, this.config!.queuePrefix), MaxResults: 1000, NextToken: token }));
        for (const url of listed.QueueUrls ?? []) urls.add(this.rewrite(url));
        token = listed.NextToken;
      } while (token);
      entry = { at: Date.now(), urls };
      this.fanout.set(channel, entry);
    }
    const all = new Set(entry.urls);
    for (const url of this.localFanout.get(channel) ?? []) all.add(url);
    return all;
  }

  // --- shared channels ---------------------------------------------------------------------------------------------------------

  private async consumeShared(channel: string, options: ConsumeOptions, onEvent: ConsumeHandler): Promise<Subscription> {
    const url = await this.ensureQueue(channel);
    return this.poll(channel, url, options, onEvent, undefined);
  }

  // --- broadcast channels ------------------------------------------------------------------------------------------------------

  private async consumeBroadcast(channel: string, options: ConsumeOptions, onEvent: ConsumeHandler): Promise<Subscription> {
    const name = broadcastPrefixOf(channel, this.config!.queuePrefix) + randomBytes(5).toString('hex');
    const url = await this.createQueue(name, this.queueAttributes(this.specs.get(channel)?.ttlMs ?? 60_000, 5));
    let local = this.localFanout.get(channel);
    if (!local) this.localFanout.set(channel, (local = new Set()));
    local.add(url);
    return this.poll(channel, url, { ...options, ackMode: 'auto' }, onEvent, async () => {
      local.delete(url);
      const { client, sqs } = this.ensureReady();
      await client.send(new sqs.DeleteQueueCommand({ QueueUrl: url })).catch(() => {});
    });
  }

  // --- the receive loop ------------------------------------------------------------------------------------------------------------

  private poll(channel: string, url: string, options: ConsumeOptions, onEvent: ConsumeHandler, onClose: (() => Promise<void>) | undefined): Subscription {
    const { client, sqs } = this.ensureReady();
    const config = this.config!;
    const manual = options.ackMode === 'manual';
    const visibility = config.visibilityTimeoutSeconds ?? DEFAULT_VISIBILITY_TIMEOUT_SECONDS;
    const waitSeconds = Math.min(20, Math.max(0, Math.floor(config.waitTimeSeconds ?? DEFAULT_WAIT_TIME_SECONDS)));
    const prefetch = Math.max(1, options.prefetch);
    /** Receipt handles this consumer holds unacknowledged, by message id. */
    const inFlight = new Map<string, string>();
    let closed = false;
    let wake: (() => void) | undefined;
    let extending: Promise<void> = Promise.resolve();
    const slotFreed = () => {
      wake?.();
      wake = undefined;
    };
    const extend = async (handles: string[], seconds: number) => {
      for (const group of chunk(handles, 10)) {
        await client
          .send(new sqs.ChangeMessageVisibilityBatchCommand({ QueueUrl: url, Entries: group.map((handle, i) => ({ Id: String(i), ReceiptHandle: handle, VisibilityTimeout: seconds })) }))
          .catch(() => {});
      }
    };
    const keepAlive = manual
      ? setInterval(() => {
          if (inFlight.size === 0 || closed) return;
          extending = extend([...inFlight.values()], visibility);
        }, Math.max(1_000, Math.floor((visibility * 1000) / 3)))
      : undefined;
    keepAlive?.unref?.();
    const deliver = (message: Message) => {
      const id = message.MessageId ?? randomBytes(8).toString('hex');
      const handle = message.ReceiptHandle!;
      const count = Number(message.Attributes?.ApproximateReceiveCount);
      const attempt = Number.isFinite(count) && count > 0 ? count : 1;
      if (manual) inFlight.set(id, handle);
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
          await client.send(new sqs.DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: handle })).catch(() => {});
        },
        nack: async ({ requeue = false } = {}) => {
          if (!settle()) return;
          if (requeue && !closed) await client.send(new sqs.ChangeMessageVisibilityCommand({ QueueUrl: url, ReceiptHandle: handle, VisibilityTimeout: 0 })).catch(() => {});
          else await client.send(new sqs.DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: handle })).catch(() => {});
        },
      };
      onEvent(fromSqsMessage(message), delivery).catch(() => delivery.nack({ requeue: false }));
    };
    const release = (messages: Message[]) => extend(messages.map((m) => m.ReceiptHandle!), 0);
    const loop = async () => {
      while (!closed) {
        const free = manual ? prefetch - inFlight.size : prefetch;
        if (free <= 0) {
          await new Promise<void>((resolve) => (wake = resolve));
          continue;
        }
        try {
          const reply = await client.send(
            new sqs.ReceiveMessageCommand({
              QueueUrl: url,
              MaxNumberOfMessages: Math.min(10, free),
              WaitTimeSeconds: waitSeconds,
              VisibilityTimeout: visibility,
              MessageAttributeNames: ['All'],
              MessageSystemAttributeNames: ['ApproximateReceiveCount'],
            }),
          );
          const messages = reply.Messages ?? [];
          if (messages.length === 0) continue;
          if (closed) {
            // Received while closing: give them back at once rather than after the visibility timeout.
            if (manual) await release(messages);
            continue;
          }
          if (!manual) {
            // Auto ack: the broker forgets the messages before the handler sees them.
            for (const group of chunk(messages, 10)) {
              await client
                .send(new sqs.DeleteMessageBatchCommand({ QueueUrl: url, Entries: group.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle! })) }))
                .catch(() => {});
            }
          }
          for (const message of messages) deliver(message);
        } catch (error) {
          if (closed) continue;
          if (isMissingQueue(error)) return; // the queue was deleted under us: nothing more will arrive
          await sleep(500);
        }
      }
    };
    const done = loop();
    const subscription: Subscription = {
      channel,
      close: async () => {
        if (closed) return;
        closed = true;
        if (keepAlive) clearInterval(keepAlive);
        this.subscriptions.delete(subscription);
        slotFreed();
        await done; // the poll in flight ends first (at most waitTimeSeconds), so it cannot grab what is released below
        await extending; // nor can a keep-alive re-hide it
        // As if this consumer had died, only sooner: what it holds becomes visible to another consumer now.
        const held = [...inFlight.values()];
        inFlight.clear();
        if (held.length > 0) await extend(held, 0);
        await onClose?.().catch(() => {});
      },
    };
    return subscription;
  }
}

/** A new, unconnected SQS driver. */
export const sqsDriver = (): BrokerDriver<SqsConfig> => new SqsDriver();

const sqsModule: DriverModule<SqsConfig> = {
  kind: 'sqs',
  label: 'Amazon SQS',
  capabilities: SQS_CAPABILITIES,
  exampleUrl: 'http://127.0.0.1:54566',
  fields: [
    { name: 'region', label: 'Region', type: 'string', placeholder: DEFAULT_REGION, hint: 'The AWS region the queues live in (default us-east-1).' },
    { name: 'endpoint', label: 'Endpoint', type: 'string', placeholder: 'http://127.0.0.1:54566', hint: 'The SQS endpoint; wins over the URL. Required unless "Allow AWS" is on. LocalStack: http://127.0.0.1:54566.' },
    { name: 'allowAws', label: 'Allow AWS', type: 'boolean', hint: 'Use the real AWS endpoint and credential chain when no endpoint is set. Off by default; never on in tests.' },
    { name: 'queuePrefix', label: 'Queue prefix', type: 'string', placeholder: 'landflow-', hint: 'Prepended to every queue name; leave empty unless the account’s queues are shared.' },
  ],
  create: sqsDriver,
  configFrom: sqsConfigFrom,
};

export default sqsModule;

export interface SqsTargetOptions extends Omit<SqsConfig, 'connectionId' | 'region'> {
  /** Default `env-sqs`: the connection the host reads from `LANDFLOW_TRANSPORT_SQS_URL`. */
  connectionId?: string;
  /** Default `us-east-1`. */
  region?: string;
}

/** The SDK's broker target for SQS: `sqs({ endpoint: 'http://127.0.0.1:54566' })` (credentials `test`/`test` by default). */
export function sqs(options: SqsTargetOptions): BrokerTarget<SqsConfig> {
  const { connectionId = 'env-sqs', region = DEFAULT_REGION, ...rest } = options;
  if (!rest.endpoint && !rest.allowAws) throw new Error('sqs(): "endpoint" is required (http://127.0.0.1:54566 for LocalStack) unless allowAws is set');
  return { kind: 'sqs', config: { connectionId, region, ...rest }, driver: sqsDriver };
}
