/**
 * Transport clients for remote plugins. Both speak the same logical protocol;
 * callers never care which one is behind an endpoint.
 *
 * Execute, LoadOptions, TestCredentials, GetManifest, WebhookMethod and
 * ReceiveWebhook each run in a `plugin.rpc {Method}` client span whose W3C trace context travels as HTTP
 * headers or gRPC metadata, so the plugin's spans join the workflow's trace.
 * Health probes and discovery stay untraced.
 */
import {
  HTTP_PATHS,
  parseManifest,
  type ExecuteRequest,
  type ExecuteResponse,
  type HealthResponse,
  type LoadOptionsRequest,
  type PluginManifest,
  type PropertyOption,
  type TestCredentialsRequest,
  type TestCredentialsResponse,
  type WebhookMethodRequest,
  type WebhookMethodResponse,
  type WebhookRequest,
  type WebhookResponse,
  transportKindOf,
  type WellKnownDocument,
} from '@landflow/protocol';
import {
  executeRequestToMsg,
  executeResponseFromMsg,
  grpc,
  healthFromMsg,
  loadLandflowProto,
  loadOptionsRequestToMsg,
  manifestFromMsg,
  optionsFromMsg,
  testCredentialsRequestToMsg,
  testCredentialsResponseFromMsg,
  unary,
  webhookMethodRequestToMsg,
  webhookMethodResponseFromMsg,
  webhookRequestToMsg,
  webhookResponseFromMsg,
  type ExecuteResponseMsg,
  type ManifestMsg,
  type ReceiveWebhookResponseMsg,
  type WebhookMethodResponseMsg,
} from '@landflow/protocol/grpc';
import type { Transport } from '@landflow/engine';
import { REGISTRY_CHALLENGE_HEADER, REGISTRY_PROOF_HEADER } from '@landflow/sdk';
import { tracePluginRpc, type RpcMethod } from '../telemetry';

export const EXECUTE_TIMEOUT_MS = Number(process.env.LANDFLOW_EXECUTE_TIMEOUT_MS ?? 120_000);

export interface PluginClient {
  readonly endpoint: string;
  readonly transport: Exclude<Transport, 'in-process'>;
  /** Learned from the first manifest; labels the RPC spans and metrics. */
  pluginId?: string;
  manifest(): Promise<PluginManifest>;
  /** GetManifest with a registry challenge (Kubernetes discovery, docs/protocol.md §13): the manifest and the plugin's proof, if it sent one. */
  manifestWithProof?(challenge: string): Promise<{ manifest: PluginManifest; proof?: string }>;
  execute(request: ExecuteRequest, signal?: AbortSignal): Promise<ExecuteResponse>;
  /** `request.credentials` is forwarded, for option lists that call an API. */
  loadOptions(request: LoadOptionsRequest): Promise<PropertyOption[]>;
  /** "Test connection" for a credential type the plugin declares `testable`. */
  testCredentials(request: TestCredentialsRequest): Promise<TestCredentialsResponse>;
  /** App webhook triggers (docs/protocol.md §12): checkExists / create / delete of a node's webhook at its service. */
  webhookMethod(request: WebhookMethodRequest): Promise<WebhookMethodResponse>;
  /** App webhook triggers: hand one incoming call to the node. */
  receiveWebhook(request: WebhookRequest): Promise<WebhookResponse>;
  health(timeoutMs?: number): Promise<HealthResponse>;
  close(): void;
}

function validated(raw: unknown, endpoint: string): PluginManifest {
  const parsed = parseManifest(raw);
  if (!parsed.ok) throw new Error(`Invalid manifest from ${endpoint}: ${parsed.error}`);
  return parsed.manifest;
}

abstract class TracedClient {
  pluginId?: string;
  abstract readonly endpoint: string;
  abstract readonly transport: 'http' | 'grpc';

  protected traced<T>(method: RpcMethod, call: (traceContext: Record<string, string>) => Promise<T>): Promise<T> {
    return tracePluginRpc(method, { system: this.transport, endpoint: this.endpoint, pluginId: this.pluginId }, call, () => this.pluginId);
  }

  protected learn(manifest: PluginManifest): PluginManifest {
    this.pluginId = manifest.plugin.id;
    return manifest;
  }
}

export class HttpPluginClient extends TracedClient implements PluginClient {
  readonly transport = 'http' as const;
  constructor(readonly endpoint: string) {
    super();
  }

