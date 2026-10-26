/**
 * Messaging binding: a plugin's face on a message broker (docs/transports.md "Generic messaging", docs/protocol.md §14).
 * One `TransportBinding` per broker wraps `@landflow/transports`' `MessagingServer` (the envelope, signing and
 * encryption, delivery modes, deadlines, cancel, announce over the broker) around the SDK dispatcher, so the node code
 * sees the same deadline, signal, spans and concurrency limit as over HTTP or gRPC.
 *
 *   import { kafka } from '@landflow/transports/kafka';
 *   await serve(plugin, { http: 7101, brokers: [kafka({ brokers: ['127.0.0.1:59092'] })] });
 *
 * or without code: `LANDFLOW_TRANSPORTS=http,kafka LANDFLOW_KAFKA_URL=kafka://127.0.0.1:59092` (plus
 * `LANDFLOW_KAFKA_USERNAME`, `LANDFLOW_KAFKA_PASSWORD`, `LANDFLOW_KAFKA_TLS=true`, `LANDFLOW_KAFKA_PREFIX` when the broker
 * needs them), which loads the driver module for the kind (`loadDriverModule`) and builds the connection `env-<kind>`,
 * the id the host gives the connection it reads from `LANDFLOW_TRANSPORT_<KIND>_URL`.
 *
 * The binding never imports a driver: it takes any `BrokerTarget` (`kind`, `driver()`, `config`). Messaging needs the
 * shared secret (`LANDFLOW_TRANSPORT_SECRET`, else `LANDFLOW_REGISTRY_SECRET`): `Keyring.fromEnv()` fails with a clear
 * message without it. The brokered endpoint (`<kind>://env-<kind>/<pluginId>`) is announced over the broker's registry
 * channel, not through the HTTP announce: the host names its own connections (§14.8), so `start()` returns no endpoints.
 */
import { executeRequestSchema, webhookMethodRequestSchema, webhookRequestSchema, type ExecuteRequest, type JsonObject, type JsonValue } from '@landflow/protocol';
import {
  channelNames,
  DispatchError as MessagingDispatchError,
  idempotencyFromManifest,
  Keyring,
  MessagingServer,
  type DispatchContext,
  type Dispatcher as MessagingDispatcher,
  type Logger as MessagingLogger,
  type Method,
  type RemoteErrorCode,
} from '@landflow/transports';
import type { BrokerKind } from '@landflow/transports/driver';
import { loadDriverModule, type BrokerTarget, type ConnectionOptions } from '@landflow/transports/drivers';
import { INSTANCE_ID } from './announce';
import type { BindingContext, BindingInfo, TransportBinding } from './binding';
import { DispatchError, type DispatchCall, type Dispatcher } from './dispatcher';
import type { ProcessLogger } from './logger';
import { contextFromHeaders, type Telemetry } from './otel';
import { toErrorPayload } from './runtime';

/** Broker kinds `serve()` reads from `LANDFLOW_TRANSPORTS` and `LANDFLOW_<KIND>_URL` (an open list: any kind with a driver module works). */
export const BROKER_KINDS: readonly string[] = ['kafka', 'amqp', 'nats', 'valkey', 'mqtt', 'sqs', 'pubsub', 'servicebus', 'amqp1', 'pulsar'];

/** `LANDFLOW_<KIND>_URL` for a kind (`kafka` → `LANDFLOW_KAFKA_URL`). */
export const brokerUrlEnv = (kind: string): string => `LANDFLOW_${kind.toUpperCase()}_URL`;

export interface MessagingBindingOptions {
  /** Default: `Keyring.fromEnv()` when the binding starts (throws `MissingSecretError` without a secret). */
  keyring?: Keyring;
  /** Default `LANDFLOW_REGISTRY_SECRET` (the announce's registry proof); `null` announces without a proof. */
  registrySecret?: string | null;
  /** How long `stop()` waits for the calls in flight (default 30 s). */
  drainTimeoutMs?: number;
  announceIntervalMs?: number;
  ttlSeconds?: number;
  /** Sees every dispatched call (its delivery mode, attempt, deadline); for tests and the conformance runner. */
  observe?: (method: Method, context: DispatchContext) => void;
}

/** The `lferror` code for a refused or stopped dispatcher call (docs/protocol.md §14.6). */
export function remoteErrorCode(error: DispatchError): RemoteErrorCode {
  switch (error.code) {
    case 'unknown_node':
    case 'unknown_credential_type':
      return 'not_found';
    case 'deadline_exceeded':
      return 'expired';
    case 'canceled':
      return 'cancelled';
    case 'capacity':
      return 'capacity';
  }
}

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

