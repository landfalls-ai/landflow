/** Telemetry settings from the environment (docs/observability.md §1). Read once per module graph. */
import packageJson from '../../../../package.json';
import { flag } from '../config/parse';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const level = (value: string | undefined): LogLevel =>
  ['debug', 'info', 'warn', 'error'].includes(value?.toLowerCase() ?? '') ? (value!.toLowerCase() as LogLevel) : 'info';

export const telemetryConfig = {
  serviceName: process.env.OTEL_SERVICE_NAME || 'landflow-host',
  serviceVersion: packageJson.version,
  disabled: flag(process.env.OTEL_SDK_DISABLED, false, 'OTEL_SDK_DISABLED'),
  logLevel: level(process.env.LANDFLOW_LOG_LEVEL),
  logFormat: process.env.LANDFLOW_LOG_FORMAT?.toLowerCase() === 'pretty' ? ('pretty' as const) : ('json' as const),
  logSpans: flag(process.env.LANDFLOW_LOG_SPANS, true, 'LANDFLOW_LOG_SPANS'),
  prometheus: flag(process.env.LANDFLOW_METRICS_PROMETHEUS, true, 'LANDFLOW_METRICS_PROMETHEUS'),
  exportTraces:
    Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) && process.env.OTEL_TRACES_EXPORTER !== 'none',
  exportMetrics:
    Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) && process.env.OTEL_METRICS_EXPORTER !== 'none',
  metricExportIntervalMs: Math.max(1_000, Number(process.env.OTEL_METRIC_EXPORT_INTERVAL) || 15_000),
  /** OTel log records (audit events, lib/server/audit) over OTLP/HTTP JSON (./logs). */
  exportLogs:
    Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) && process.env.OTEL_LOGS_EXPORTER !== 'none',
  /** With exportLogs: every log line (but `span.end`) is also an OTel log record, with its trace and span ids. */
  logOtlp: flag(process.env.LANDFLOW_LOG_OTLP, true, 'LANDFLOW_LOG_OTLP'),
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

/**
 * Attribute and field names whose (string or object) values are never logged or exported.
 * Names of addresses, kinds, algorithms and ids of keys, tokens and sessions (`tokenUrl`, `tokenType`, `signatureAlgorithm`, `landflow.api_key.id`, `apiKeyId`) are not secrets; `secretId` and `secret_id` are (the Vault AppRole secret).
 * `credentials` counts only as a whole key name. Plain `session` and `sessionId` stay: agent session ids are needed to
 * debug a conversation, and only `sessionToken`, `sessionSecret` and `sessionCookie` are credentials.
 */
export const SECRET_KEY =
  /^(?!.*(?:url|uri|endpoint|host|type|algorithm)$)(?!.*(?:key|token|session|credentials?)[._-]?id$)(?:.*(?:token|secret|password|authorization|api[-_]?key|cookie|private[-_]?key|passphrase|signature|connection[-_]?string|session[-_]?(?:token|secret|cookie))|.*dsn$|credentials$)/i;