  private async request<T>(path: string, init: RequestInit & { timeoutMs?: number; onResponse?: (response: Response) => void } = {}): Promise<T> {
    const timeout = AbortSignal.timeout(init.timeoutMs ?? 10_000);
    const { onResponse, ...rest } = init;
    const response = await fetch(new URL(path, this.endpoint), {
      ...rest,
      headers: { 'content-type': 'application/json', ...init.headers },
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
    onResponse?.(response);
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {}
      // The status and Retry-After ride on the error: a 429 is a `capacity` refusal the selector moves once and holds the endpoint for (transports/auto.ts).
      const retryAfter = response.headers.get('retry-after');
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      throw Object.assign(new Error(`${response.status} from ${this.endpoint}${path}: ${message}`), {
        status: response.status,
        ...(Number.isFinite(seconds) && { retryAfterMs: Math.max(0, seconds * 1000) }),
      });
    }
    return JSON.parse(text) as T;
  }

  wellKnown(timeoutMs = 800) {
    return this.request<WellKnownDocument>(HTTP_PATHS.wellKnown, { timeoutMs });
  }

  manifest() {
    return this.traced('GetManifest', async (headers) => this.learn(validated(await this.request(HTTP_PATHS.manifest, { headers }), this.endpoint)));
  }

  manifestWithProof(challenge: string) {
    return this.traced('GetManifest', async (headers) => {
      let proof: string | undefined;
      const raw = await this.request(HTTP_PATHS.manifest, {
        headers: { ...headers, [REGISTRY_CHALLENGE_HEADER]: challenge },
        onResponse: (response) => (proof = response.headers.get(REGISTRY_PROOF_HEADER) ?? undefined),
      });
      return { manifest: this.learn(validated(raw, this.endpoint)), ...(proof && { proof }) };
    });
  }

  execute(request: ExecuteRequest, signal?: AbortSignal) {
    return this.traced('Execute', (headers) =>
      this.request<ExecuteResponse>(HTTP_PATHS.execute, {
        method: 'POST',
        body: JSON.stringify(request),
        headers,
        signal,
        timeoutMs: EXECUTE_TIMEOUT_MS,
      }),
    );
  }

  loadOptions(request: LoadOptionsRequest) {
    return this.traced('LoadOptions', async (headers) => {
      const { options } = await this.request<{ options: PropertyOption[] }>(HTTP_PATHS.loadOptions, {
        method: 'POST',
        body: JSON.stringify(request),
        headers,
      });
      return options;
    });
  }

  testCredentials(request: TestCredentialsRequest) {
    return this.traced('TestCredentials', async (headers) => {
      const response = await this.request<TestCredentialsResponse>(HTTP_PATHS.testCredentials, {
        method: 'POST',
        body: JSON.stringify(request),
        headers,
        timeoutMs: 30_000,
      });
      return { ok: Boolean(response.ok), ...(response.message && { message: response.message }) };
    });
  }

  webhookMethod(request: WebhookMethodRequest) {
    return this.traced('WebhookMethod', (headers) =>
      this.request<WebhookMethodResponse>(HTTP_PATHS.webhookMethod, { method: 'POST', body: JSON.stringify(request), headers, timeoutMs: 30_000 }),
    );
  }

  receiveWebhook(request: WebhookRequest) {
    return this.traced('ReceiveWebhook', (headers) =>
      this.request<WebhookResponse>(HTTP_PATHS.webhook, { method: 'POST', body: JSON.stringify(request), headers, timeoutMs: 30_000 }),
    );
  }

  health(timeoutMs = 2_000) {
    return this.request<HealthResponse>(HTTP_PATHS.health, { timeoutMs });
  }

  close() {}
}

export class GrpcPluginClient extends TracedClient implements PluginClient {
  readonly transport = 'grpc' as const;
  private readonly client: grpc.Client;

  constructor(readonly endpoint: string) {
    super();
    const proto = loadLandflowProto();
    this.client = new proto.PluginService(endpoint.replace(/^grpc:\/\//, ''), grpc.credentials.createInsecure(), {
      'grpc.max_receive_message_length': 64 * 1024 * 1024,
      'grpc.max_send_message_length': 64 * 1024 * 1024,
      // Fresh subchannels per client: with grpc-js' global pool, the client created for a restarted
      // plugin would share the old client's subchannel, still in TRANSIENT_FAILURE backoff, and its
      // GetManifest would fail fast with UNAVAILABLE (the first announce after a restart got a 422).
      'grpc.use_local_subchannel_pool': 1,
    });
  }