/** OpenTelemetry messaging attributes for the server span of a brokered call. */
function messagingAttributes(kind: string, channel: string, context: DispatchContext): DispatchCall['attributes'] {
  return {
    'messaging.system': kind,
    'messaging.destination.name': channel,
    'messaging.operation.type': 'process',
    'messaging.message.id': context.callId,
    'landflow.delivery.mode': context.delivery,
    'landflow.delivery.attempt': context.attempt,
  };
}

/**
 * The `MessagingServer` dispatcher over the SDK dispatcher: the method's JSON body in (validated like the HTTP binding),
 * the response body out; `DispatchContext` (deadline, signal, attempt, delivery, trace context) becomes a `DispatchCall`
 * and a refused call becomes the matching `lferror` code (`not_found`, `expired`, `cancelled`, `unavailable`,
 * `bad_request` for a body that does not validate).
 */
export function messagingDispatcher(dispatcher: Dispatcher, options: { kind: string; channel: string; telemetry: Telemetry; observe?: MessagingBindingOptions['observe'] }): MessagingDispatcher {
  const call = (context: DispatchContext): DispatchCall => {
    const headers = new Headers();
    if (context.traceparent) headers.set('traceparent', context.traceparent);
    if (context.tracestate) headers.set('tracestate', context.tracestate);
    return {
      transport: options.kind,
      signal: context.signal,
      parent: contextFromHeaders(options.telemetry, headers),
      attributes: messagingAttributes(options.kind, options.channel, context),
      ...(context.deadline !== undefined && { deadline: context.deadline }),
      // The messaging server already holds at most its prefetch (`maxConcurrency`); the rest waits in the broker.
      wait: true,
    };
  };
  const bad = (what: string, issues?: unknown) => new MessagingDispatchError(`Invalid ${what}`, 'bad_request', issues ? { issues: issues as JsonValue } : undefined);

  return async (method, body, context) => {
    options.observe?.(method, context);
    try {
      switch (method) {
        case 'GetManifest':
          return dispatcher.manifest as unknown as JsonValue;
        case 'Health':
          return dispatcher.health() as unknown as JsonValue;
        case 'Execute': {
          const parsed = executeRequestSchema.safeParse(body);
          if (!parsed.success) throw bad('ExecuteRequest', parsed.error.issues);
          return (await dispatcher.execute(parsed.data as unknown as ExecuteRequest, call(context))) as unknown as JsonValue;
        }
        case 'LoadOptions': {
          const request = isObject(body) ? body : {};
          if (typeof request.nodeType !== 'string' || typeof request.method !== 'string') throw bad('LoadOptionsRequest: nodeType and method are required');
          try {
            const loaded = await dispatcher.loadOptions(
              {
                nodeType: request.nodeType,
                method: request.method,
                parameters: isObject(request.parameters) ? request.parameters : {},
                ...(isObject(request.credentials) && { credentials: request.credentials as Record<string, JsonObject> }),
              },
              call(context),
            );
            return { options: loaded } as unknown as JsonValue;
          } catch (error) {
            if (error instanceof DispatchError) throw error;
            // The HTTP binding answers 400 with the node's message; the same code here.
            throw new MessagingDispatchError(toErrorPayload(error).message, 'bad_request');
          }
        }
        case 'TestCredentials': {
          const request = isObject(body) ? body : {};
          if (typeof request.credentialType !== 'string') throw bad('TestCredentialsRequest: credentialType is required');
          const data = isObject(request.data) ? request.data : {};
          return (await dispatcher.testCredentials({ credentialType: request.credentialType, data }, call(context))) as unknown as JsonValue;
        }
        case 'WebhookMethod': {
          const parsed = webhookMethodRequestSchema.safeParse(body);
          if (!parsed.success) throw bad('WebhookMethodRequest', parsed.error.issues);
          return (await dispatcher.webhookMethod(parsed.data as never, call(context))) as unknown as JsonValue;
        }
        case 'ReceiveWebhook': {
          const parsed = webhookRequestSchema.safeParse(body);
          if (!parsed.success) throw bad('WebhookRequest', parsed.error.issues);
          return (await dispatcher.webhook(parsed.data as never, call(context))) as unknown as JsonValue;
        }
      }
    } catch (error) {
      if (error instanceof DispatchError) throw new MessagingDispatchError(error.message, remoteErrorCode(error));
      throw error;
    }
    throw new MessagingDispatchError(`Unknown method "${String(method)}"`, 'not_found');
  };
}

/** The transports core's logger over the binding's process logger. */
const messagingLogger =
  (logger: ProcessLogger): MessagingLogger =>
  (level, message, fields) =>
    logger[level](message, fields as Record<string, unknown>);

