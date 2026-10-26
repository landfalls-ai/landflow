/**
 * Security over brokers (docs/transports.md "Security over brokers", docs/protocol.md §14).
 *
 * **Keys.** One shared secret, `LANDFLOW_TRANSPORT_SECRET` (falling back to `LANDFLOW_REGISTRY_SECRET`), known to the host
 * and to every plugin. Per plugin, two 32-byte keys come from HKDF-SHA256 over it (no salt):
 *
 *     encKey = HKDF-SHA256(secret, info = "landflow transport v1\n" + pluginId + "\nenc", 32 bytes)
 *     sigKey = HKDF-SHA256(secret, info = "landflow transport v1\n" + pluginId + "\nsig", 32 bytes)
 *
 * Every replica of a plugin derives the same keys, so work sharing works; whoever reads the broker learns nothing. A key
 * id, `lfkeyid = hex(SHA-256("landflow transport keyid v1\n" + secret))[0..16]`, travels with each event so a receiver
 * with several secrets (rotation: `LANDFLOW_TRANSPORT_SECRET_PREVIOUS`, comma-separated) picks the right one.
 *
 * **Encryption.** The whole body of every request and response is encrypted, not only the credentials: AES-256-GCM with
 * a random 96-bit nonce, `body = nonce ‖ ciphertext ‖ tag`, additional data `id + "\n" + type`. Why the whole body: the
 * credentials sit in different places per method (`credentials` in Execute, `data` in TestCredentials) and are easy to
 * miss in a new field; the items themselves hold personal data (an SMS text, a phone number) that should not sit on a
 * disk-backed broker either; the cost is one AES pass over bytes that were JSON-serialised anyway; and the attributes
 * (type, subject, ids, deadline) stay in clear, so routing, tracing and archiving by metadata keep working. Announce,
 * withdraw and cancel bodies hold no secrets and stay plain so that broker-side tooling can read the registry channel.
 *
 * **Signing.** Every event carries `lfsig = hex(HMAC-SHA256(sigKey, canonical))`, encrypt-then-MAC. The canonical form is
 * one line per attribute present, in `KNOWN_ATTRIBUTES` order and excluding `lfsig`, `name=value\n`, followed by
 * `hex(SHA-256(body))\n`, where `body` is the on-wire bytes (ciphertext when encrypted). Unknown attributes are never
 * signed, so a receiver drops them before verifying. A receiver refuses unsigned events, unknown key ids, bad signatures,
 * a `time` farther than `clockSkewMs` from its clock, and ids it has already accepted inside the replay window.
 *
 * **Registry proofs.** An announce also carries `registryProof = hex(HMAC-SHA256(LANDFLOW_REGISTRY_SECRET,
 * "landflow-registry-proof/v1\n" + pluginId + "\n" + <event id>))`, the protocol §13 format with the event id as the
 * challenge; the host checks it when it has the registry secret.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { ENCRYPTED_CONTENT_TYPE, JSON_CONTENT_TYPE, KNOWN_ATTRIBUTES, type Attributes, type RawEvent } from './envelope';

export const TRANSPORT_SECRET_ENV = 'LANDFLOW_TRANSPORT_SECRET';
export const TRANSPORT_SECRET_PREVIOUS_ENV = 'LANDFLOW_TRANSPORT_SECRET_PREVIOUS';
export const REGISTRY_SECRET_ENV = 'LANDFLOW_REGISTRY_SECRET';
export const HKDF_INFO_PREFIX = 'landflow transport v1';
const KEY_ID_PREFIX = 'landflow transport keyid v1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** A clock difference between sender and receiver up to this is tolerated. */
export const DEFAULT_CLOCK_SKEW_MS = 5 * 60_000;

export type SecurityReason = 'unsigned' | 'unknown_key' | 'bad_signature' | 'clock_skew' | 'replay' | 'decrypt_failed' | 'wrong_plugin';

