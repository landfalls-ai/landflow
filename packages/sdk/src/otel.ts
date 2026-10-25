/**
 * The telemetry handle every server and execute context uses. It is small on
 * purpose and only depends on `@opentelemetry/api` (+ the W3C propagators):
 * the providers, exporters and the Prometheus reader are built by
 * `createTelemetry()` in `./telemetry`, which `serve()` calls.
 *
 * Without `createTelemetry()` (tests, or nodes running in-process inside the
 * host) the SDK uses a *passive* handle: tracer and meter come from the global
 * OpenTelemetry API (whatever the host registered, else no-ops) and the
 * process log is silent.
 */
import {
  context,
  metrics,
  trace,
  type Context,
  type Counter,
  type Histogram,
  type Meter,
  type TextMapGetter,
  type TextMapPropagator,
  type Tracer,
} from '@opentelemetry/api';
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { createLogger, parseLogLevel, type ProcessLogger } from './logger';

export const TRACER_NAME = '@landflow/sdk';
/** Meter that node-author metrics (`ctx.metrics.*`) are created on. */
export const CUSTOM_METER_NAME = '@landflow/sdk/custom';

/** Histogram buckets for every millisecond duration (docs/observability.md §5). */
export const DURATION_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000];
/** OTel semantic-convention buckets for `http.client.request.duration` (seconds). */
export const HTTP_DURATION_BUCKETS_S = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];

/** The automatic plugin metrics (docs/observability.md §5, "Plugins"). */
export interface PluginInstruments {
  executions: Counter;
  executeDuration: Histogram;
  items: Counter;
  loadOptions: Counter;
  httpClientDuration: Histogram;
}

export interface Telemetry {
  /** False when OTEL_SDK_DISABLED=true: spans and metrics are no-ops. */
  readonly enabled: boolean;
  readonly serviceName: string;
  readonly pluginId?: string;
  readonly tracer: Tracer;
  /** Meter of the SDK's own instruments. */
  readonly meter: Meter;
  /** Meter of node-author metrics. */
  readonly customMeter: Meter;
  readonly logger: ProcessLogger;
  readonly propagator: TextMapPropagator;
  readonly instruments: PluginInstruments;
  /** Prometheus text exposition, or undefined when not served (LANDFLOW_METRICS_PROMETHEUS=false, telemetry disabled, passive). */
  scrapeMetrics(): Promise<string | undefined>;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export function w3cPropagator(): TextMapPropagator {
  return new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] });
}

export function createInstruments(meter: Meter): PluginInstruments {
  const ms = { unit: 'ms', advice: { explicitBucketBoundaries: DURATION_BUCKETS_MS } };
  return {
    executions: meter.createCounter('landflow.plugin.executions', { description: 'Node executions served by this plugin' }),
    executeDuration: meter.createHistogram('landflow.plugin.execute.duration', { ...ms, description: 'Execute duration' }),
    items: meter.createCounter('landflow.plugin.items', { description: 'Items received and emitted by node executions' }),
    loadOptions: meter.createCounter('landflow.plugin.load_options', { description: 'LoadOptions calls' }),
    httpClientDuration: meter.createHistogram('http.client.request.duration', {
      unit: 's',
      description: 'Duration of outbound HTTP requests',
      advice: { explicitBucketBoundaries: HTTP_DURATION_BUCKETS_S },
    }),
  };
}

let passive: Telemetry | undefined;
let current: Telemetry | undefined;

function passiveTelemetry(): Telemetry {
  if (passive) return passive;
  const env = process.env;
  const meter = metrics.getMeter(TRACER_NAME);
  let instruments: PluginInstruments | undefined;
  passive = {
    enabled: env.OTEL_SDK_DISABLED !== 'true',
    serviceName: env.OTEL_SERVICE_NAME ?? 'landflow-sdk',
    tracer: trace.getTracer(TRACER_NAME),
    meter,
    customMeter: metrics.getMeter(CUSTOM_METER_NAME),
    // Silent unless LANDFLOW_SDK_DEBUG: inside the host, node logs reach the host through ExecuteResponse/onLog.
    logger: createLogger({
      service: env.OTEL_SERVICE_NAME ?? 'landflow-sdk',
      level: parseLogLevel(env.LANDFLOW_LOG_LEVEL),
      format: env.LANDFLOW_LOG_FORMAT === 'pretty' ? 'pretty' : 'json',
      silent: !env.LANDFLOW_SDK_DEBUG,
    }),
    propagator: w3cPropagator(),
    get instruments() {
      return (instruments ??= createInstruments(meter));
    },
    scrapeMetrics: async () => undefined,
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  return passive;
}

/** The telemetry used when a server or context is not given one explicitly. */
export function getTelemetry(): Telemetry {
  return current ?? passiveTelemetry();
}

/** Make `telemetry` the process default (serve() does this). Pass undefined to go back to passive. */
export function setTelemetry(telemetry: Telemetry | undefined): void {
  current = telemetry;
}

// ---------------------------------------------------------------------------
// Propagation
// ---------------------------------------------------------------------------

const headersGetter: TextMapGetter<Headers> = {
  get: (carrier, key) => carrier.get(key) ?? undefined,
  keys: (carrier) => [...carrier.keys()],
};

/** The minimal slice of grpc.Metadata we read, so this module does not load grpc-js. */
export interface MetadataLike {
  get(key: string): Array<string | Buffer>;
  getMap(): Record<string, string | Buffer>;
}

const metadataGetter: TextMapGetter<MetadataLike> = {
  get: (carrier, key) => {
    const values = carrier.get(key);
    return values.length ? values.map(String).join(',') : undefined;
  },
  keys: (carrier) => Object.keys(carrier.getMap()),
};

/** W3C context from the host's HTTP headers (`traceparent`, `tracestate`, `baggage`). */
export function contextFromHeaders(telemetry: Telemetry, headers: Headers): Context {
  return telemetry.propagator.extract(context.active(), headers, headersGetter);
}

/** W3C context from gRPC metadata (lower-case keys). */
export function contextFromMetadata(telemetry: Telemetry, metadata: MetadataLike | undefined): Context {
  if (!metadata) return context.active();
  return telemetry.propagator.extract(context.active(), metadata, metadataGetter);
}

/** Inject the context's trace headers into `headers` (outbound calls). */
export function injectHeaders(telemetry: Telemetry, ctx: Context, headers: Headers): void {
  telemetry.propagator.inject(ctx, headers, { set: (carrier, key, value) => carrier.set(key, value) });
}