/**
 * The messaging face for one broker as a `TransportBinding`; `serve()` builds one per entry of `brokers` (and per broker
 * kind named in `LANDFLOW_TRANSPORTS` with a `LANDFLOW_<KIND>_URL`). `kind` is the broker kind; `server` is the running
 * `MessagingServer` while started (its counters, instance id, channel names).
 */
export interface MessagingBinding extends TransportBinding {
  readonly target: BrokerTarget;
  readonly server: MessagingServer | undefined;
}

export function messagingBinding(target: BrokerTarget, options: MessagingBindingOptions = {}): MessagingBinding {
  let server: MessagingServer | undefined;
  let dispatcher: Dispatcher | undefined;
  return {
    kind: target.kind,
    target,
    get server() {
      return server;
    },
    async start(context: BindingContext): Promise<BindingInfo> {
      dispatcher = context.dispatcher;
      const keyring = options.keyring ?? Keyring.fromEnv();
      const { plugin, manifest } = context;
      const channel = channelNames(target.config.prefix).request(plugin.info.id);
      server = new MessagingServer({
        driver: target.driver(),
        config: target.config,
        keyring,
        pluginId: plugin.info.id,
        version: plugin.info.version,
        manifest,
        dispatch: messagingDispatcher(dispatcher, { kind: target.kind, channel, telemetry: context.telemetry, observe: options.observe }),
        isIdempotent: idempotencyFromManifest(manifest),
        maxConcurrency: dispatcher.maxConcurrency ?? manifest.maxConcurrency,
        instanceId: INSTANCE_ID,
        registrySecret: options.registrySecret,
        drainTimeoutMs: options.drainTimeoutMs,
        announceIntervalMs: options.announceIntervalMs,
        ttlSeconds: options.ttlSeconds,
        log: messagingLogger(context.logger),
      });
      try {
        await server.start();
      } catch (error) {
        server = undefined;
        throw error;
      }
      // The endpoint is announced over the broker's registry channel (§14.8); the host names the connection itself.
      return { endpoints: [], description: `${target.kind} connected (${server.endpoint}, consuming ${server.names.request(plugin.info.id)})` };
    },
    async stop() {
      const running = server;
      server = undefined;
      if (!running) return;
      // Withdraw, stop taking calls, wait for the calls in flight, close the driver; then let the dispatcher settle too.
      await running.stop();
      await dispatcher?.drain();
    },
  };
}

/**
 * A `BrokerTarget` from the environment for one kind: `LANDFLOW_<KIND>_URL` (required), `LANDFLOW_<KIND>_USERNAME`,
 * `LANDFLOW_<KIND>_PASSWORD`, `LANDFLOW_<KIND>_TLS` (`true`/`1`) and `LANDFLOW_<KIND>_PREFIX` (channel prefix). The driver
 * module for the kind is loaded on first use; its `configFrom('env-<kind>', url, options)` validates the URL. Returns
 * `undefined` when the URL is not set; throws when this build has no driver for the kind or the URL is malformed.
 */
export async function brokerTargetFromEnv(kind: string, env: Record<string, string | undefined> = process.env): Promise<BrokerTarget | undefined> {
  const upper = kind.toUpperCase();
  const url = env[brokerUrlEnv(kind)];
  if (!url) return undefined;
  const module = await loadDriverModule(kind as BrokerKind);
  if (!module) throw new Error(`serve(): no driver for "${kind}" in this build of @landflow/transports (set ${brokerUrlEnv(kind)} only for kinds with a driver)`);
  const flag = env[`LANDFLOW_${upper}_TLS`];
  const options: ConnectionOptions = {
    ...(env[`LANDFLOW_${upper}_USERNAME`] && { username: env[`LANDFLOW_${upper}_USERNAME`] }),
    ...(env[`LANDFLOW_${upper}_PASSWORD`] && { password: env[`LANDFLOW_${upper}_PASSWORD`] }),
    ...(flag !== undefined && { tls: flag === 'true' || flag === '1' }),
    ...(env[`LANDFLOW_${upper}_PREFIX`] && { prefix: env[`LANDFLOW_${upper}_PREFIX`] }),
  };
  // The driver's own fields as `LANDFLOW_<KIND>_<FIELD>` (upper-cased: `LANDFLOW_SQS_REGION`, `LANDFLOW_PUBSUB_PROJECTID`), as the Go SDK reads them.
  for (const field of module.fields ?? []) {
    const value = env[`LANDFLOW_${upper}_${field.name.toUpperCase()}`];
    if (value !== undefined && value !== '') options[field.name] = field.type === 'boolean' ? value === 'true' || value === '1' : value;
  }
  const config = module.configFrom(`env-${kind}`, url, options);
  return { kind: module.kind, driver: () => module.create(), config };
}