/** A received event failed verification. The core drops the event (and nacks without requeue), never processes it. */
export class SecurityError extends Error {
  constructor(
    message: string,
    readonly reason: SecurityReason,
  ) {
    super(message);
    this.name = 'SecurityError';
  }
}

/** Messaging cannot start without a secret. */
export class MissingSecretError extends Error {
  constructor() {
    super(`messaging over brokers needs a shared secret: set ${TRANSPORT_SECRET_ENV} (or ${REGISTRY_SECRET_ENV}) to the same value on the host and on every plugin`);
    this.name = 'MissingSecretError';
  }
}

export interface DerivedKeys {
  keyId: string;
  enc: Buffer;
  sig: Buffer;
}

export const keyIdOf = (secret: string): string => createHash('sha256').update(`${KEY_ID_PREFIX}\n${secret}`).digest('hex').slice(0, 16);

export function deriveKeys(secret: string, pluginId: string): DerivedKeys {
  const derive = (purpose: 'enc' | 'sig') => Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), `${HKDF_INFO_PREFIX}\n${pluginId}\n${purpose}`, 32));
  return { keyId: keyIdOf(secret), enc: derive('enc'), sig: derive('sig') };
}

/**
 * The secrets a process holds: one current (signs and encrypts) and any number of previous ones (verify and decrypt only).
 * Derived keys are cached per plugin.
 */
export class Keyring {
  private readonly secrets = new Map<string, string>();
  private readonly cache = new Map<string, DerivedKeys>();
  readonly currentKeyId: string;

  constructor(current: string, previous: string[] = []) {
    if (!current) throw new MissingSecretError();
    this.currentKeyId = keyIdOf(current);
    this.secrets.set(this.currentKeyId, current);
    for (const secret of previous) if (secret) this.secrets.set(keyIdOf(secret), secret);
  }

  /** From `LANDFLOW_TRANSPORT_SECRET` (else `LANDFLOW_REGISTRY_SECRET`) and `LANDFLOW_TRANSPORT_SECRET_PREVIOUS`; throws `MissingSecretError`. */
  static fromEnv(env: Record<string, string | undefined> = process.env): Keyring {
    const current = env[TRANSPORT_SECRET_ENV] || env[REGISTRY_SECRET_ENV];
    if (!current) throw new MissingSecretError();
    const previous = (env[TRANSPORT_SECRET_PREVIOUS_ENV] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return new Keyring(current, previous);
  }

  has(keyId: string): boolean {
    return this.secrets.has(keyId);
  }

  /** The keys for `pluginId` under `keyId` (default: the current key); undefined for an unknown key id. */
  keys(pluginId: string, keyId = this.currentKeyId): DerivedKeys | undefined {
    const secret = this.secrets.get(keyId);
    if (!secret) return undefined;
    const cacheKey = `${keyId}\n${pluginId}`;
    let keys = this.cache.get(cacheKey);
    if (!keys) {
      keys = deriveKeys(secret, pluginId);
      this.cache.set(cacheKey, keys);
    }
    return keys;
  }
}

export const canonicalFormWithDigest = (attributes: Attributes, bodyDigestHex: string): string => {
  let out = '';
  for (const name of KNOWN_ATTRIBUTES) {
    if (name === 'lfsig') continue;
    const value = (attributes as unknown as Record<string, string | undefined>)[name];
    if (value !== undefined) out += `${name}=${value}\n`;
  }
  return out + bodyDigestHex + '\n';
};

export const canonicalForm = (attributes: Attributes, body: Uint8Array): string => canonicalFormWithDigest(attributes, createHash('sha256').update(body).digest('hex'));

export const signature = (sigKey: Buffer, attributes: Attributes, body: Uint8Array): string => createHmac('sha256', sigKey).update(canonicalForm(attributes, body)).digest('hex');

const aad = (attributes: Attributes) => Buffer.from(`${attributes.id}\n${attributes.type}`, 'utf8');

export function encryptBody(encKey: Buffer, attributes: Attributes, plaintext: Uint8Array, nonce: Buffer = randomBytes(NONCE_BYTES)): Uint8Array {
  const cipher = createCipheriv('aes-256-gcm', encKey, nonce);
  cipher.setAAD(aad(attributes));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return new Uint8Array(Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]));
}

