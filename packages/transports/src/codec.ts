/**
 * The codec the core uses on both sides: picks the CloudEvents mode from the driver's capabilities, seals (encrypts and
 * signs) outgoing events, and decodes, verifies and decrypts incoming ones.
 */
import type { JsonValue } from '@landflow/protocol';
import type { BrokerCapabilities, WireEvent } from './driver';
import { decodeWire, encodeWire, EnvelopeError, newEventId, parseBody, serializeBody, type Attributes, type RawEvent, type WireSize } from './envelope';
import { open, ReplayGuard, seal, SecurityError, type Keyring } from './security';

export type Logger = (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;

export const silentLogger: Logger = () => {};

/** Console logger with the `[landflow]` prefix the SDK uses. */
export const consoleLogger: Logger = (level, message, fields) => {
  const line = `[landflow:messaging] ${message}${fields ? ' ' + JSON.stringify(fields) : ''}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

export interface PackedEvent {
  attributes: Attributes;
  wire: WireEvent;
  size: WireSize;
}

export interface CodecOptions {
  clockSkewMs?: number;
  /** Replay protection for received events; the server uses one, the client none (replies correlate to pending calls). */
  replay?: ReplayGuard;
  now?: () => number;
}

export class Codec {
  readonly mode: 'binary' | 'structured';

  constructor(
    private readonly keyring: Keyring,
    private readonly capabilities: BrokerCapabilities,
    private readonly options: CodecOptions = {},
  ) {
    this.mode = capabilities.headers ? 'binary' : 'structured';
  }

  /** Attributes every event starts from. */
  base(source: string, type: string, extra: Partial<Attributes> = {}): Attributes {
    const now = this.options.now?.() ?? Date.now();
    return { specversion: '1.0', id: newEventId(), source, type, time: new Date(now).toISOString(), datacontenttype: 'application/json', ...extra };
  }

  /** Serialise, seal under `pluginId`'s key and encode. Checks the broker's size limits and throws `EnvelopeError('too_large')`. */
  pack(pluginId: string, attributes: Attributes, data: JsonValue, encrypt: boolean): PackedEvent {
    const sealed = seal(this.keyring, pluginId, { attributes, body: serializeBody(data) }, { encrypt });
    const { wire, size } = encodeWire(sealed, { mode: this.mode });
    const { maxMessageBytes, maxHeaderBytes } = this.capabilities;
    if (size.totalBytes > maxMessageBytes) throw new EnvelopeError(`event is ${size.totalBytes} bytes; the broker takes at most ${maxMessageBytes}`, 'too_large');
    if (maxHeaderBytes !== undefined && size.headerBytes > maxHeaderBytes) throw new EnvelopeError(`event headers are ${size.headerBytes} bytes; the broker takes at most ${maxHeaderBytes}`, 'too_large');
    return { attributes: sealed.attributes, wire, size };
  }

  /** Decode without verifying: the attributes are needed to know which plugin's key applies. */
  peek(wire: WireEvent): RawEvent {
    return decodeWire(wire, { maxBytes: this.capabilities.maxMessageBytes });
  }

  /** The event was not consumed after all (put back for another consumer): let its id through again. */
  forgetReplay(id: string): void {
    this.options.replay?.forget(id);
  }

  /** Verify a peeked event under `pluginId`'s key and parse its body. */
  unpack(raw: RawEvent, pluginId: string, replay = this.options.replay): { attributes: Attributes; data: JsonValue } {
    const opened = open(this.keyring, pluginId, raw, { clockSkewMs: this.options.clockSkewMs, replay, now: this.options.now?.() });
    return { attributes: opened.attributes, data: parseBody(opened.body) };
  }
}

export const isDropReason = (error: unknown): error is EnvelopeError | SecurityError => error instanceof EnvelopeError || error instanceof SecurityError;
