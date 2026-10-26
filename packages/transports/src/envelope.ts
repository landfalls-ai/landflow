/**
 * The Landflow messaging envelope: a CloudEvents 1.0 event (docs/transports.md "One envelope", docs/protocol.md §14).
 *
 * Every brokered request, reply, cancel, announce and withdraw is one event. Attributes:
 *
 * | Attribute         | Value                                                                                        |
 * |-------------------|----------------------------------------------------------------------------------------------|
 * | `specversion`     | `1.0`                                                                                        |
 * | `id`              | the call id (a reply has its own id); 1–128 chars, unique per source                         |
 * | `source`          | `landflow://host/<instanceId>` or `landflow://plugin/<pluginId>/<instanceId>`                |
 * | `type`            | `dev.landflow.plugin.v1.<method>.request` / `.response` (method lower-case: `execute`,       |
 * |                   | `loadoptions`, `testcredentials`, `health`, `getmanifest`, `webhookmethod`, `receivewebhook`),|
 * |                   | `dev.landflow.plugin.v1.cancel`, `….announce`, `….withdraw`                                   |
 * | `subject`         | the node type (`twilio.message`) when the body names one                                     |
 * | `time`            | RFC 3339, the sender's clock; checked against the receiver's with a skew tolerance           |
 * | `datacontenttype` | `application/json` for a plain body, `application/octet-stream` for an encrypted one        |
 * | `traceparent`, `tracestate` | the CloudEvents distributed-tracing extension                                      |
 * | `lfreplyto`       | the channel the reply goes to (requests, when the broker has no native replies)              |
 * | `lfcorrelation`   | the request's `id` (on replies and cancels)                                                  |
 * | `lfdeadline`      | epoch ms after which the call must not run                                                   |
 * | `lfattempt`       | the sender's delivery attempt, `1` on the first send                                         |
 * | `lfidempotency`   | the request's `idempotencyKey`                                                               |
 * | `lfdelivery`      | the delivery mode the sender asks for: `at-most-once` / `at-least-once` (requests)           |
 * | `lfmanifest`      | the manifest hash the sender knows for the plugin (requests), the plugin's own (replies, announces) |
 * | `lferror`         | on a response: the error code (`manifest_mismatch`, `expired`, `bad_request`, `not_found`, `internal`, `cancelled`, `unavailable`, `too_large`); the body is `{ error, … }` |
 * | `lfenc`           | `aes-256-gcm` when the body is encrypted (nonce ‖ ciphertext ‖ tag)                          |
 * | `lfkeyid`         | the id of the key that encrypted and signed the event (rotation)                             |
 * | `lfsig`           | hex HMAC-SHA256 over the canonical form of every other attribute plus the body digest        |
 *
 * **Binary mode** (the broker has headers): attributes are headers under their bare names, the body is the bytes.
 * **Structured mode**: one JSON document `{ specversion, id, …, data }` (or `data_base64` for an encrypted body) with
 * `content-type: application/cloudevents+json`. `decodeWire()` tells them apart by the presence of `specversion` in the headers.
 * The body is the HTTP binding's JSON for the method (`ExecuteRequest` → `ExecuteResponse`, …).
 */
import type {
  ExecuteRequest,
  ExecuteResponse,
  HealthResponse,
  JsonValue,
  LoadOptionsRequest,
  LoadOptionsResponse,
  PluginManifest,
  TestCredentialsRequest,
  TestCredentialsResponse,
  WebhookMethodRequest,
  WebhookMethodResponse,
  WebhookRequest,
  WebhookResponse,
} from '@landflow/protocol';
import type { WireEvent } from './driver';

export const CE_SPECVERSION = '1.0';
export const CE_TYPE_PREFIX = 'dev.landflow.plugin.v1.';
export const STRUCTURED_CONTENT_TYPE = 'application/cloudevents+json; charset=utf-8';
export const JSON_CONTENT_TYPE = 'application/json';
export const ENCRYPTED_CONTENT_TYPE = 'application/octet-stream';