export function decryptBody(encKey: Buffer, attributes: Attributes, sealed: Uint8Array): Uint8Array {
  if (sealed.byteLength < NONCE_BYTES + TAG_BYTES) throw new SecurityError('encrypted body is too short', 'decrypt_failed');
  const buffer = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  const decipher = createDecipheriv('aes-256-gcm', encKey, buffer.subarray(0, NONCE_BYTES));
  decipher.setAAD(aad(attributes));
  decipher.setAuthTag(buffer.subarray(buffer.length - TAG_BYTES));
  try {
    return new Uint8Array(Buffer.concat([decipher.update(buffer.subarray(NONCE_BYTES, buffer.length - TAG_BYTES)), decipher.final()]));
  } catch {
    throw new SecurityError('encrypted body does not decrypt (wrong key or tampered)', 'decrypt_failed');
  }
}

/** Remembers accepted event ids for a window, so a replayed event is refused. Sweeps lazily. */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();
  constructor(
    readonly windowMs = DEFAULT_CLOCK_SKEW_MS * 2,
    private readonly maxEntries = 100_000,
  ) {}

  /** `true` the first time an id is seen inside the window; `false` for a replay. */
  accept(id: string, now = Date.now()): boolean {
    this.sweep(now);
    if (this.seen.has(id)) return false;
    this.seen.set(id, now + this.windowMs);
    return true;
  }

  /** Forget an id (the core nacked the event without using it, so a redelivery is legitimate). */
  forget(id: string): void {
    this.seen.delete(id);
  }

  get size(): number {
    return this.seen.size;
  }

  private sweep(now: number): void {
    if (this.seen.size < this.maxEntries) {
      // Cheap amortised sweep: look at the oldest entries only.
      let budget = 16;
      for (const [id, expires] of this.seen) {
        if (expires > now || budget-- <= 0) break;
        this.seen.delete(id);
      }
      return;
    }
    for (const [id, expires] of this.seen) if (expires <= now) this.seen.delete(id);
    // Still full: drop the oldest half rather than refuse new traffic.
    if (this.seen.size >= this.maxEntries) for (const id of [...this.seen.keys()].slice(0, this.maxEntries / 2)) this.seen.delete(id);
  }
}

export interface SealOptions {
  /** Encrypt the body (requests and responses). Announce, withdraw and cancel bodies stay plain. */
  encrypt: boolean;
  /** Test hook: a fixed nonce for known-answer vectors. */
  nonce?: Buffer;
}

/** Encrypt (optionally) and sign a plain event under `pluginId`'s current keys. Returns a new event; the input is not changed. */
export function seal(keyring: Keyring, pluginId: string, event: RawEvent, options: SealOptions): RawEvent {
  const keys = keyring.keys(pluginId)!;
  const attributes: Attributes = { ...event.attributes, lfkeyid: keys.keyId };
  delete attributes.lfsig;
  let body = event.body;
  if (options.encrypt) {
    attributes.lfenc = 'aes-256-gcm';
    attributes.datacontenttype = ENCRYPTED_CONTENT_TYPE;
    body = encryptBody(keys.enc, attributes, event.body, options.nonce);
  } else {
    delete attributes.lfenc;
    attributes.datacontenttype = JSON_CONTENT_TYPE;
  }
  attributes.lfsig = signature(keys.sig, attributes, body);
  return { attributes, body };
}

/**
 * Add the claim-check attributes for `key` to a sealed event whose (encrypted) body is `event.body`, and sign again. The
 * returned event keeps the full body (the caller stores it and sends an empty one): the signature covers the body's digest
 * either way, since `lfclaimsha256` is that digest.
 */
