/**
 * A transport binding is one face of a plugin (docs/transports.md "SDK side"):
 * HTTP, gRPC, a broker, MCP, or anything a plugin author plugs in. A binding
 * owns the wire (listen or connect, decode, reply) and nothing else: every call
 * goes through the dispatcher it is given, which runs the node with spans,
 * metrics, redaction, the deadline, cancellation and the concurrency limit.
 *
 *   const binding: TransportBinding = {
 *     kind: 'fake',
 *     async start(context) { … context.dispatcher.execute(request, { transport: 'fake', deadline }) …; return { endpoints: [] }; },
 *     async stop() { … },
 *   };
 *   await serve(plugin, { http: 7101, bindings: [binding] });
 *
 * The Go and Python SDKs use the same names (TransportBinding, BindingContext, BindingInfo).
 */
import type { PluginManifest } from '@landflow/protocol';
import type { Dispatcher } from './dispatcher';
import type { ProcessLogger } from './logger';
import type { IPlugin } from './node';
import type { Telemetry } from './otel';

export interface TransportBinding {
  /** `'http'`, `'grpc'`, `'mcp'` or a broker kind (`'kafka'`, `'nats'`…). Selected by LANDFLOW_TRANSPORTS; one binding per kind. */
  readonly kind: string;
  /** Listen or connect. Resolves once calls can arrive, with the endpoint(s) to announce, if any. */
  start(context: BindingContext): Promise<BindingInfo>;
  /** Stop taking calls, let the in-flight ones finish (`context.dispatcher.drain()`), then close. */
  stop(): Promise<void>;
}

/** What `serve()` hands a binding when it starts it. */
export interface BindingContext {
  readonly plugin: IPlugin;
  /** The wire manifest, with the `transports` and `maxConcurrency` hints already filled in. */
  readonly manifest: PluginManifest;
  /** The one entry point for every call: `execute`, `loadOptions`, `testCredentials`, `webhookMethod`, `webhook`, `health`. */
  readonly dispatcher: Dispatcher;
  readonly telemetry: Telemetry;
  /** The process log, tagged with `landflow.transport: <kind>`. */
  readonly logger: ProcessLogger;
  /** Host name to put in announced endpoints (LANDFLOW_ADVERTISE_HOST, default 127.0.0.1). */
  readonly advertiseHost: string;
  /** The hints `serve()` announces: the kinds that started and the plugin's concurrency limit. */
  readonly hints: TransportHints;
  /**
   * Announce more endpoints after `start()` (a broker binding that reconnects or learns its logical endpoint later).
   * Endpoints returned from `start()` are announced automatically; a withdrawn endpoint stops heartbeating at once.
   */
  announce(endpoints: string[]): void;
  withdraw(endpoints: string[]): void;
}

export interface BindingInfo {
  /** Endpoints the host can reach this face at (`http://host:7101`, `grpc://host:7201`, `kafka://conn/plugin`). Empty when there is nothing to announce. */
  endpoints: string[];
  /** One line for the startup log, e.g. `listening on :7101`. */
  description?: string;
}

/**
 * Manifest and announce hints (docs/transports.md "Protocol changes" §2): the same optional fields as on
 * `PluginManifest` (`@landflow/protocol`), which `serve()` also sends with every announce. Hosts that don't know them
 * ignore them. // TODO(stream T1-A/T1-E): type them on AnnounceRequest too once the host reads them from announces.
 */
export interface TransportHints extends Pick<PluginManifest, 'transports' | 'maxConcurrency'> {
  /** The faces this instance started (`['http', 'grpc']`). */
  transports?: string[];
  /** The most calls this instance runs at once; absent means unlimited (the host then assumes DEFAULT_MAX_CONCURRENCY). */
  maxConcurrency?: number;
}

/** Parses LANDFLOW_TRANSPORTS (`http,grpc,kafka`): lower-cased, trimmed, de-duplicated; undefined when unset or empty. */
export function parseTransportList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const kinds = [...new Set(value.split(',').map((kind) => kind.trim().toLowerCase()).filter(Boolean))];
  return kinds.length ? kinds : undefined;
}