/** The logical RPC methods, named as in docs/protocol.md; `methodSegment()` gives the lower-case CloudEvents type segment. */
export const METHODS = ['GetManifest', 'Execute', 'LoadOptions', 'TestCredentials', 'Health', 'WebhookMethod', 'ReceiveWebhook'] as const;
export type Method = (typeof METHODS)[number];

/** Request and response bodies per method: the HTTP binding's JSON. */
export interface MethodBodies {
  GetManifest: { request: Record<string, never>; response: PluginManifest };
  Execute: { request: ExecuteRequest; response: ExecuteResponse };
  LoadOptions: { request: LoadOptionsRequest; response: LoadOptionsResponse };
  TestCredentials: { request: TestCredentialsRequest; response: TestCredentialsResponse };
  Health: { request: Record<string, never>; response: HealthResponse };
  WebhookMethod: { request: WebhookMethodRequest; response: WebhookMethodResponse };
  ReceiveWebhook: { request: WebhookRequest; response: WebhookResponse };
}
export type RequestBody<M extends Method> = MethodBodies[M]['request'];
export type ResponseBody<M extends Method> = MethodBodies[M]['response'];

const SEGMENTS: Record<Method, string> = {
  GetManifest: 'getmanifest',
  Execute: 'execute',
  LoadOptions: 'loadoptions',
  TestCredentials: 'testcredentials',
  Health: 'health',
  WebhookMethod: 'webhookmethod',
  ReceiveWebhook: 'receivewebhook',
};
const BY_SEGMENT = new Map(Object.entries(SEGMENTS).map(([method, segment]) => [segment, method as Method]));

export const methodSegment = (method: Method): string => SEGMENTS[method];
export const requestType = (method: Method): string => `${CE_TYPE_PREFIX}${SEGMENTS[method]}.request`;
export const responseType = (method: Method): string => `${CE_TYPE_PREFIX}${SEGMENTS[method]}.response`;
export const CANCEL_TYPE = `${CE_TYPE_PREFIX}cancel`;
export const ANNOUNCE_TYPE = `${CE_TYPE_PREFIX}announce`;
export const WITHDRAW_TYPE = `${CE_TYPE_PREFIX}withdraw`;

/** What a `type` means, or undefined for a type this version does not know. */
export function parseType(type: string): { kind: 'request' | 'response'; method: Method } | { kind: 'cancel' | 'announce' | 'withdraw' } | undefined {
  if (!type.startsWith(CE_TYPE_PREFIX)) return undefined;
  const rest = type.slice(CE_TYPE_PREFIX.length);
  if (rest === 'cancel' || rest === 'announce' || rest === 'withdraw') return { kind: rest };
  const dot = rest.lastIndexOf('.');
  if (dot < 0) return undefined;
  const method = BY_SEGMENT.get(rest.slice(0, dot));
  const kind = rest.slice(dot + 1);
  if (!method || (kind !== 'request' && kind !== 'response')) return undefined;
  return { kind, method };
}

/** The Landflow extensions. `lfsig` is computed over all the others, so it is listed but never part of the canonical form. */
export const LF_EXTENSIONS = [
  'lfreplyto',
  'lfcorrelation',
  'lfdeadline',
  'lfattempt',
  'lfidempotency',
  'lfdelivery',
  'lfmanifest',
  'lferror',
  'lfenc',
  'lfkeyid',
  'lfsig',
] as const;
export type LfExtension = (typeof LF_EXTENSIONS)[number];

/** Attribute names the envelope knows; anything else in the headers is ignored on decode (never signed, never trusted). */
export const KNOWN_ATTRIBUTES = ['specversion', 'id', 'source', 'type', 'subject', 'time', 'datacontenttype', 'traceparent', 'tracestate', ...LF_EXTENSIONS] as const;
export type AttributeName = (typeof KNOWN_ATTRIBUTES)[number];

export type DeliveryMode = 'at-most-once' | 'at-least-once';