  manifest() {
    return this.traced('GetManifest', async (metadata) => {
      const msg = await unary<object, ManifestMsg>(this.client, 'GetManifest', { hostVersion: '0.1.0' }, 5_000, metadata);
      return this.learn(validated(manifestFromMsg(msg), this.endpoint));
    });
  }

  /** GetManifest with the challenge in the call metadata; the proof comes back in the response metadata. */
  manifestWithProof(challenge: string) {
    return this.traced('GetManifest', (traceContext) =>
      new Promise<{ manifest: PluginManifest; proof?: string }>((resolve, reject) => {
        const metadata = new grpc.Metadata();
        for (const [key, value] of Object.entries({ ...traceContext, [REGISTRY_CHALLENGE_HEADER]: challenge })) metadata.set(key, value);
        let proof: string | undefined;
        const getManifest = (this.client as unknown as Record<string, Function>).GetManifest;
        const call = getManifest.call(this.client, { hostVersion: '0.1.0' }, metadata, { deadline: new Date(Date.now() + 5_000) }, (error: grpc.ServiceError | null, msg: ManifestMsg) => {
          if (error) return reject(error);
          try {
            resolve({ manifest: this.learn(validated(manifestFromMsg(msg), this.endpoint)), ...(proof && { proof }) });
          } catch (invalid) {
            reject(invalid);
          }
        }) as grpc.ClientUnaryCall;
        call.on('metadata', (received: grpc.Metadata) => {
          const value = received.get(REGISTRY_PROOF_HEADER)[0];
          if (typeof value === 'string') proof = value;
        });
      }),
    );
  }

  async execute(request: ExecuteRequest, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('Execution canceled');
    return this.traced('Execute', async (metadata) => {
      const msg = await unary<object, ExecuteResponseMsg>(this.client, 'Execute', executeRequestToMsg(request), EXECUTE_TIMEOUT_MS, metadata);
      return executeResponseFromMsg(msg);
    });
  }

  loadOptions(request: LoadOptionsRequest) {
    return this.traced('LoadOptions', async (metadata) =>
      optionsFromMsg(await unary(this.client, 'LoadOptions', loadOptionsRequestToMsg(request), 5_000, metadata)),
    );
  }

  testCredentials(request: TestCredentialsRequest) {
    return this.traced('TestCredentials', async (metadata) =>
      testCredentialsResponseFromMsg(await unary(this.client, 'TestCredentials', testCredentialsRequestToMsg(request), 30_000, metadata)),
    );
  }

  webhookMethod(request: WebhookMethodRequest) {
    return this.traced('WebhookMethod', async (metadata) =>
      webhookMethodResponseFromMsg(await unary<object, WebhookMethodResponseMsg>(this.client, 'WebhookMethod', webhookMethodRequestToMsg(request), 30_000, metadata)),
    );
  }

  receiveWebhook(request: WebhookRequest) {
    return this.traced('ReceiveWebhook', async (metadata) =>
      webhookResponseFromMsg(await unary<object, ReceiveWebhookResponseMsg>(this.client, 'ReceiveWebhook', webhookRequestToMsg(request), 30_000, metadata)),
    );
  }

  async health(timeoutMs = 2_000) {
    return healthFromMsg(await unary(this.client, 'Health', {}, timeoutMs));
  }

  close() {
    this.client.close();
  }
}

/**
 * One plugin Service with several ready pods (Kubernetes discovery, LANDFLOW_K8S_SPREAD=pods): a client per pod, and
 * each call goes to the pod with the fewest calls in flight (round robin among equals). Through the Service alone, a
 * gRPC connection (one HTTP/2 connection, many calls) would stay on whichever pod kube-proxy picked when it opened.
 *
 * The manifest (with the registry proof) and health probes go through the Service (`primary`), once per plugin, not
 * per pod. Without pods (none ready yet, or `setBackends([])`) every call goes to the Service. A pod that leaves keeps
 * its client until its calls in flight finish.
 */
export class PooledPluginClient implements PluginClient {
  readonly endpoint: string;
  readonly transport: Exclude<Transport, 'in-process'>;
  private readonly backends = new Map<string, { client: PluginClient; inflight: number; calls: number; retiring: boolean }>();
  private cursor = 0;

  constructor(
    private primary: PluginClient,
    backends: string[] = [],
    private readonly create: (endpoint: string) => PluginClient = createClient,
  ) {
    this.endpoint = primary.endpoint;
    this.transport = primary.transport;
    this.setBackends(backends);
  }

