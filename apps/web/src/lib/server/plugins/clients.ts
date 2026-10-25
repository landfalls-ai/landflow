/**
 * Transport clients for remote plugins. Both speak the same logical protocol;
 * callers never care which one is behind an endpoint.
 *
 * Execute, LoadOptions, TestCredentials and GetManifest each run in a
 * `plugin.rpc {Method}` client span whose W3C trace context travels as HTTP
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
  type ExecuteResponseMsg,
  type ManifestMsg,
} from '@landflow/protocol/grpc';
import type { Transport } from '@landflow/engine';
import { tracePluginRpc, type RpcMethod } from '../telemetry';

export const EXECUTE_TIMEOUT_MS = Number(process.env.LANDFLOW_EXECUTE_TIMEOUT_MS ?? 120_000);

export interface PluginClient {
  readonly endpoint: string;
  readonly transport: Exclude<Transport, 'in-process'>;
  /** Learned from the first manifest; labels the RPC spans and metrics. */
  pluginId?: string;
  manifest(): Promise<PluginManifest>;
  execute(request: ExecuteRequest, signal?: AbortSignal): Promise<ExecuteResponse>;
  /** `request.credentials` is forwarded, for option lists that call an API. */
  loadOptions(request: LoadOptionsRequest): Promise<PropertyOption[]>;
  /** "Test connection" for a credential type the plugin declares `testable`. */
  testCredentials(request: TestCredentialsRequest): Promise<TestCredentialsResponse>;
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

  private async request<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
    const timeout = AbortSignal.timeout(init.timeoutMs ?? 10_000);
    const response = await fetch(new URL(path, this.endpoint), {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {}
      throw new Error(`${response.status} from ${this.endpoint}${path}: ${message}`);
    }
    return JSON.parse(text) as T;
  }

  wellKnown(timeoutMs = 800) {
    return this.request<WellKnownDocument>(HTTP_PATHS.wellKnown, { timeoutMs });
  }

  manifest() {
    return this.traced('GetManifest', async (headers) => this.learn(validated(await this.request(HTTP_PATHS.manifest, { headers }), this.endpoint)));
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

  async health(timeoutMs = 2_000) {
    return healthFromMsg(await unary(this.client, 'Health', {}, timeoutMs));
  }

  close() {
    this.client.close();
  }
}

export function transportOf(endpoint: string): Exclude<Transport, 'in-process'> {
  if (endpoint.startsWith('grpc://')) return 'grpc';
  if (/^https?:\/\//.test(endpoint)) return 'http';
  throw new Error(`Unsupported endpoint "${endpoint}" (use http://, https:// or grpc://)`);
}

export function createClient(endpoint: string): PluginClient {
  return transportOf(endpoint) === 'grpc' ? new GrpcPluginClient(endpoint) : new HttpPluginClient(endpoint);
}

/** Normalize "localhost:7101" style input and strip trailing slashes. */
export function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  return /^(https?|grpc):\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
}