/** Error codes a plugin puts in `lferror` on a response; the client maps them to typed errors. */
export type RemoteErrorCode = 'manifest_mismatch' | 'expired' | 'bad_request' | 'not_found' | 'internal' | 'cancelled' | 'unavailable' | 'too_large';

/** The decoded attributes of an event. All values are strings on the wire; `lfdeadline` and `lfattempt` are numeric strings. */
export interface Attributes {
  specversion: '1.0';
  id: string;
  source: string;
  type: string;
  subject?: string;
  time: string;
  datacontenttype: string;
  traceparent?: string;
  tracestate?: string;
  lfreplyto?: string;
  lfcorrelation?: string;
  lfdeadline?: string;
  lfattempt?: string;
  lfidempotency?: string;
  lfdelivery?: DeliveryMode;
  lfmanifest?: string;
  lferror?: RemoteErrorCode;
  lfenc?: 'aes-256-gcm';
  lfkeyid?: string;
  lfsig?: string;
}

/** An event with its body still as bytes: what the security layer signs, verifies, encrypts and decrypts. */
export interface RawEvent {
  attributes: Attributes;
  body: Uint8Array;
}

/** An event whose body is the method's JSON. */
export interface Event<T extends JsonValue = JsonValue> {
  attributes: Attributes;
  data: T;
}

/** Size accounting of an encoded event, so the core can refuse what a broker cannot carry before publishing. */
export interface WireSize {
  headerBytes: number;
  bodyBytes: number;
  totalBytes: number;
}

