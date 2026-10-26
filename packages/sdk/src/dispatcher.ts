/**
 * The dispatcher: the transport-neutral server side of landflow.plugin/v1,
 * which every binding (HTTP, gRPC, brokers, MCP) calls. One server span per
 * call (child of the host's `plugin.rpc` span, from the context the binding
 * extracted), the automatic plugin metrics (docs/observability.md §4–5),
 * secret redaction, credentials, plus what a wire cannot do on its own:
 *
 * - **Deadline**: `call.deadline` is an epoch in ms. A call whose deadline has
 *   passed at admission is refused with `deadline_exceeded` and never runs;
 *   otherwise the node sees it as `ctx.deadline` and `ctx.signal` aborts when
 *   it passes (reason `DispatchError('deadline_exceeded')`).
 * - **Cancellation**: `call.signal` is the binding's abort (the client went
 *   away, a `cancel` event arrived). It aborts `ctx.signal`, the traced
 *   `ctx.http` and the binary helpers. Node code that ignores the signal still
 *   finishes; its result is returned to the binding, which may have nobody to
 *   give it to.
 * - **Concurrency**: at most `maxConcurrency` calls run node code at once
 *   (Execute, LoadOptions, TestCredentials, WebhookMethod, ReceiveWebhook;
 *   never Health or the manifest). Calls beyond it wait in arrival order while
 *   their deadline and signal are still honoured; when as many are waiting as
 *   may run, further calls are refused at once with `capacity`, so the host
 *   can take the call elsewhere knowing it never ran. A call marked `wait`
 *   (the broker faces, already bounded by their prefetch) is never refused:
 *   it waits its turn, and the broker holds the rest.
 *
 * Health and the manifest get no spans.
 */
import { context, SpanKind, SpanStatusCode, trace, type Attributes, type Context, type Span } from '@opentelemetry/api';
import type {
  ExecuteRequest,
  ExecuteResponse,
  HealthResponse,
  LoadOptionsRequest,
  PluginManifest,
  PropertyOption,
  TestCredentialsRequest,
  TestCredentialsResponse,
  WebhookMethodRequest,
  WebhookMethodResponse,
  WebhookRequest,
  WebhookResponse,
} from '@landflow/protocol';
import type { TransportHints } from './binding';
import { localCredentialName, requestSecrets, type CredentialTypeDefinition } from './credentials';
import { buildManifest, type INodeType, type IPlugin } from './node';
import { getTelemetry, type Telemetry } from './otel';
import { registerSecrets, scrub, secretValues } from './redact';
import { executeNode, executeTestCredentials, findNode, runLoadOptions, toErrorPayload } from './runtime';
import { runWebhook, runWebhookMethod } from './webhooks';

const RPC_SERVICE = 'landflow.plugin.v1.PluginService';

export type DispatchErrorCode = 'unknown_node' | 'unknown_credential_type' | 'deadline_exceeded' | 'canceled' | 'capacity';

/** Why the dispatcher refused or stopped a call. Bindings map `code` to their wire (HTTP 404/504/499/429, gRPC NOT_FOUND/DEADLINE_EXCEEDED/CANCELLED/RESOURCE_EXHAUSTED). */
export class DispatchError extends Error {
  constructor(
    readonly code: DispatchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DispatchError';
  }
}

/** Per-call facts a binding knows and the node code needs. */
export interface DispatchCall {
  /** The face the call arrived on: `'http'`, `'grpc'`, a broker kind, `'mcp'`. Becomes `rpc.system` on the server span. */
  transport: string;
  /** Epoch ms after which the call must not run (and must stop). Absent: no deadline. */
  deadline?: number;
  /** Aborted when the caller cancels (connection closed, a `cancel` event). */
  signal?: AbortSignal;
  /** Trace context extracted from the wire (`traceparent`, `tracestate`, `baggage`); the server span's parent. */
  parent?: Context;
  /** Extra span attributes: `messaging.*` for brokers, `mcp.tool.name` for MCP. */
  attributes?: Attributes;
  /**
   * Wait for a slot however many are waiting, instead of being refused with `capacity`. For faces that already bound how
   * many calls they hand over (a broker face takes at most its prefetch): the rest stays in the broker, which is the
   * buffer the host spilled over to, so refusing would only bounce the call back.
   */
  wait?: boolean;
}

