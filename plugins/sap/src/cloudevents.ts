/**
 * CloudEvents as SAP's event brokers deliver them (spec 2.1): structured JSON (`application/cloudevents+json`), binary (`ce-*` headers
 * and the data as the body) and batches. The payload of an S/4HANA business event is thin: the `data` holds the key of the changed
 * object, not the record, so the trigger says "this key changed" and a Get follows. The exact type and topic strings are UNVERIFIED
 * (two forms appear in sources: dotted `sap.s4.beh.businesspartner.v1.BusinessPartner.Changed.v1` and slashed
 * `sap/s4/beh/salesorder/v1/SalesOrder/Created/v1`); both are read.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { JsonObject } from '@landflow/sdk';

export const MAX_EVENT_BODY_BYTES = 1_000_000;
export const MAX_BATCH = 100;

export class CloudEventError extends Error {}

export interface ParsedEvent {
  id: string;
  source: string;
  type: string;
  specversion: string;
  time: string | null;
  subject: string | null;
  datacontenttype: string | null;
  /** `BusinessPartner` and `Changed` for `...BusinessPartner.Changed.v1`, when the type has that shape. */
  entity: string | null;
  action: string | null;
  /** The key properties when `data` is a small flat object (the thin payload), else null. */
  keys: JsonObject | null;
  data: unknown;
  sappassport: string | null;
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);

/** `entity` and `action` from an event type or topic: the two segments before a trailing `v<number>`. */
export function entityAndAction(type: string): { entity: string | null; action: string | null } {
  const parts = type.split(/[./]/).filter(Boolean);
  if (parts.length > 0 && /^v\d+$/i.test(parts[parts.length - 1])) parts.pop();
  if (parts.length < 3) return { entity: null, action: null };
  return { entity: parts[parts.length - 2], action: parts[parts.length - 1] };
}

function fromAttributes(attributes: Record<string, unknown>, data: unknown, fallbackType: string | null): ParsedEvent {
  const specversion = str(attributes.specversion);
  const id = str(attributes.id);
  const source = str(attributes.source);
  const type = str(attributes.type);
  const missing = [!specversion && 'specversion', !id && 'id', !source && 'source', !type && 'type'].filter(Boolean);
  if (missing.length > 0) throw new CloudEventError(`Not a CloudEvent: missing ${missing.join(', ')}`);
  const { entity, action } = entityAndAction(type as string);
  const flat = isObject(data) && Object.keys(data).length > 0 && Object.keys(data).length <= 10 && Object.values(data).every((v) => ['string', 'number', 'boolean'].includes(typeof v));
  return {
    id: id as string,
    source: source as string,
    type: type as string,
    specversion: specversion as string,
    time: str(attributes.time) ?? null,
    subject: str(attributes.subject) ?? null,
    datacontenttype: str(attributes.datacontenttype) ?? fallbackType,
    entity,
    action,
    keys: flat ? (data as JsonObject) : null,
    data: data ?? null,
    sappassport: str(attributes.sappassport) ?? null,
  };
}

/** The events in one delivery. Throws `CloudEventError` for anything that is not a valid CloudEvent. */
export function parseCloudEvents(headers: Record<string, string>, raw: Buffer): ParsedEvent[] {
  if (raw.length > MAX_EVENT_BODY_BYTES) throw new CloudEventError('The delivery is too large');
  const contentType = (headers['content-type'] ?? '').toLowerCase();
  const text = raw.toString('utf8');
  const parse = (): unknown => {
    try {
      return text.trim() ? JSON.parse(text) : undefined;
    } catch {
      throw new CloudEventError('The body is not valid JSON');
    }
  };
  if (headers['ce-specversion'] !== undefined && !contentType.includes('cloudevents')) {
    // Binary mode: attributes are `ce-*` headers, the body is the data.
    const attributes: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(headers)) if (name.startsWith('ce-')) attributes[name.slice(3)] = value;
    const data = contentType.includes('json') || /^\s*[{[]/.test(text) ? parse() : text || undefined;
    return [fromAttributes(attributes, data, contentType.split(';')[0] || null)];
  }
  const body = parse();
  if (Array.isArray(body)) {
    if (body.length === 0) throw new CloudEventError('The batch is empty');
    if (body.length > MAX_BATCH) throw new CloudEventError(`A batch may hold at most ${MAX_BATCH} events`);
    return body.map((entry) => {
      if (!isObject(entry)) throw new CloudEventError('A batch entry is not an object');
      return fromAttributes(entry, entry.data ?? (typeof entry.data_base64 === 'string' ? Buffer.from(entry.data_base64, 'base64').toString('utf8') : undefined), null);
    });
  }
  if (!isObject(body)) throw new CloudEventError('The body is not a CloudEvent');
  const data = body.data ?? (typeof body.data_base64 === 'string' ? Buffer.from(body.data_base64, 'base64').toString('utf8') : undefined);
  return [fromAttributes(body, data, null)];
}

/** `*` globs over the event type (as sent, and with slashes read as dots); an empty list matches everything. */
export function matchesType(type: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  const forms = [type, type.replace(/\//g, '.')];
  return patterns.some((pattern) => {
    const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
    return forms.some((form) => regex.test(form));
  });
}

export const parsePatterns = (text: unknown) =>
  String(text ?? '')
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);

/** Constant-time comparison of the delivery's secret with the configured one. */
export function secretMatches(given: string | undefined, expected: string): boolean {
  if (!given || !expected) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** One key for a delivery: the event's `source` and `id`, or a hash of all of them for a batch. */
export function deliveryKey(events: ParsedEvent[]): string {
  const keys = events.map((e) => `${e.source}|${e.id}`);
  return keys.length === 1 ? keys[0] : createHash('sha1').update(keys.join('\n')).digest('hex');
}