  get pluginId(): string | undefined {
    return this.primary.pluginId;
  }

  set pluginId(id: string | undefined) {
    this.primary.pluginId = id;
    for (const backend of this.backends.values()) backend.client.pluginId = id;
  }

  /** The pods to spread calls over (same transport as the Service endpoint); pods not listed any more are let go. */
  setBackends(endpoints: string[]) {
    const wanted = new Set(endpoints);
    for (const [endpoint, backend] of this.backends) {
      if (wanted.has(endpoint)) continue;
      this.backends.delete(endpoint);
      backend.retiring = true;
      if (!backend.inflight) backend.client.close();
    }
    for (const endpoint of wanted) {
      if (this.backends.has(endpoint)) continue;
      const client = this.create(endpoint);
      client.pluginId = this.primary.pluginId;
      this.backends.set(endpoint, { client, inflight: 0, calls: 0, retiring: false });
    }
  }

  /** A re-pulled manifest came with a new Service client: the pods' clients stay. */
  replacePrimary(client: PluginClient) {
    if (client === this.primary) return;
    const pluginId = client.pluginId ?? this.primary.pluginId;
    this.primary.close();
    this.primary = client;
    this.pluginId = pluginId;
  }

  /** The pods and how many calls each took (tests and troubleshooting). */
  stats(): Array<{ endpoint: string; inflight: number; calls: number }> {
    return [...this.backends.entries()].map(([endpoint, { inflight, calls }]) => ({ endpoint, inflight, calls }));
  }

  /** The pod with the fewest calls in flight, starting the search after the last one picked. */
  private pick() {
    const list = [...this.backends.values()];
    if (!list.length) return undefined;
    let best: (typeof list)[number] | undefined;
    let bestIndex = 0;
    for (let i = 0; i < list.length; i++) {
      const index = (this.cursor + i) % list.length;
      const backend = list[index]!;
      if (!best || backend.inflight < best.inflight) {
        best = backend;
        bestIndex = index;
      }
    }
    this.cursor = (bestIndex + 1) % list.length;
    return best;
  }

  private async spread<T>(call: (client: PluginClient) => Promise<T>): Promise<T> {
    const backend = this.pick();
    if (!backend) return call(this.primary);
    backend.inflight++;
    backend.calls++;
    try {
      return await call(backend.client);
    } finally {
      backend.inflight--;
      if (backend.retiring && !backend.inflight) backend.client.close();
    }
  }

  manifest() {
    return this.primary.manifest();
  }

  manifestWithProof(challenge: string) {
    if (!this.primary.manifestWithProof) throw new Error(`${this.endpoint} can't answer a registry challenge`);
    return this.primary.manifestWithProof(challenge);
  }

  health(timeoutMs?: number) {
    return this.primary.health(timeoutMs);
  }

  execute(request: ExecuteRequest, signal?: AbortSignal) {
    return this.spread((client) => client.execute(request, signal));
  }

  loadOptions(request: LoadOptionsRequest) {
    return this.spread((client) => client.loadOptions(request));
  }

  testCredentials(request: TestCredentialsRequest) {
    return this.spread((client) => client.testCredentials(request));
  }

  webhookMethod(request: WebhookMethodRequest) {
    return this.spread((client) => client.webhookMethod(request));
  }

  receiveWebhook(request: WebhookRequest) {
    return this.spread((client) => client.receiveWebhook(request));
  }

  close() {
    this.primary.close();
    for (const backend of this.backends.values()) backend.client.close();
    this.backends.clear();
  }
}

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;

/**
 * The transport kind of an endpoint, from its scheme: `http`/`https`, `grpc`, or a broker kind for the logical
 * `<kind>://<connectionId>/<pluginId>` endpoints (docs/transports.md). Throws for a malformed endpoint.
 */
export function transportOf(endpoint: string): Exclude<Transport, 'in-process'> {
  return transportKindOf(endpoint);
}

/** A direct client (HTTP or gRPC) for an endpoint; brokered endpoints go through their provider (lib/server/transports). */
export function createClient(endpoint: string): PluginClient {
  const transport = transportOf(endpoint);
  if (transport === 'grpc') return new GrpcPluginClient(endpoint);
  if (transport === 'http') return new HttpPluginClient(endpoint);
  throw new Error(`No direct client for "${endpoint}": ${transport} endpoints go through their transport provider`);
}

/** Normalize "localhost:7101" style input and strip trailing slashes. */
export function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  return SCHEME.test(trimmed) ? trimmed : `http://${trimmed}`;
}
