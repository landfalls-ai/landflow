/**
 * Known-answer vectors for key derivation, signing, encryption and registry proofs (the Go core checks the same values),
 * plus the refusals: unsigned, tampered, unknown key, clock skew, replay.
 */
import { describe, expect, it } from 'vitest';
import { serializeBody, type Attributes } from '../src/envelope';
import {
  canonicalForm,
  decryptBody,
  deriveKeys,
  encryptBody,
  keyIdOf,
  Keyring,
  MissingSecretError,
  open,
  registryProof,
  ReplayGuard,
  seal,
  SecurityError,
  verifyRegistryProof,
} from '../src/security';

const SECRET = 'transport-s3cret';
const PLUGIN = 'test-plugin';
const attributes = (): Attributes => ({
  specversion: '1.0',
  id: 'call-1',
  source: 'landflow://host/h1',
  type: 'dev.landflow.plugin.v1.health.request',
  time: '2026-10-26T12:00:00.000Z',
  datacontenttype: 'application/json',
  lfreplyto: 'landflow.v1.reply.h1',
  lfdeadline: '1793102430000',
  lfattempt: '1',
  lfdelivery: 'at-least-once',
});
const NOW = Date.parse('2026-10-26T12:00:01.000Z');

describe('key derivation', () => {
  it('derives the key id and the per-plugin keys (vectors)', () => {
    expect(keyIdOf(SECRET)).toBe('9a5c85f5715d1126');
    const keys = deriveKeys(SECRET, PLUGIN);
    expect(keys.keyId).toBe('9a5c85f5715d1126');
    expect(keys.enc.toString('hex')).toBe('0c16cc20dcdd656ccb50880e4ff8abe53e936a69254e70ca38b2f3ce340e1648');
    expect(keys.sig.toString('hex')).toBe('cfcefdc42b585afb5a42bbd8637d106e26a91b7159c19dec14a5d3d038c5308c');
    expect(deriveKeys(SECRET, 'other-plugin').enc.toString('hex')).not.toBe(keys.enc.toString('hex'));
  });

  it('reads the secret from the environment, falling back to the registry secret, with previous keys for rotation', () => {
    expect(() => Keyring.fromEnv({})).toThrow(MissingSecretError);
    expect(Keyring.fromEnv({ LANDFLOW_REGISTRY_SECRET: 'r' }).currentKeyId).toBe(keyIdOf('r'));
    const ring = Keyring.fromEnv({ LANDFLOW_TRANSPORT_SECRET: 't', LANDFLOW_REGISTRY_SECRET: 'r', LANDFLOW_TRANSPORT_SECRET_PREVIOUS: 'p1, p2' });
    expect(ring.currentKeyId).toBe(keyIdOf('t'));
    expect(ring.has(keyIdOf('p1'))).toBe(true);
    expect(ring.has(keyIdOf('p2'))).toBe(true);
    expect(ring.has(keyIdOf('r'))).toBe(false);
    expect(() => new Keyring('')).toThrow(MissingSecretError);
  });
});

describe('signing', () => {
  it('signs the canonical form of the attributes plus the body digest (vector)', () => {
    const ring = new Keyring(SECRET);
    const sealed = seal(ring, PLUGIN, { attributes: attributes(), body: serializeBody({}) }, { encrypt: false });
    expect(canonicalForm(sealed.attributes, sealed.body)).toBe(
      'specversion=1.0\nid=call-1\nsource=landflow://host/h1\ntype=dev.landflow.plugin.v1.health.request\ntime=2026-10-26T12:00:00.000Z\n' +
        'datacontenttype=application/json\nlfreplyto=landflow.v1.reply.h1\nlfdeadline=1793102430000\nlfattempt=1\nlfdelivery=at-least-once\nlfkeyid=9a5c85f5715d1126\n' +
        '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a\n',
    );
    expect(sealed.attributes.lfsig).toBe('6f4f5b0e15bf654e1d2999781cfa3b22198d8ead69df6ba6d8f548f438cd3c56');
    expect(sealed.attributes.lfkeyid).toBe('9a5c85f5715d1126');
    expect(sealed.attributes.lfenc).toBeUndefined();
    const opened = open(ring, PLUGIN, sealed, { now: NOW });
    expect(Buffer.from(opened.body).toString()).toBe('{}');
  });

  it('refuses unsigned, tampered, foreign-key and wrong-plugin events', () => {
    const ring = new Keyring(SECRET);
    const sealed = seal(ring, PLUGIN, { attributes: attributes(), body: serializeBody({ a: 1 }) }, { encrypt: false });
    const reason = (event: typeof sealed, keyring = ring, pluginId = PLUGIN) => {
      try {
        open(keyring, pluginId, event, { now: NOW });
        return 'accepted';
      } catch (error) {
        return error instanceof SecurityError ? error.reason : 'other';
      }
    };
    expect(reason(sealed)).toBe('accepted');
    expect(reason({ ...sealed, attributes: { ...sealed.attributes, lfsig: undefined } })).toBe('unsigned');
    expect(reason({ ...sealed, attributes: { ...sealed.attributes, lfdeadline: '1' } })).toBe('bad_signature');
    expect(reason({ ...sealed, body: serializeBody({ a: 2 }) })).toBe('bad_signature');
    expect(reason(sealed, new Keyring('another'))).toBe('unknown_key');
    expect(reason(sealed, ring, 'other-plugin')).toBe('bad_signature');
    // A rotated receiver still accepts the previous key.
    expect(reason(sealed, new Keyring('new-secret', [SECRET]))).toBe('accepted');
  });

  it('refuses events outside the clock-skew window and replays', () => {
    const ring = new Keyring(SECRET);
    const sealed = seal(ring, PLUGIN, { attributes: attributes(), body: serializeBody({}) }, { encrypt: false });
    expect(() => open(ring, PLUGIN, sealed, { now: NOW + 6 * 60_000 })).toThrow(/clock-skew/);
    expect(() => open(ring, PLUGIN, sealed, { now: NOW - 6 * 60_000 })).toThrow(/clock-skew/);
    expect(() => open(ring, PLUGIN, sealed, { now: NOW + 6 * 60_000, clockSkewMs: 10 * 60_000 })).not.toThrow();
    const replay = new ReplayGuard(60_000);
    open(ring, PLUGIN, sealed, { now: NOW, replay });
    expect(() => open(ring, PLUGIN, sealed, { now: NOW + 1000, replay })).toThrow(/replay/);
    replay.forget('call-1');
    expect(() => open(ring, PLUGIN, sealed, { now: NOW + 1000, replay })).not.toThrow();
    expect(() => open(ring, PLUGIN, sealed, { now: NOW + 61_001, replay })).not.toThrow();
  });
});

