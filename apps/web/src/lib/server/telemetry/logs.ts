/**
 * OTLP log export for the host: a small LoggerProvider for the OTel logs API (`logs` in @opentelemetry/api) that
 * batches log records and POSTs them as OTLP/HTTP JSON to `<OTEL_EXPORTER_OTLP_ENDPOINT>/v1/logs`
 * (or OTEL_EXPORTER_OTLP_LOGS_ENDPOINT), with OTEL_EXPORTER_OTLP_HEADERS / OTEL_EXPORTER_OTLP_LOGS_HEADERS, the same
 * transport the trace and metric exporters use. startTelemetry() registers it when OTLP export is configured and
 * OTEL_LOGS_EXPORTER isn't `none`. Audit events (lib/server/audit) are its records: each carries `event.name`.
 *
 * A failed export is retried with the next batch; at most MAX_QUEUE records wait, the oldest are dropped beyond that.
 */
import { context, trace, type AnyValue, type Attributes, type Logger, type LoggerProvider, type LogRecord } from '@opentelemetry/api';

const MAX_BATCH = 512;
const MAX_QUEUE = 4_096;
const TIMEOUT_MS = 10_000;

type OtlpValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: OtlpValue[] } }
  | { kvlistValue: { values: Array<{ key: string; value: OtlpValue }> } };

interface Pending {
  scope: { name: string; version?: string };
  record: Record<string, unknown>;
}

/** An OTel AnyValue in OTLP JSON (int64 as a string, per the proto3 JSON mapping). */
export function otlpValue(value: AnyValue | unknown): OtlpValue {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(otlpValue) } };
  if (value instanceof Uint8Array) return { stringValue: Buffer.from(value).toString('base64') };
  if (value && typeof value === 'object') return { kvlistValue: { values: Object.entries(value).map(([key, v]) => ({ key, value: otlpValue(v) })) } };
  return { stringValue: value === undefined || value === null ? '' : String(value) };
}

export const otlpAttributes = (attributes: Attributes | Record<string, unknown> = {}) =>
  Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({ key, value: otlpValue(value) }));

/** Nanoseconds since the epoch, as OTLP JSON wants them (a string). */
function nanos(time: LogRecord['timestamp'] | undefined): string {
  if (time === undefined) return `${BigInt(Date.now()) * 1_000_000n}`;
  if (typeof time === 'number') return `${BigInt(Math.round(time)) * 1_000_000n}`;
  if (time instanceof Date) return `${BigInt(time.getTime()) * 1_000_000n}`;
  if (Array.isArray(time)) return `${BigInt(time[0]) * 1_000_000_000n + BigInt(time[1])}`;
  return `${BigInt(Date.now()) * 1_000_000n}`;
}

/** `k=v,k2=v2` (values URL-encoded) as headers. */
export function parseOtlpHeaders(text: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const part of (text ?? '').split(',')) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    try {
      headers[decodeURIComponent(part.slice(0, at).trim())] = decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      headers[part.slice(0, at).trim()] = part.slice(at + 1).trim();
    }
  }
  return headers;
}

/** Where logs go: OTEL_EXPORTER_OTLP_LOGS_ENDPOINT as it is, else `<OTEL_EXPORTER_OTLP_ENDPOINT>/v1/logs`. */
export function otlpLogsEndpoint(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const own = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim();
  if (own) return own;
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return base ? `${base.replace(/\/+$/, '')}/v1/logs` : undefined;
}

export interface OtlpLogExporterOptions {
  url: string;
  headers?: Record<string, string>;
  /** Resource attributes (service.name and friends). */
  resource?: Attributes;
  /** How often a batch goes out (OTEL_BLRP_SCHEDULE_DELAY, default 1 s). */
  intervalMs?: number;
  fetch?: typeof fetch;
}

/** The provider: getLogger() returns loggers that queue records; flush() sends them. */
export class OtlpJsonLogProvider implements LoggerProvider {
  private readonly queue: Pending[] = [];
  private readonly loggers = new Map<string, Logger>();
  private readonly timer: ReturnType<typeof setInterval>;
  private sending?: Promise<void>;
  dropped = 0;
  lastError?: string;

  constructor(private readonly options: OtlpLogExporterOptions) {
    this.timer = setInterval(() => void this.flush(), Math.max(100, options.intervalMs ?? 1_000));
    this.timer.unref?.();
  }

  getLogger(name: string, version?: string): Logger {
    const key = `${name}@${version ?? ''}`;
    let logger = this.loggers.get(key);
    if (!logger) {
      const scope = { name, ...(version && { version }) };
      logger = { emit: (record) => this.enqueue(scope, record), enabled: () => true };
      this.loggers.set(key, logger);
    }
    return logger;
  }

  private enqueue(scope: Pending['scope'], record: LogRecord) {
    const span = trace.getSpanContext(record.context ?? context.active());
    this.queue.push({
      scope,
      record: {
        timeUnixNano: nanos(record.timestamp),
        observedTimeUnixNano: nanos(record.observedTimestamp),
        ...(record.severityNumber !== undefined && { severityNumber: record.severityNumber }),
        ...(record.severityText && { severityText: record.severityText }),
        ...(record.eventName && { eventName: record.eventName }),
        ...(record.body !== undefined && { body: otlpValue(record.body) }),
        attributes: otlpAttributes(record.attributes),
        ...(span && trace.isSpanContextValid(span) && { traceId: span.traceId, spanId: span.spanId, flags: span.traceFlags }),
      },
    });
    if (this.queue.length > MAX_QUEUE) this.dropped += this.queue.splice(0, this.queue.length - MAX_QUEUE).length;
    if (this.queue.length >= MAX_BATCH) void this.flush();
  }

  /** The OTLP JSON body for these records, grouped by scope. */
  body(batch: Pending[]): string {
    const scopes = new Map<string, { scope: Pending['scope']; logRecords: unknown[] }>();
    for (const item of batch) {
      const key = `${item.scope.name}@${item.scope.version ?? ''}`;
      const group = scopes.get(key) ?? { scope: item.scope, logRecords: [] };
      group.logRecords.push(item.record);
      scopes.set(key, group);
    }
    return JSON.stringify({ resourceLogs: [{ resource: { attributes: otlpAttributes(this.options.resource) }, scopeLogs: [...scopes.values()] }] });
  }

  /** Send what is queued (one request per MAX_BATCH records); a failed batch goes back to the front of the queue. */
  flush(): Promise<void> {
    if (this.sending) return this.sending;
    if (!this.queue.length) return Promise.resolve();
    this.sending = (async () => {
      while (this.queue.length) {
        const batch = this.queue.splice(0, MAX_BATCH);
        try {
          const response = await (this.options.fetch ?? fetch)(this.options.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...this.options.headers },
            body: this.body(batch),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          this.lastError = undefined;
        } catch (error) {
          this.lastError = (error as Error).message;
          this.queue.unshift(...batch);
          if (this.queue.length > MAX_QUEUE) this.dropped += this.queue.splice(0, this.queue.length - MAX_QUEUE).length;
          break;
        }
      }
    })().finally(() => {
      this.sending = undefined;
    });
    return this.sending;
  }

  async shutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }
}