export interface DispatcherOptions {
  /** Default: getTelemetry() at call time (what serve() installed, else passive). */
  telemetry?: Telemetry;
  /** Most calls running node code at once; absent or 0 means unlimited. */
  maxConcurrency?: number;
  /** Most calls waiting for a slot before new ones are refused with `capacity`. Default: `maxConcurrency`. */
  maxQueue?: number;
  /** Hints put into the manifest (`transports`, `maxConcurrency`). `maxConcurrency` defaults to the option above. */
  hints?: TransportHints;
}

export interface DispatcherStats {
  /** Calls running node code right now. */
  inFlight: number;
  /** Calls waiting for a slot. */
  queued: number;
  /** The limit, or undefined when unlimited. */
  maxConcurrency?: number;
}

export interface Dispatcher {
  readonly plugin: IPlugin;
  /** The wire manifest, hints included. */
  readonly manifest: PluginManifest;
  readonly telemetry: Telemetry;
  readonly maxConcurrency: number | undefined;
  readonly inFlight: number;
  readonly queued: number;
  stats(): DispatcherStats;
  health(): HealthResponse;
  /** Throws DispatchError (`unknown_node`, `deadline_exceeded`, `capacity`); a node error is in `response.error`. */
  execute(request: ExecuteRequest, call: DispatchCall): Promise<ExecuteResponse>;
  /** Throws DispatchError, or the node's error (a NodeOperationError, message scrubbed). */
  loadOptions(request: LoadOptionsRequest, call: DispatchCall): Promise<PropertyOption[]>;
  /** Throws DispatchError (`unknown_credential_type`…); a failed test is `{ ok: false }`. */
  testCredentials(request: TestCredentialsRequest, call: DispatchCall): Promise<TestCredentialsResponse>;
  webhookMethod(request: WebhookMethodRequest, call: DispatchCall): Promise<WebhookMethodResponse>;
  webhook(request: WebhookRequest, call: DispatchCall): Promise<WebhookResponse>;
  /** Resolves when no call is running or waiting, or after `timeoutMs` (default 10 s). For a binding's `stop()`. */
  drain(timeoutMs?: number): Promise<void>;
  findNode(type: string): INodeType | undefined;
  findCredentialType(name: string): CredentialTypeDefinition | undefined;
}

function rpcAttributes(call: DispatchCall, method: string): Attributes {
  return { 'rpc.system': call.transport, 'rpc.service': RPC_SERVICE, 'rpc.method': method, ...call.attributes };
}

function fail(span: Span, error: unknown, message?: string) {
  span.recordException(error instanceof Error ? error : new Error(String(error)));
  span.setStatus({ code: SpanStatusCode.ERROR, message: scrub(message ?? (error as Error)?.message ?? String(error)) });
}

const countItems = (branches: { length: number }[]) => branches.reduce((sum, branch) => sum + branch.length, 0);

export function findCredentialType(plugin: IPlugin, name: string): CredentialTypeDefinition | undefined {
  const local = localCredentialName(name);
  return plugin.credentialTypes?.find((type) => type.name === local);
}

/** The manifest with the transport hints (docs/transports.md "Protocol changes" §2) spliced in. */
export function manifestWithHints(plugin: IPlugin, hints: TransportHints = {}): PluginManifest {
  const manifest = buildManifest(plugin);
  if (hints.transports?.length) manifest.transports = [...hints.transports];
  if (hints.maxConcurrency && hints.maxConcurrency > 0) manifest.maxConcurrency = hints.maxConcurrency;
  return manifest;
}