export function withClaim(keyring: Keyring, pluginId: string, event: RawEvent, key: string): RawEvent {
  const keys = keyring.keys(pluginId)!;
  const attributes: Attributes = { ...event.attributes, lfclaim: key, lfclaimsize: String(event.body.byteLength), lfclaimsha256: createHash('sha256').update(event.body).digest('hex') };
  attributes.lfsig = signature(keys.sig, attributes, event.body);
  return { attributes, body: event.body };
}

/**
 * Verify the signature of an event whose body is still in the claim store, without fetching it: the canonical form ends in
 * the body's digest, which `lfclaimsha256` gives. Checks the signature only (`open()` does the rest once the body is here).
 */
export function verifyClaimed(keyring: Keyring, pluginId: string, attributes: Attributes): void {
  if (!attributes.lfsig || !attributes.lfkeyid || !attributes.lfclaimsha256) throw new SecurityError(`event ${attributes.id} is not signed`, 'unsigned');
  const keys = keyring.keys(pluginId, attributes.lfkeyid);
  if (!keys) throw new SecurityError(`event ${attributes.id} is signed with unknown key ${attributes.lfkeyid}`, 'unknown_key');
  const canonical = canonicalFormWithDigest(attributes, attributes.lfclaimsha256);
  const expected = createHmac('sha256', keys.sig).update(canonical).digest();
  const given = Buffer.from(attributes.lfsig, 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new SecurityError(`event ${attributes.id} has a bad signature`, 'bad_signature');
}

export interface OpenOptions {
  now?: number;
  clockSkewMs?: number;
  /** When given, ids already accepted are refused as replays. */
  replay?: ReplayGuard;
}

/**
 * Verify a received event under `pluginId`'s keys and decrypt its body. Throws `SecurityError`; on success the returned
 * event has a plain JSON body and the attributes as received (`lfsig`, `lfkeyid`, `lfenc` included, for logging).
 */
export function open(keyring: Keyring, pluginId: string, event: RawEvent, options: OpenOptions = {}): RawEvent {
  const { attributes } = event;
  if (!attributes.lfsig || !attributes.lfkeyid) throw new SecurityError(`event ${attributes.id} is not signed`, 'unsigned');
  const keys = keyring.keys(pluginId, attributes.lfkeyid);
  if (!keys) throw new SecurityError(`event ${attributes.id} is signed with unknown key ${attributes.lfkeyid}`, 'unknown_key');
  const expected = Buffer.from(signature(keys.sig, attributes, event.body), 'hex');
  const given = Buffer.from(attributes.lfsig, 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new SecurityError(`event ${attributes.id} has a bad signature`, 'bad_signature');
  const now = options.now ?? Date.now();
  const sent = Date.parse(attributes.time);
  const skew = options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  if (Number.isNaN(sent) || Math.abs(now - sent) > skew) throw new SecurityError(`event ${attributes.id} was sent at ${attributes.time}, outside the ${skew} ms clock-skew window`, 'clock_skew');
  if (options.replay && !options.replay.accept(attributes.id, now)) throw new SecurityError(`event ${attributes.id} was already received (replay)`, 'replay');
  const body = attributes.lfenc ? decryptBody(keys.enc, attributes, event.body) : event.body;
  return { attributes, body };
}

/** Protocol §13 proof: hex HMAC-SHA256 of `landflow-registry-proof/v1\n<pluginId>\n<challenge>`, keyed with the registry secret. */
export const registryProof = (secret: string, pluginId: string, challenge: string): string =>
  createHmac('sha256', secret).update(`landflow-registry-proof/v1\n${pluginId}\n${challenge}`).digest('hex');

export function verifyRegistryProof(secret: string, pluginId: string, challenge: string, proof: string | undefined): boolean {
  if (!proof || !/^[0-9a-f]{64}$/i.test(proof)) return false;
  return timingSafeEqual(Buffer.from(registryProof(secret, pluginId, challenge), 'hex'), Buffer.from(proof, 'hex'));
}
