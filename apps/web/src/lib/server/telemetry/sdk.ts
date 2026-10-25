/**
 * Registers the OpenTelemetry SDK for the host process: AsyncLocalStorage
 * context, W3C trace-context + baggage propagation, the tracer provider (span
 * log lines always; OTLP/HTTP export when OTEL_EXPORTER_OTLP_* is set) and the
 * meter provider (Prometheus reader for /api/metrics; OTLP when configured).
 * Called from instrumentation.ts; the SDK lives on globalThis so module
 * re-evaluation (HMR, per-route module graphs) never registers it twice.
 */
import { context, diag, DiagLogLevel, metrics, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PrometheusExporter, PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, detectResources, envDetector, resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader, type MetricData, type MetricReader, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, TracerProvider, type SpanProcessor } from '@opentelemetry/sdk-trace';
import { singleton } from '../singleton';
import { telemetryConfig } from './config';
import { logger } from './logger';
import { LandflowSampler, LandflowSpanProcessor, samplerFromEnv } from './processors';

export interface TelemetrySdk {
  enabled: boolean;
  tracerProvider?: TracerProvider;
  meterProvider?: MeterProvider;
  prometheus?: PrometheusExporter;
  shutdown(): Promise<void>;
}

const otelLog = logger.child({ component: 'otel' });

function start(): TelemetrySdk {
  if (telemetryConfig.disabled) {
    otelLog.info('telemetry disabled (OTEL_SDK_DISABLED)');
    return { enabled: false, shutdown: async () => {} };
  }

  diag.setLogger(
    {
      error: (message, ...args) => otelLog.warn(message, args.length ? { details: args.map(String).join(' ') } : {}),
      warn: (message, ...args) => otelLog.warn(message, args.length ? { details: args.map(String).join(' ') } : {}),
      info: () => {},
      debug: () => {},
      verbose: () => {},
    },
    DiagLogLevel.WARN,
  );

  const resource = defaultResource()
    .merge(
      resourceFromAttributes({
        'service.name': 'landflow-host',
        'service.namespace': 'landflow',
        'service.version': telemetryConfig.serviceVersion,
      }),
    )
    // OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES win.
    .merge(detectResources({ detectors: [envDetector] }));

  // Next.js would wrap every fetch in its own client span, doubling the plugin.rpc and gen_ai.chat spans.
  process.env.NEXT_OTEL_FETCH_DISABLED ??= '1';
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }));

  const protocol = process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
  if (protocol && protocol !== 'http/json' && (telemetryConfig.exportTraces || telemetryConfig.exportMetrics)) {
    otelLog.warn(`OTEL_EXPORTER_OTLP_PROTOCOL=${protocol} is not supported by the host; exporting OTLP over HTTP with JSON encoding`);
  }

  const spanProcessors: SpanProcessor[] = [new LandflowSpanProcessor()];
  if (telemetryConfig.exportTraces) spanProcessors.push(new BatchSpanProcessor({ exporter: new OTLPTraceExporter() }));
  const tracerProvider = new TracerProvider({ resource, sampler: new LandflowSampler(samplerFromEnv()), spanProcessors });
  trace.setGlobalTracerProvider(tracerProvider);

  const readers: MetricReader[] = [];
  let prometheus: PrometheusExporter | undefined;
  if (telemetryConfig.prometheus) {
    prometheus = new PrometheusExporter({ preventServerStart: true });
    readers.push(prometheus);
  }
  if (telemetryConfig.exportMetrics) {
    readers.push(new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: telemetryConfig.metricExportIntervalMs }));
  }
  const meterProvider = new MeterProvider({ resource, readers });
  metrics.setGlobalMeterProvider(meterProvider);

  otelLog.info('telemetry started', {
    'otel.traces.export': telemetryConfig.exportTraces ? 'otlp' : 'none',
    'otel.metrics.export': [prometheus && 'prometheus', telemetryConfig.exportMetrics && 'otlp'].filter(Boolean).join(',') || 'none',
    'otel.sampler': process.env.OTEL_TRACES_SAMPLER ?? 'parentbased_always_on',
  });

  return {
    enabled: true,
    tracerProvider,
    meterProvider,
    prometheus,
    async shutdown() {
      await Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]);
    },
  };
}

/** Start telemetry once per process (idempotent). */
export function startTelemetry(): TelemetrySdk {
  return singleton('telemetry', start);
}

const UNIT_SUFFIX: Record<string, string> = { ms: 'milliseconds', s: 'seconds', min: 'minutes', h: 'hours', d: 'days', By: 'bytes', '%': 'percent' };

/**
 * Prometheus names carry the unit (`landflow.execution.duration` in ms →
 * `landflow_execution_duration_milliseconds`); the JS serializer leaves it out,
 * so add it to copies of the descriptors.
 */
function withUnitSuffixes(resourceMetrics: ResourceMetrics): ResourceMetrics {
  const rename = (metric: MetricData): MetricData => {
    const { name, unit } = metric.descriptor;
    const suffix = UNIT_SUFFIX[unit] ?? (/^[a-z]+$/i.test(unit) ? unit.toLowerCase() : '');
    if (!suffix || name.endsWith(suffix)) return metric;
    return { ...metric, descriptor: { ...metric.descriptor, name: `${name}_${suffix}` } } as MetricData;
  };
  return { ...resourceMetrics, scopeMetrics: resourceMetrics.scopeMetrics.map((scope) => ({ ...scope, metrics: scope.metrics.map(rename) })) };
}

/** Current metrics in the Prometheus text format, or undefined when Prometheus is off. */
export async function prometheusText(): Promise<string | undefined> {
  const sdk = startTelemetry();
  if (!sdk.prometheus) return undefined;
  const { resourceMetrics, errors } = await sdk.prometheus.collect();
  if (errors.length) otelLog.warn('errors while collecting metrics', { details: errors.map(String).join('; ') });
  return new PrometheusSerializer().serialize(withUnitSuffixes(resourceMetrics));
}
