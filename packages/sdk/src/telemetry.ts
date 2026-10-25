/**
 * Telemetry setup for a plugin process (docs/observability.md §1):
 *
 *   const telemetry = await createTelemetry({ pluginId: 'messaging', pluginVersion: '1.0.0' });
 *
 * serve() calls this for you. It builds a TracerProvider and a MeterProvider
 * with the plugin resource, a redaction processor, the `span.end` log
 * processor (LANDFLOW_LOG_SPANS), a Prometheus reader (LANDFLOW_METRICS_PROMETHEUS)
 * and OTLP exporters only when OTEL_EXPORTER_OTLP_*ENDPOINT is set.
 * OTEL_SDK_DISABLED=true returns a no-op handle (the logger still works).
 *
 * Tests inject exporters instead of touching globals:
 *
 *   const exporter = new InMemorySpanExporter();
 *   const telemetry = await createTelemetry({ pluginId: 'demo', spanExporters: [exporter], env: {}, logWriter: (l) => lines.push(l) });
 *   createFetchHandler(plugin, { telemetry });
 */
import { context, createNoopMeter, metrics, propagation, ProxyTracerProvider, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { PrometheusExporter, PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import { defaultResource, resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader, type IMetricReader, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BatchSpanProcessor,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
  TracerProvider,
  type Sampler,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';
import { createLogger, parseLogLevel, SpanLogProcessor, type LogFormat, type LogLevel, type ProcessLogger } from './logger';
import { createInstruments, CUSTOM_METER_NAME, TRACER_NAME, w3cPropagator, type PluginInstruments, type Telemetry } from './otel';
import { RedactingSpanProcessor } from './redact';
import { SDK_INFO } from './node';

export type { Telemetry };

type Env = Record<string, string | undefined>;

export interface TelemetryOptions {
  pluginId: string;
  pluginVersion?: string;
  /** `landflow.plugin.language`, default `typescript`. */
  language?: string;
  /** Configuration source, default process.env. */
  env?: Env;
  /** Extra exporters, each behind a SimpleSpanProcessor (tests: InMemorySpanExporter). */
  spanExporters?: SpanExporter[];
  /** Extra span processors. */
  spanProcessors?: SpanProcessor[];
  /** Extra metric readers (tests: a PeriodicExportingMetricReader over InMemoryMetricExporter). */
  metricReaders?: IMetricReader[];
  /** Process-log sink, default stdout. */
  logWriter?: (line: string) => void;
  /** Register the providers, propagator as the OpenTelemetry globals (serve() does). Default false. */
  registerGlobal?: boolean;
}

export interface TelemetryConfig {
  disabled: boolean;
  serviceName: string;
  logLevel: LogLevel;
  logFormat: LogFormat;
  logSpans: boolean;
  prometheus: boolean;
  tracesEndpoint?: string;
  metricsEndpoint?: string;
  metricExportIntervalMs: number;
  sampler: string;
  samplerArg?: string;
  resourceAttributes: Record<string, string>;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/** `k=v,k2=v2` with percent-encoded values (OTEL_RESOURCE_ATTRIBUTES). */
export function parseResourceAttributes(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (value ?? '').split(',')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    try {
      out[key] = decodeURIComponent(pair.slice(index + 1).trim());
    } catch {
      out[key] = pair.slice(index + 1).trim();
    }
  }
  return out;
}

function otlpEndpoint(env: Env, signal: 'TRACES' | 'METRICS', path: string): string | undefined {
  if (env[`OTEL_${signal}_EXPORTER`] === 'none') return undefined;
  const specific = env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`];
  if (specific) return specific;
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  return base ? `${base.replace(/\/+$/, '')}/${path}` : undefined;
}

export function readTelemetryConfig(env: Env, pluginId: string): TelemetryConfig {
  const resourceAttributes = parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES);
  const interval = Number(env.OTEL_METRIC_EXPORT_INTERVAL);
  return {
    disabled: flag(env.OTEL_SDK_DISABLED, false),
    serviceName: env.OTEL_SERVICE_NAME || resourceAttributes['service.name'] || `landflow-plugin-${pluginId}`,
    logLevel: parseLogLevel(env.LANDFLOW_LOG_LEVEL),
    logFormat: env.LANDFLOW_LOG_FORMAT === 'pretty' ? 'pretty' : 'json',
    logSpans: flag(env.LANDFLOW_LOG_SPANS, true),
    prometheus: flag(env.LANDFLOW_METRICS_PROMETHEUS, true),
    tracesEndpoint: otlpEndpoint(env, 'TRACES', 'v1/traces'),
    metricsEndpoint: otlpEndpoint(env, 'METRICS', 'v1/metrics'),
    metricExportIntervalMs: Number.isFinite(interval) && interval > 0 ? interval : 15_000,
    sampler: (env.OTEL_TRACES_SAMPLER || 'parentbased_always_on').toLowerCase(),
    samplerArg: env.OTEL_TRACES_SAMPLER_ARG,
    resourceAttributes,
  };
}

function createSampler(name: string, arg: string | undefined): Sampler {
  const parsed = Number(arg ?? 1);
  const ratio = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 1;
  switch (name) {
    case 'always_on':
      return new AlwaysOnSampler();
    case 'always_off':
      return new AlwaysOffSampler();
    case 'traceidratio':
      return new TraceIdRatioBasedSampler(ratio);
    case 'parentbased_always_off':
      return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case 'parentbased_traceidratio':
      return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });
    default:
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
  }
}

function createResource(config: TelemetryConfig, options: TelemetryOptions): Resource {
  return defaultResource().merge(
    resourceFromAttributes({
      'service.namespace': 'landflow',
      ...(options.pluginVersion && { 'service.version': options.pluginVersion }),
      'landflow.plugin.id': options.pluginId,
      'landflow.plugin.language': options.language ?? 'typescript',
      ...config.resourceAttributes,
      'service.name': config.serviceName,
    }),
  );
}

// ---------------------------------------------------------------------------
// Prometheus: OTel names with "." → "_" plus the unit suffix
// (landflow.plugin.execute.duration [ms] → landflow_plugin_execute_duration_milliseconds).
// ---------------------------------------------------------------------------

const UNITS: Record<string, string> = {
  ms: 'milliseconds',
  s: 'seconds',
  us: 'microseconds',
  ns: 'nanoseconds',
  min: 'minutes',
  h: 'hours',
  d: 'days',
  By: 'bytes',
  KiBy: 'kibibytes',
  MiBy: 'mebibytes',
  GiBy: 'gibibytes',
  KBy: 'kilobytes',
  MBy: 'megabytes',
  GBy: 'gigabytes',
  '%': 'percent',
};
const PER_UNITS: Record<string, string> = { s: 'second', ms: 'millisecond', min: 'minute', h: 'hour', d: 'day' };

export function prometheusUnitSuffix(unit: string | undefined): string | undefined {
  const clean = (unit ?? '').replace(/\{[^}]*\}/g, '').trim();
  if (!clean || clean === '1') return undefined;
  const [numerator, denominator] = clean.split('/');
  const suffix = denominator
    ? `${UNITS[numerator] ?? numerator}_per_${PER_UNITS[denominator] ?? denominator}`
    : (UNITS[numerator] ?? numerator);
  return suffix.replace(/[^a-zA-Z0-9_]/g, '_');
}

function withUnitSuffixes(resourceMetrics: ResourceMetrics): ResourceMetrics {
  return {
    ...resourceMetrics,
    scopeMetrics: resourceMetrics.scopeMetrics.map((scope) => ({
      ...scope,
      metrics: scope.metrics.map((metric) => {
        const suffix = prometheusUnitSuffix(metric.descriptor.unit);
        const { name } = metric.descriptor;
        if (!suffix || name.endsWith(`.${suffix}`) || name.endsWith(`_${suffix}`)) return metric;
        return { ...metric, descriptor: { ...metric.descriptor, name: `${name}_${suffix}` } } as typeof metric;
      }),
    })),
  };
}

// ---------------------------------------------------------------------------

function registerContextManager() {
  const manager = new AsyncLocalStorageContextManager().enable();
  if (!context.setGlobalContextManager(manager)) manager.disable();
}

export async function createTelemetry(options: TelemetryOptions): Promise<Telemetry> {
  const env = options.env ?? process.env;
  const config = readTelemetryConfig(env, options.pluginId);
  const logger: ProcessLogger = createLogger({ service: config.serviceName, level: config.logLevel, format: config.logFormat, write: options.logWriter });
  const propagator = w3cPropagator();
  // Async context is what makes ctx.span nesting and log trace ids work; harmless when one is already registered.
  registerContextManager();

  if (config.disabled) {
    const noop = createNoopMeter();
    return {
      enabled: false,
      serviceName: config.serviceName,
      pluginId: options.pluginId,
      tracer: new ProxyTracerProvider().getTracer(TRACER_NAME),
      meter: noop,
      customMeter: noop,
      logger,
      propagator,
      instruments: createInstruments(noop),
      scrapeMetrics: async () => undefined,
      forceFlush: async () => {},
      shutdown: async () => {},
    };
  }

  const resource = createResource(config, options);
  const spanProcessors: SpanProcessor[] = [new RedactingSpanProcessor()];
  if (config.logSpans) spanProcessors.push(new SpanLogProcessor(logger));
  if (config.tracesEndpoint) {
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    spanProcessors.push(new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: config.tracesEndpoint }) }));
  }
  for (const exporter of options.spanExporters ?? []) spanProcessors.push(new SimpleSpanProcessor({ exporter }));
  spanProcessors.push(...(options.spanProcessors ?? []));
  const tracerProvider = new TracerProvider({ resource, sampler: createSampler(config.sampler, config.samplerArg), spanProcessors });

  const readers: IMetricReader[] = [];
  const prometheus = config.prometheus ? new PrometheusExporter({ preventServerStart: true }) : undefined;
  if (prometheus) readers.push(prometheus);
  if (config.metricsEndpoint) {
    const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-http');
    readers.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: config.metricsEndpoint }),
        exportIntervalMillis: config.metricExportIntervalMs,
        exportTimeoutMillis: Math.min(30_000, config.metricExportIntervalMs),
      }),
    );
  }
  readers.push(...(options.metricReaders ?? []));
  const meterProvider = new MeterProvider({ resource, readers });

  const protocol = env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL;
  if ((config.tracesEndpoint || config.metricsEndpoint) && protocol && protocol !== 'http/json') {
    logger.warn(`OTEL_EXPORTER_OTLP_PROTOCOL=${protocol} is not supported by the TypeScript SDK; exporting OTLP as http/json`);
  }

  if (options.registerGlobal) {
    trace.setGlobalTracerProvider(tracerProvider);
    metrics.setGlobalMeterProvider(meterProvider);
    propagation.setGlobalPropagator(propagator);
  }

  const meter = meterProvider.getMeter(TRACER_NAME, SDK_INFO.version);
  const serializer = new PrometheusSerializer();
  let instruments: PluginInstruments | undefined;
  let closed = false;

  return {
    enabled: true,
    serviceName: config.serviceName,
    pluginId: options.pluginId,
    tracer: tracerProvider.getTracer(TRACER_NAME, SDK_INFO.version),
    meter,
    customMeter: meterProvider.getMeter(CUSTOM_METER_NAME, SDK_INFO.version),
    logger,
    propagator,
    get instruments() {
      return (instruments ??= createInstruments(meter));
    },
    async scrapeMetrics() {
      if (!prometheus) return undefined;
      const { resourceMetrics, errors } = await prometheus.collect();
      if (errors.length) logger.warn('metric collection reported errors', { errors: errors.map(String) });
      return serializer.serialize(withUnitSuffixes(resourceMetrics));
    },
    async forceFlush() {
      await Promise.allSettled([tracerProvider.forceFlush(), meterProvider.forceFlush()]);
    },
    async shutdown() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]);
    },
  };
}
