/**
 * A software WebAuthn authenticator for tests (C16 / P15b): an ES256 key from `node:crypto`, CBOR from
 * `@simplewebauthn/server/helpers`. It makes a `none` attestation on `create` and a signed assertion on `get`, for the
 * origin and relying party it is told, with a signature counter the test can set (to play a cloned key).
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';

const b64 = (bytes: Uint8Array) => isoBase64URL.fromBuffer(bytes);
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest();

export interface CreateOptions {
  challenge: string;
  rp: { id?: string };
}
export interface GetOptions {
  challenge: string;
  rpId?: string;
  allowCredentials?: Array<{ id: string }>;
}

export class FakeAuthenticator {
  readonly credentialId = randomBytes(32);
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  /** The counter the next assertion reports; `undefined` keeps counting up by one, `0` plays an authenticator that has none. */
  counter = 0;
  countsUp = true;

  constructor(readonly origin = 'http://localhost:3000', readonly rpId = 'localhost') {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  get id(): string {
    return b64(this.credentialId);
  }

  private coseKey(): Uint8Array {
    const jwk = this.publicKey.export({ format: 'jwk' });
    return isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x!, 'base64url'))], [-3, new Uint8Array(Buffer.from(jwk.y!, 'base64url'))]]));
  }

  private authData(rpId: string, withKey: boolean, flags = 0x01 | 0x04): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const head = Buffer.concat([sha256(rpId), Buffer.from([flags | (withKey ? 0x40 : 0)]), counter]);
    if (!withKey) return head;
    const length = Buffer.alloc(2);
    length.writeUInt16BE(this.credentialId.length);
    return Buffer.concat([head, Buffer.alloc(16), length, this.credentialId, Buffer.from(this.coseKey())]);
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** A registration response with `none` attestation; `origin` and `rpId` can be wrong on purpose. */
  create(options: CreateOptions, over: { origin?: string; rpId?: string } = {}) {
    const clientData = this.clientData('webauthn.create', options.challenge, over.origin ?? this.origin);
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(this.authData(over.rpId ?? options.rp.id ?? this.rpId, true))]]) as never);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: { clientDataJSON: b64(clientData), attestationObject: b64(attestationObject), transports: ['internal' as const] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform' as const,
    };
  }

  /** An assertion over the challenge; `counter` overrides what is reported (and sticks). */
  get(options: GetOptions, over: { origin?: string; rpId?: string; counter?: number } = {}) {
    if (over.counter !== undefined) this.counter = over.counter;
    else if (this.countsUp) this.counter += 1;
    const clientData = this.clientData('webauthn.get', options.challenge, over.origin ?? this.origin);
    const authData = this.authData(over.rpId ?? options.rpId ?? this.rpId, false);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(signature) },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform' as const,
    };
  }
}
