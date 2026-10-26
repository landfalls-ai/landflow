/**
 * The codec the core uses on both sides: picks the CloudEvents mode from the driver's capabilities, seals (encrypts and
 * signs) outgoing events, and decodes, verifies and decrypts incoming ones.
 */
import type { JsonValue } from '@landflow/protocol';
import type { BrokerCapabilities, WireEvent } from './driver';
import { decodeWire, encodeWire, EnvelopeError, newEventId, parseBody, serializeBody, type Attributes, type RawEvent, type WireSize } from './envelope';
import { claimKeyFor, ClaimError, CLAIM_KEY_RE, sha256Hex, type ClaimStore } from './claim';
import { open, ReplayGuard, seal, SecurityError, verifyClaimed, withClaim, type Keyring } from './security';

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
  /** When set, an event that does not fit the broker goes by reference through this store (the claim check). */
  claims?: ClaimStore;
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

  /**
   * Like `pack()`, but an encrypted event that does not fit the broker's limits is stored in the claim store and sent by
   * reference (`claimKey` says where; the caller deletes it when the call fails). Without a store, or when even the
   * reference does not fit, it throws `too_large` exactly like `pack()`.
   */
  async packClaimed(pluginId: string, attributes: Attributes, data: JsonValue, encrypt: boolean): Promise<PackedEvent & { claimKey?: string }> {
    const claims = this.options.claims;
    if (!claims || !encrypt) return this.pack(pluginId, attributes, data, encrypt);
    const sealed = seal(this.keyring, pluginId, { attributes, body: serializeBody(data) }, { encrypt });
    const plain = encodeWire(sealed, { mode: this.mode });
    if (this.fits(plain.size)) return { attributes: sealed.attributes, wire: plain.wire, size: plain.size };
    const key = claimKeyFor(this.options.now?.() ?? Date.now(), sealed.attributes.id);
    const claimed = withClaim(this.keyring, pluginId, sealed, key);
    const { wire, size } = encodeWire({ attributes: claimed.attributes, body: new Uint8Array() }, { mode: this.mode });
    const { maxMessageBytes, maxHeaderBytes } = this.capabilities;
    if (!this.fits(size)) throw new EnvelopeError(`even by reference the event is ${size.totalBytes} bytes (headers ${size.headerBytes}); the broker takes at most ${maxMessageBytes}${maxHeaderBytes !== undefined ? ` (headers ${maxHeaderBytes})` : ''}`, 'too_large');
    try {
      await claims.put(key, claimed.body);
    } catch (error) {
      throw new ClaimError(`could not store the ${claimed.body.byteLength}-byte body in the claim store: ${(error as Error).message}`, 'store');
    }
    return { attributes: claimed.attributes, wire, size, claimKey: key };
  }

  private fits(size: WireSize): boolean {
    const { maxMessageBytes, maxHeaderBytes } = this.capabilities;
    return size.totalBytes <= maxMessageBytes && (maxHeaderBytes === undefined || size.headerBytes <= maxHeaderBytes);
  }

  /**
   * An event with `lfclaim` carries no body: check its signature (the body's digest is `lfclaimsha256`), fetch the body and
   * check its size and digest. Returns the event with its body, or throws `SecurityError` (bad signature: drop it) or
   * `ClaimError` (store down, object missing or wrong: the sender can be told). Events without a claim pass through.
   */
  async resolveClaim(raw: RawEvent, pluginId: string): Promise<{ raw: RawEvent; claimKey?: string }> {
    const { attributes } = raw;
    if (!attributes.lfclaim) return { raw };
    verifyClaimed(this.keyring, pluginId, attributes);
    const claims = this.options.claims;
    if (!claims) throw new ClaimError('the event carries its body in a claim store and none is configured here (LANDFLOW_CLAIM_STORE)', 'invalid');
    if (raw.body.byteLength !== 0 || !CLAIM_KEY_RE.test(attributes.lfclaim)) throw new ClaimError('malformed claim reference', 'invalid');
    let body: Uint8Array | undefined;
    try {
      body = await claims.get(attributes.lfclaim);
    } catch (error) {
      throw new ClaimError(`could not fetch the claim ${attributes.lfclaim}: ${(error as Error).message}`, 'store');
    }
    if (!body) throw new ClaimError(`the claim ${attributes.lfclaim} is gone (expired or already deleted)`, 'missing');
    if (body.byteLength !== Number(attributes.lfclaimsize)) throw new ClaimError(`the claim ${attributes.lfclaim} is ${body.byteLength} bytes, not the ${attributes.lfclaimsize} announced`, 'size');
    if (sha256Hex(body) !== attributes.lfclaimsha256) throw new ClaimError(`the claim ${attributes.lfclaim} does not match its digest`, 'digest');
    return { raw: { attributes, body }, claimKey: attributes.lfclaim };
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