export class EnvelopeError extends Error {
  constructor(
    message: string,
    readonly reason: 'malformed' | 'unsupported' | 'too_large',
  ) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

const ID_RE = /^[\x21-\x7e]{1,128}$/;
const SOURCE_RE = /^landflow:\/\/(host\/[A-Za-z0-9._-]{1,128}|plugin\/[A-Za-z0-9._-]{1,128}\/[A-Za-z0-9._-]{1,128})$/;
const TYPE_RE = /^dev\.landflow\.plugin\.v1\.[a-z]+(\.(request|response))?$/;
const DIGITS_RE = /^\d{1,16}$/;
const HEX_RE = /^[0-9a-f]+$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
/** Header values must be printable and single-line, so they survive any broker's header encoding untouched. */
const VALUE_RE = /^[\x20-\x7e]*$/;

export const hostSource = (instanceId: string) => `landflow://host/${instanceId}`;
export const pluginSource = (pluginId: string, instanceId: string) => `landflow://plugin/${pluginId}/${instanceId}`;

/** `pluginId` and `instanceId` of a `landflow://plugin/…` source; `undefined` for a host source. */
export function parsePluginSource(source: string): { pluginId: string; instanceId: string } | undefined {
  const match = /^landflow:\/\/plugin\/([^/]+)\/([^/]+)$/.exec(source);
  return match ? { pluginId: match[1], instanceId: match[2] } : undefined;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Strict attribute validation: every required attribute present and well-formed, every known optional one well-formed,
 * values printable ASCII. Unknown attributes are dropped (`strict: true` refuses them instead, for tests).
 */
export function validateAttributes(input: Record<string, string | undefined>, options: { strict?: boolean } = {}): Attributes {
  const bad = (name: string, why = 'is malformed') => new EnvelopeError(`attribute "${name}" ${why}`, 'malformed');
  const str = (name: AttributeName, required: boolean, re?: RegExp, max = 4096): string | undefined => {
    const value = input[name];
    if (value === undefined || value === '') {
      if (required) throw bad(name, 'is required');
      return undefined;
    }
    if (typeof value !== 'string' || value.length > max || !VALUE_RE.test(value)) throw bad(name);
    if (re && !re.test(value)) throw bad(name);
    return value;
  };
  if (options.strict) for (const name of Object.keys(input)) if (!(KNOWN_ATTRIBUTES as readonly string[]).includes(name)) throw bad(name, 'is not a known attribute');
  const specversion = str('specversion', true);
  if (specversion !== CE_SPECVERSION) throw new EnvelopeError(`specversion "${specversion}" is not supported`, 'unsupported');
  const type = str('type', true, TYPE_RE)!;
  if (!parseType(type)) throw new EnvelopeError(`type "${type}" is not supported`, 'unsupported');
  const datacontenttype = str('datacontenttype', true)!;
  if (datacontenttype !== JSON_CONTENT_TYPE && datacontenttype !== ENCRYPTED_CONTENT_TYPE) throw new EnvelopeError(`datacontenttype "${datacontenttype}" is not supported`, 'unsupported');
  const lfdelivery = str('lfdelivery', false);
  if (lfdelivery !== undefined && lfdelivery !== 'at-most-once' && lfdelivery !== 'at-least-once') throw bad('lfdelivery');
  const lfenc = str('lfenc', false);
  if (lfenc !== undefined && lfenc !== 'aes-256-gcm') throw new EnvelopeError(`lfenc "${lfenc}" is not supported`, 'unsupported');
  if ((lfenc !== undefined) !== (datacontenttype === ENCRYPTED_CONTENT_TYPE)) throw bad('lfenc', 'does not match datacontenttype');
  const lferror = str('lferror', false, /^[a-z_]{1,32}$/);
  const attributes: Attributes = {
    specversion: '1.0',
    id: str('id', true, ID_RE)!,
    source: str('source', true, SOURCE_RE)!,
    type,
    time: str('time', true, TIME_RE)!,
    datacontenttype,
  };
  const optional: [AttributeName, RegExp | undefined, number?][] = [
    ['subject', /^[A-Za-z0-9._:-]{1,256}$/],
    ['traceparent', /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/],
    ['tracestate', undefined, 1024],
    ['lfreplyto', /^[A-Za-z0-9._-]{1,256}$/],
    ['lfcorrelation', ID_RE],
    ['lfdeadline', DIGITS_RE],
    ['lfattempt', /^\d{1,6}$/],
    ['lfidempotency', /^[\x21-\x7e]{1,256}$/],
    ['lfmanifest', /^[0-9a-f]{8,64}$/],
    ['lfkeyid', /^[0-9a-f]{8,32}$/],
    ['lfsig', /^[0-9a-f]{64}$/],
  ];
  for (const [name, re, max] of optional) {
    const value = str(name, false, re, max);
    if (value !== undefined) (attributes as unknown as Record<string, string>)[name] = value;
  }
  if (lfdelivery) attributes.lfdelivery = lfdelivery;
  if (lfenc) attributes.lfenc = 'aes-256-gcm';
  if (lferror) attributes.lferror = lferror as RemoteErrorCode;
  if (attributes.lfsig && !HEX_RE.test(attributes.lfsig)) throw bad('lfsig');
  return attributes;
}

/** The attributes as wire headers (strings), without undefined values. */
export function attributesToHeaders(attributes: Attributes): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of KNOWN_ATTRIBUTES) {
    const value = (attributes as unknown as Record<string, string | undefined>)[name];
    if (value !== undefined) headers[name] = value;
  }
  return headers;
}

export interface EncodeOptions {
  /** `binary` (headers) or `structured` (one JSON document). The core picks from `capabilities.headers`. */
  mode: 'binary' | 'structured';
}

/** Encode a raw event (attributes + body bytes, already encrypted/signed) for the wire. */
export function encodeWire(event: RawEvent, options: EncodeOptions): { wire: WireEvent; size: WireSize } {
  const headers = attributesToHeaders(event.attributes);
  if (options.mode === 'binary') {
    headers['content-type'] = event.attributes.datacontenttype;
    const wire = { headers, body: event.body };
    return { wire, size: sizeOf(wire) };
  }
  const document: Record<string, unknown> = { ...headers };
  if (event.attributes.lfenc) document.data_base64 = Buffer.from(event.body).toString('base64');
  else document.data = event.body.byteLength === 0 ? null : JSON.parse(decoder.decode(event.body));
  const wire = { headers: { 'content-type': STRUCTURED_CONTENT_TYPE }, body: encoder.encode(JSON.stringify(document)) };
  return { wire, size: sizeOf(wire) };
}

