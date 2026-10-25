/**
 * Structured logger: one JSON object per line on stdout (or `pretty` lines),
 * stamped with the active span's trace and span ids. String values under
 * secret-looking keys are redacted. See docs/observability.md §3.
 */
import { context, trace } from '@opentelemetry/api';
import { SECRET_KEY, telemetryConfig, type LogLevel } from './config';

export type LogAttributes = Record<string, unknown>;

export interface Logger {
  debug(message: string, attributes?: LogAttributes): void;
  info(message: string, attributes?: LogAttributes): void;
  warn(message: string, attributes?: LogAttributes): void;
  /** `attributes.error` may be an Error: its message, type and stack are logged. */
  error(message: string, attributes?: LogAttributes): void;
  /** A logger that adds these attributes to every line. */
  child(attributes: LogAttributes): Logger;
}

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACTED = '[redacted]';

export function isEnabled(level: LogLevel) {
  return SEVERITY[level] >= SEVERITY[telemetryConfig.logLevel];
}

/** Redact string values under secret-looking keys, recursively (numbers such as token counts are kept). */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) && (typeof entry === 'string' || (typeof entry === 'object' && entry !== null)) ? REDACTED : redact(entry, depth + 1);
  }
  return out;
}

function errorFields(error: unknown): LogAttributes {
  if (error instanceof Error) {
    return { error: error.message, 'exception.type': error.name, ...(error.stack && { 'exception.stacktrace': error.stack }) };
  }
  return { error: String(error) };
}

/** Write one record. `fields` are written after ts/level/service/msg/trace ids, in order. */
export function writeRecord(level: LogLevel, message: string, fields: LogAttributes, at = new Date()) {
  const ids = trace.getSpanContext(context.active());
  const record: LogAttributes = {
    ts: at.toISOString(),
    level,
    service: telemetryConfig.serviceName,
    msg: message,
    ...(ids && trace.isSpanContextValid(ids) && { trace_id: ids.traceId, span_id: ids.spanId }),
    ...(redact(fields) as LogAttributes),
  };
  process.stdout.write(`${telemetryConfig.logFormat === 'pretty' ? pretty(record) : safeJson(record)}\n`);
}

function safeJson(record: LogAttributes): string {
  try {
    return JSON.stringify(record);
  } catch {
    return JSON.stringify({ ts: record.ts, level: record.level, service: record.service, msg: record.msg, note: 'unserializable fields dropped' });
  }
}

/** `HH:MM:SS level service msg (trace=…/span=…) k=v` */
function pretty(record: LogAttributes): string {
  const { ts, level, service, msg, trace_id, span_id, ...rest } = record;
  const time = String(ts).slice(11, 19);
  const ids = trace_id ? ` (trace=${trace_id}${span_id ? `/span=${span_id}` : ''})` : '';
  const pairs = Object.entries(rest)
    .filter(([key]) => key !== 'exception.stacktrace')
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
  const stack = typeof rest['exception.stacktrace'] === 'string' ? `\n${rest['exception.stacktrace']}` : '';
  return `${time} ${String(level).padEnd(5)} ${service} ${msg}${ids}${pairs ? ` ${pairs}` : ''}${stack}`;
}

function createLogger(base: LogAttributes): Logger {
  const at =
    (level: LogLevel) =>
    (message: string, attributes: LogAttributes = {}) => {
      if (!isEnabled(level)) return;
      const { error, ...rest } = attributes;
      writeRecord(level, message, { ...base, ...rest, ...(error !== undefined && errorFields(error)) });
    };
  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: (attributes) => createLogger({ ...base, ...attributes }),
  };
}

export const logger: Logger = createLogger({});
