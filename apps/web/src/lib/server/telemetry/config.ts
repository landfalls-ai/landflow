/** Telemetry settings from the environment (docs/observability.md §1). Read once per module graph. */
import packageJson from '../../../../package.json';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const flag = (value: string | undefined, fallback: boolean) => (value === undefined || value === '' ? fallback : !/^(false|0|no|off)$/i.test(value.trim()));
const level = (value: string | undefined): LogLevel =>
  ['debug', 'info', 'warn', 'error'].includes(value?.toLowerCase() ?? '') ? (value!.toLowerCase() as LogLevel) : 'info';

export const telemetryConfig = {
  serviceName: process.env.OTEL_SERVICE_NAME || 'landflow-host',
  serviceVersion: packageJson.version,
  disabled: flag(process.env.OTEL_SDK_DISABLED, false),
  logLevel: level(process.env.LANDFLOW_LOG_LEVEL),
  logFormat: process.env.LANDFLOW_LOG_FORMAT?.toLowerCase() === 'pretty' ? ('pretty' as const) : ('json' as const),
  logSpans: flag(process.env.LANDFLOW_LOG_SPANS, true),
  prometheus: flag(process.env.LANDFLOW_METRICS_PROMETHEUS, true),
  exportTraces:
    Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) && process.env.OTEL_TRACES_EXPORTER !== 'none',
  exportMetrics:
    Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) && process.env.OTEL_METRICS_EXPORTER !== 'none',
  metricExportIntervalMs: Math.max(1_000, Number(process.env.OTEL_METRIC_EXPORT_INTERVAL) || 15_000),
};

/**
 * Link to a trace in the configured backend (LANDFLOW_TRACE_URL, e.g.
 * `http://localhost:16686/trace/{traceId}`), or undefined when none is set.
 */
export function traceUrl(traceId: string | undefined): string | undefined {
  const template = process.env.LANDFLOW_TRACE_URL?.trim();
  if (!template || !traceId) return undefined;
  return template.replaceAll('{traceId}', encodeURIComponent(traceId)).replaceAll('{trace_id}', encodeURIComponent(traceId));
}

/** Attribute and field names whose (string) values are never logged or exported. */
/** Same rule as the SDKs: names of addresses and kinds (`tokenUrl`, `tokenType`) are not secrets. */
export const SECRET_KEY = /^(?!.*(?:url|uri|endpoint|host|type)$).*(?:token|secret|password|authorization|api[-_]?key|cookie)/i;