/** The abort signal node code sees: the binding's signal plus a timer for the deadline, whichever fires first. */
function callSignal(call: DispatchCall): { signal?: AbortSignal; release: () => void } {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  // A bare abort() carries a DOMException AbortError; the node sees the dispatcher's own reason instead.
  const onAbort = () => {
    const reason = call.signal?.reason;
    controller.abort(reason === undefined || (reason instanceof Error && reason.name === 'AbortError') ? new DispatchError('canceled', 'The call was canceled') : reason);
  };
  if (call.signal) {
    if (call.signal.aborted) onAbort();
    else call.signal.addEventListener('abort', onAbort, { once: true });
  }
  if (call.deadline !== undefined && Number.isFinite(call.deadline)) {
    timer = setTimeout(() => controller.abort(new DispatchError('deadline_exceeded', 'Deadline exceeded')), Math.max(0, call.deadline - Date.now()));
  }
  if (!call.signal && timer === undefined) return { signal: undefined, release: () => {} };
  return {
    signal: controller.signal,
    release: () => {
      if (timer) clearTimeout(timer);
      call.signal?.removeEventListener('abort', onAbort);
    },
  };
}

/** A node that threw because `ctx.signal` fired reports the deadline or cancellation, not the library's own wording. */
function abortedPayload(signal: AbortSignal | undefined): ExecuteResponse['error'] | undefined {
  if (!signal?.aborted) return undefined;
  const reason = signal.reason;
  return { message: reason instanceof DispatchError ? reason.message : scrub(reason instanceof Error ? reason.message : 'The call was canceled') };
}