/** Headers + body bytes of a wire event (header names and values as UTF-8). */
export function sizeOf(wire: WireEvent): WireSize {
  let headerBytes = 0;
  for (const [name, value] of Object.entries(wire.headers)) headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
  return { headerBytes, bodyBytes: wire.body.byteLength, totalBytes: headerBytes + wire.body.byteLength };
}

export interface DecodeOptions {
  /** Refuse events bigger than this (the driver's `maxMessageBytes`, or a core-side ceiling). */
  maxBytes?: number;
  strict?: boolean;
}

/**
 * Decode a wire event in either mode (binary when the headers carry `specversion`, structured otherwise) into attributes
 * and body bytes, validating strictly. Throws `EnvelopeError`; the core drops such events and counts them.
 */
export function decodeWire(wire: WireEvent, options: DecodeOptions = {}): RawEvent {
  const size = sizeOf(wire);
  if (options.maxBytes !== undefined && size.totalBytes > options.maxBytes) throw new EnvelopeError(`event is ${size.totalBytes} bytes, over the limit of ${options.maxBytes}`, 'too_large');
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(wire.headers)) headers[name.toLowerCase()] = value;
  if (headers.specversion !== undefined) {
    const { 'content-type': contentType, ...rest } = headers;
    const attributes = validateAttributes(rest, options);
    if (contentType !== undefined && contentType.split(';')[0].trim() !== attributes.datacontenttype) throw new EnvelopeError('content-type does not match datacontenttype', 'malformed');
    return { attributes, body: wire.body };
  }
  if (headers['content-type'] !== undefined && !headers['content-type'].startsWith('application/cloudevents+json')) throw new EnvelopeError(`content-type "${headers['content-type']}" is not a CloudEvents document`, 'unsupported');
  let document: unknown;
  try {
    document = JSON.parse(decoder.decode(wire.body));
  } catch {
    throw new EnvelopeError('structured event is not valid JSON', 'malformed');
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new EnvelopeError('structured event is not a JSON object', 'malformed');
  const { data, data_base64: dataBase64, ...rest } = document as Record<string, unknown>;
  for (const [name, value] of Object.entries(rest)) if (typeof value !== 'string') throw new EnvelopeError(`attribute "${name}" is not a string`, 'malformed');
  const attributes = validateAttributes(rest as Record<string, string>, options);
  let body: Uint8Array;
  if (attributes.lfenc) {
    if (typeof dataBase64 !== 'string' || data !== undefined) throw new EnvelopeError('an encrypted structured event carries data_base64 only', 'malformed');
    body = new Uint8Array(Buffer.from(dataBase64, 'base64'));
  } else {
    if (dataBase64 !== undefined) throw new EnvelopeError('a plain structured event carries data, not data_base64', 'malformed');
    body = data === undefined || data === null ? new Uint8Array() : encoder.encode(JSON.stringify(data));
  }
  return { attributes, body };
}

/** Parse a plain (decrypted) body as JSON; an empty body is `null`. */
export function parseBody(body: Uint8Array): JsonValue {
  if (body.byteLength === 0) return null;
  try {
    return JSON.parse(decoder.decode(body)) as JsonValue;
  } catch {
    throw new EnvelopeError('body is not valid JSON', 'malformed');
  }
}

export const serializeBody = (data: JsonValue): Uint8Array => encoder.encode(JSON.stringify(data));

/** Make a fresh event id: 32 hex characters (128 random bits). */
export function newEventId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('hex');
}

/** `node.type` of an Execute/webhook body, or the `nodeType` of LoadOptions: the event's `subject`. */
export function subjectOf(method: Method, body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  if (method === 'LoadOptions') return typeof record.nodeType === 'string' ? record.nodeType : undefined;
  const node = record.node as Record<string, unknown> | undefined;
  return node && typeof node.type === 'string' ? node.type : undefined;
}