describe('encryption', () => {
  it('encrypts the body with AES-256-GCM, nonce ‖ ciphertext ‖ tag (vector)', () => {
    const ring = new Keyring(SECRET);
    const nonce = Buffer.from('000102030405060708090a0b', 'hex');
    const sealed = seal(ring, PLUGIN, { attributes: attributes(), body: serializeBody({ ok: true }) }, { encrypt: true, nonce });
    expect(sealed.attributes.lfenc).toBe('aes-256-gcm');
    expect(sealed.attributes.datacontenttype).toBe('application/octet-stream');
    expect(Buffer.from(sealed.body).toString('hex')).toBe('000102030405060708090a0bee671ac6aba5fd1cecf11bc896d7854dd5489bb2a610aab761ada4');
    expect(sealed.attributes.lfsig).toBe('9d9b3ba516457881811e270747207d5a64c0646d054f5e6d1aff8b7f17db1505');
    expect(Buffer.from(open(ring, PLUGIN, sealed, { now: NOW }).body).toString()).toBe('{"ok":true}');
  });

  it('binds the ciphertext to the event id and type, and fails on a flipped byte', () => {
    const keys = deriveKeys(SECRET, PLUGIN);
    const base = attributes();
    const sealedBody = encryptBody(keys.enc, base, serializeBody({ x: 1 }));
    expect(Buffer.from(decryptBody(keys.enc, base, sealedBody)).toString()).toBe('{"x":1}');
    expect(() => decryptBody(keys.enc, { ...base, id: 'call-2' }, sealedBody)).toThrow(SecurityError);
    const flipped = new Uint8Array(sealedBody);
    flipped[14] ^= 1;
    expect(() => decryptBody(keys.enc, base, flipped)).toThrow(/does not decrypt/);
    expect(() => decryptBody(keys.enc, base, new Uint8Array(10))).toThrow(/too short/);
  });

  it('uses a fresh nonce per event', () => {
    const ring = new Keyring(SECRET);
    const a = seal(ring, PLUGIN, { attributes: attributes(), body: serializeBody({}) }, { encrypt: true });
    const b = seal(ring, PLUGIN, { attributes: attributes(), body: serializeBody({}) }, { encrypt: true });
    expect(Buffer.from(a.body).toString('hex')).not.toBe(Buffer.from(b.body).toString('hex'));
  });
});

describe('registry proofs', () => {
  it('matches the protocol §13 vector', () => {
    expect(registryProof('registry-s3cret', 'test-plugin', 'challenge-123')).toBe('d6d47aef6c9f0cdd2357464b9db5c8d2a049d3768756e10af5ec4e37ad47655e');
    expect(verifyRegistryProof('registry-s3cret', 'test-plugin', 'challenge-123', 'd6d47aef6c9f0cdd2357464b9db5c8d2a049d3768756e10af5ec4e37ad47655e')).toBe(true);
    expect(verifyRegistryProof('registry-s3cret', 'other', 'challenge-123', 'd6d47aef6c9f0cdd2357464b9db5c8d2a049d3768756e10af5ec4e37ad47655e')).toBe(false);
    expect(verifyRegistryProof('registry-s3cret', 'test-plugin', 'challenge-123', undefined)).toBe(false);
    expect(verifyRegistryProof('registry-s3cret', 'test-plugin', 'challenge-123', 'nope')).toBe(false);
  });
});

describe('ReplayGuard', () => {
  it('bounds its memory', () => {
    const guard = new ReplayGuard(60_000, 100);
    for (let i = 0; i < 150; i++) guard.accept(`id-${i}`, 1_000);
    expect(guard.size).toBeLessThanOrEqual(100);
    expect(guard.accept('id-149', 1_000)).toBe(false);
  });
});
