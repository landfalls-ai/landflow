/**
 * Secret redaction for logs and span attributes (docs/observability.md §3).
 *
 * Two rules:
 * - attribute / log keys matching SECRET_KEY have their value replaced;
 * - credential values of the requests in flight are registered here and
 *   scrubbed out of every string we write (log messages, attribute values,
 *   exception messages). That also catches tokens embedded in URLs, such as
 *   Telegram's `https://api.telegram.org/bot<token>/getMe`.
 */
import type { Span as SdkSpan, SpanProcessor } from '@opentelemetry/sdk-trace';
import type { JsonObject, PropertyDescriptor } from '@landflow/protocol';

/** Names of addresses, kinds and usage counts (`tokenUrl`, `tokenType`, `gen_ai.usage.input_tokens`) are not secrets. */
export const SECRET_KEY = /^(?!.*(?:url|uri|endpoint|host|type|tokens)$).*(?:token|secret|password|authorization|api[-_]?key|cookie)/i;
export const REDACTED = '[REDACTED]';

/** Shorter values are not registered: scrubbing "1" or "on" out of every log line would destroy the logs. */
const MIN_SECRET_LENGTH = 4;

const active = new Map<string, number>();
let sorted: string[] = [];

function refresh() {
  sorted = [...active.keys()].sort((a, b) => b.length - a.length);
}

/** Register secret values for the duration of a call; returns the release function. */
export function registerSecrets(values: Iterable<string>): () => void {
  const added: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) continue;
    for (const variant of new Set([value, encodeURIComponent(value)])) {
      active.set(variant, (active.get(variant) ?? 0) + 1);
      added.push(variant);
    }
  }
  if (!added.length) return () => {};
  refresh();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const variant of added) {
      const count = (active.get(variant) ?? 1) - 1;
      if (count <= 0) active.delete(variant);
      else active.set(variant, count);
    }
    refresh();
  };
}

/** Replace every registered secret inside `text`. */
export function scrub(text: string): string {
  if (!sorted.length || !text) return text;
  let out = text;
  for (const secret of sorted) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  return out;
}

/** Redact one attribute value given its key. Returns the same reference when nothing changed. */
export function redactValue(key: string, value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (SECRET_KEY.test(key)) return REDACTED;
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value) && value.some((v) => typeof v === 'string')) {
    const next = value.map((v) => (typeof v === 'string' ? scrub(v) : v));
    return next.every((v, i) => v === value[i]) ? value : next;
  }
  return value;
}

export function redactAttributes<T extends Record<string, unknown>>(attributes: T): T {
  let out: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(attributes)) {
    const next = redactValue(key, value);
    if (next !== value) (out ??= { ...attributes })[key] = next;
  }
  return (out ?? attributes) as T;
}

/**
 * The string values of a credential that count as secrets: fields marked
 * `typeOptions.password` or named like a secret. Without a declared type
 * (unknown to this plugin) every string value counts.
 */
export function secretValues(data: JsonObject | undefined, properties?: readonly PropertyDescriptor[]): string[] {
  if (!data) return [];
  const out: string[] = [];
  const secretFields = properties && new Set(properties.filter((p) => p.typeOptions?.password || SECRET_KEY.test(p.name)).map((p) => p.name));
  const collect = (value: unknown, all: boolean) => {
    if (typeof value === 'string') {
      if (all) out.push(value);
    } else if (Array.isArray(value)) value.forEach((v) => collect(v, all));
    else if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) collect(nested, all || SECRET_KEY.test(key));
    }
  };
  for (const [key, value] of Object.entries(data)) collect(value, !secretFields || secretFields.has(key) || SECRET_KEY.test(key));
  return out;
}

/**
 * Last line of defence for spans: redacts attributes, event attributes and the
 * status message just before a span ends (whatever the node code set on it).
 */
export class RedactingSpanProcessor implements SpanProcessor {
  onStart(): void {}
  onEnding(span: SdkSpan): void {
    for (const [key, value] of Object.entries(span.attributes)) {
      const next = redactValue(key, value);
      if (next !== value) span.setAttribute(key, next as string);
    }
    for (const event of span.events) {
      const attributes = event.attributes as Record<string, unknown> | undefined;
      if (!attributes) continue;
      for (const [key, value] of Object.entries(attributes)) attributes[key] = redactValue(key, value);
    }
    if (span.status.message) {
      const message = scrub(span.status.message);
      if (message !== span.status.message) span.setStatus({ code: span.status.code, message });
    }
  }
  onEnd(): void {}
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