export function createDispatcher(plugin: IPlugin, options: DispatcherOptions = {}): Dispatcher {
  const startedAt = Date.now();
  const limit = options.maxConcurrency && options.maxConcurrency > 0 ? Math.floor(options.maxConcurrency) : undefined;
  const maxQueue = options.maxQueue !== undefined ? Math.max(0, Math.floor(options.maxQueue)) : limit;
  const manifest = manifestWithHints(plugin, { ...options.hints, maxConcurrency: options.hints?.maxConcurrency ?? limit });
  const telemetryFor = () => options.telemetry ?? getTelemetry();

  let inFlight = 0;
  const waiting: Array<{ wake: () => void }> = [];
  const idle = new Set<() => void>();

  const wakeNext = () => {
    const next = waiting.shift();
    if (next) next.wake();
    else if (inFlight === 0) for (const resolve of idle) resolve();
  };

  /** Admission: refuse a dead or canceled call, then take a slot or wait for one. */
  const acquire = async (call: DispatchCall): Promise<() => void> => {
    if (call.deadline !== undefined && Date.now() >= call.deadline) throw new DispatchError('deadline_exceeded', 'Deadline exceeded before the call started');
    if (call.signal?.aborted) throw new DispatchError('canceled', 'The call was canceled before it started');
    if (limit !== undefined && inFlight >= limit) {
      if (!call.wait && maxQueue !== undefined && waiting.length >= maxQueue) {
        throw new DispatchError('capacity', `The plugin is at its concurrency limit (${limit} in flight, ${waiting.length} waiting)`);
      }
      await new Promise<void>((resolve, reject) => {
        const entry = { wake: () => {} };
        const { signal, release } = callSignal(call);
        const leave = () => {
          release();
          const index = waiting.indexOf(entry);
          if (index >= 0) waiting.splice(index, 1);
        };
        entry.wake = () => {
          release();
          resolve();
        };
        signal?.addEventListener(
          'abort',
          () => {
            leave();
            const reason = signal.reason;
            reject(reason instanceof DispatchError ? new DispatchError(reason.code, `${reason.message} while waiting for a slot`) : new DispatchError('canceled', 'The call was canceled while waiting for a slot'));
          },
          { once: true },
        );
        waiting.push(entry);
      });
    }
    inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inFlight -= 1;
      wakeNext();
    };
  };

  const run = async <T>(call: DispatchCall, body: (signal: AbortSignal | undefined, telemetry: Telemetry, parent: Context) => Promise<T>): Promise<T> => {
    const release = await acquire(call);
    const { signal, release: releaseSignal } = callSignal(call);
    try {
      return await body(signal, telemetryFor(), call.parent ?? context.active());
    } finally {
      releaseSignal();
      release();
    }
  };

  const extras = (telemetry: Telemetry, signal: AbortSignal | undefined, deadline: number | undefined) => ({
    telemetry,
    credentialTypes: plugin.credentialTypes,
    pluginId: plugin.info.id,
    ...(signal && { signal }),
    ...(deadline !== undefined && { deadline }),
  });

  const nodeOrThrow = (type: string): INodeType => {
    const node = findNode(plugin.nodes, plugin.info.id, type);
    if (!node) throw new DispatchError('unknown_node', `Unknown node type "${type}"`);
    return node;
  };

  const dispatcher: Dispatcher = {
    plugin,
    manifest,
    get telemetry() {
      return telemetryFor();
    },
    maxConcurrency: limit,
    get inFlight() {
      return inFlight;
    },
    get queued() {
      return waiting.length;
    },
    stats: () => ({ inFlight, queued: waiting.length, ...(limit !== undefined && { maxConcurrency: limit }) }),
    health: () => ({ status: 'ok', uptimeMs: Date.now() - startedAt, pluginId: plugin.info.id, version: plugin.info.version }),
    findNode: (type) => findNode(plugin.nodes, plugin.info.id, type),
    findCredentialType: (name) => findCredentialType(plugin, name),

    async execute(request, call) {
      const node = nodeOrThrow(request.node.type);
      return run(call, async (signal, telemetry, parent) => {
        const type = `${plugin.info.id}.${node.description.name}`;
        const itemsIn = countItems(request.inputs);
        // Held until the span has ended, so the redaction processor still knows the values.
        const releaseSecrets = registerSecrets(requestSecrets(request.credentials, plugin.credentialTypes));
        const span = telemetry.tracer.startSpan(
          `plugin.execute ${type}`,
          {
            kind: SpanKind.SERVER,
            attributes: {
              'landflow.plugin.id': plugin.info.id,
              'landflow.node.type': type,
              'landflow.node.name': request.node.name,
              ...(request.workflowId && { 'landflow.workflow.id': request.workflowId }),
              'landflow.execution.id': request.executionId,
              'landflow.execution.mode': request.mode,
              'landflow.items.in': itemsIn,
              ...rpcAttributes(call, 'Execute'),
            },
          },
          parent,
        );
        const started = performance.now();
        let status: 'success' | 'error' = 'error';
        let itemsOut = 0;
        try {
          const { response, error } = await context.with(trace.setSpan(parent, span), () => executeNode(node, request, extras(telemetry, signal, call.deadline)));
          if (response.error && error) {
            const aborted = abortedPayload(signal);
            if (aborted) response.error = aborted;
          }
          itemsOut = countItems(response.outputs);
          span.setAttribute('landflow.items.out', itemsOut);
          if (response.error) fail(span, error ?? new Error(response.error.message), response.error.message);
          else status = 'success';
          return response;
        } catch (error) {
          fail(span, error);
          throw error;
        } finally {
          span.end();
          releaseSecrets();
          const { instruments } = telemetry;
          const attributes = { 'landflow.node.type': type, 'landflow.node.status': status };
          instruments.executions.add(1, attributes);
          instruments.executeDuration.record(performance.now() - started, attributes);
          instruments.items.add(itemsIn, { 'landflow.node.type': type, 'landflow.direction': 'in' });
          instruments.items.add(itemsOut, { 'landflow.node.type': type, 'landflow.direction': 'out' });
        }
      });
    },

    async loadOptions(request, call) {
      const node = nodeOrThrow(request.nodeType);
      return run(call, async (signal, telemetry, parent) => {
        const releaseSecrets = registerSecrets(requestSecrets(request.credentials, plugin.credentialTypes));
        const span = telemetry.tracer.startSpan(
          `plugin.load_options ${request.method}`,
          {
            kind: SpanKind.SERVER,
            attributes: {
              'landflow.plugin.id': plugin.info.id,
              'landflow.node.type': `${plugin.info.id}.${node.description.name}`,
              'landflow.load_options.method': request.method,
              ...rpcAttributes(call, 'LoadOptions'),
            },
          },
          parent,
        );
        let outcome: 'ok' | 'error' = 'error';
        try {
          const options = await context.with(trace.setSpan(parent, span), () =>
            runLoadOptions(node, request.method, request.parameters ?? {}, request.credentials, extras(telemetry, signal, call.deadline)),
          );
          outcome = 'ok';
          return options;
        } catch (error) {
          fail(span, error, toErrorPayload(error).message);
          throw error;
        } finally {
          span.end();
          releaseSecrets();
          telemetry.instruments.loadOptions.add(1, { 'landflow.load_options.method': request.method, 'landflow.outcome': outcome });
        }
      });
    },

    async testCredentials(request, call) {
      const name = localCredentialName(request.credentialType);
      const type = findCredentialType(plugin, name);
      if (!type) throw new DispatchError('unknown_credential_type', `Unknown credential type "${request.credentialType}"`);
      return run(call, async (signal, telemetry, parent) => {
        const releaseSecrets = registerSecrets(secretValues(request.data, type.properties));
        const span = telemetry.tracer.startSpan(
          `plugin.test_credentials ${name}`,
          { kind: SpanKind.SERVER, attributes: { 'landflow.plugin.id': plugin.info.id, 'landflow.credential.type': name, ...rpcAttributes(call, 'TestCredentials') } },
          parent,
        );
        try {
          const { response, error } = await context.with(trace.setSpan(parent, span), () => executeTestCredentials(plugin, request, { telemetry, ...(signal && { signal }) }));
          span.setAttribute('landflow.credential.ok', response.ok);
          if (error) fail(span, error, response.message);
          return response;
        } finally {
          span.end();
          releaseSecrets();
        }
      });
    },

    /** WebhookMethod (checkExists / create / delete of an app webhook trigger), in a `plugin.webhook_method {method}` server span. */
    async webhookMethod(request, call) {
      const node = nodeOrThrow(request.node.type);
      return run(call, async (signal, telemetry, parent) => {
        const type = `${plugin.info.id}.${node.description.name}`;
        const span = telemetry.tracer.startSpan(
          `plugin.webhook_method ${request.method}`,
          {
            kind: SpanKind.SERVER,
            attributes: {
              'landflow.plugin.id': plugin.info.id,
              'landflow.node.type': type,
              'landflow.node.name': request.node.name,
              'landflow.workflow.id': request.workflowId,
              'landflow.webhook.method': request.method,
              ...rpcAttributes(call, 'WebhookMethod'),
            },
          },
          parent,
        );
        try {
          const response = await context.with(trace.setSpan(parent, span), () => runWebhookMethod(node, request, extras(telemetry, signal, undefined)));
          if (response.error) fail(span, new Error(response.error.message), response.error.message);
          else if (request.method === 'checkExists') span.setAttribute('landflow.webhook.exists', response.exists === true);
          return response;
        } finally {
          span.end();
        }
      });
    },

    /** ReceiveWebhook (a call to an app webhook trigger's URL), in a `plugin.webhook {type}` server span. */
    async webhook(request, call) {
      const node = nodeOrThrow(request.node.type);
      return run(call, async (signal, telemetry, parent) => {
        const type = `${plugin.info.id}.${node.description.name}`;
        const span = telemetry.tracer.startSpan(
          `plugin.webhook ${type}`,
          {
            kind: SpanKind.SERVER,
            attributes: {
              'landflow.plugin.id': plugin.info.id,
              'landflow.node.type': type,
              'landflow.node.name': request.node.name,
              'landflow.workflow.id': request.workflowId,
              ...rpcAttributes(call, 'ReceiveWebhook'),
            },
          },
          parent,
        );
        try {
          const response = await context.with(trace.setSpan(parent, span), () => runWebhook(node, request, extras(telemetry, signal, undefined)));
          span.setAttribute('landflow.items.out', response.items?.length ?? 0);
          if (response.response?.status) span.setAttribute('http.response.status_code', response.response.status);
          if (response.error) fail(span, new Error(response.error.message), response.error.message);
          return response;
        } finally {
          span.end();
        }
      });
    },

    drain(timeoutMs = 10_000) {
      if (inFlight === 0 && waiting.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(done, timeoutMs);
        function done() {
          clearTimeout(timer);
          idle.delete(done);
          resolve();
        }
        idle.add(done);
      });
    },
  };
  return dispatcher;
}
