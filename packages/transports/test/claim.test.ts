/**
 * The claim check: store parsing and safety, the sweeper, signing of the reference, and (with MinIO up) the S3 store.
 *
 *   LANDFLOW_TEST_CLAIM_S3=http://127.0.0.1:59000 LANDFLOW_CLAIM_ACCESS_KEY_ID=landflow LANDFLOW_CLAIM_SECRET_ACCESS_KEY=landflow-dev-only \
 *   AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_CONFIG_FILE=/dev/null npx vitest run test/claim.test.ts
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Codec } from '../src/codec';
import { claimKeyFor, claimKeyTime, MemoryClaimStore, parseClaimStore, S3ClaimStore, sweepClaims, claimStoreFromEnv } from '../src/claim';
import { decodeWire, requestType, hostSource, EnvelopeError } from '../src/envelope';
import { Keyring } from '../src/security';
import { MEMORY_CAPABILITIES } from '../src/memory';

const keyring = new Keyring('claim-test-secret');

describe('claim store setting', () => {
  it('is unset by default and parses memory:// and s3://', () => {
    expect(claimStoreFromEnv({})).toBeUndefined();
    expect(parseClaimStore('memory://').store.kind).toBe('memory');
    const s3 = parseClaimStore('s3://landflow/claims-x?endpoint=http://127.0.0.1:59000&region=us-east-1&ttl=120', {});
    expect(s3.store.kind).toBe('s3');
    expect(s3.ttlMs).toBe(120_000);
    expect(s3.describe).toBe('s3://landflow/claims-x @ http://127.0.0.1:59000');
  });
  it('refuses the default AWS endpoint unless the URL says aws=true, and refuses junk', () => {
    expect(() => parseClaimStore('s3://landflow/p', {})).toThrow(/refusing to use the default/);
    expect(() => parseClaimStore('s3://landflow/p?aws=true', {})).not.toThrow();
    expect(() => parseClaimStore('ftp://x', {})).toThrow(/not supported/);
    expect(() => parseClaimStore('not a url', {})).toThrow(/not a URL/);
  });
});

describe('claim keys and the sweeper', () => {
  it('carries the time in the key and sweeps what is older than the TTL', async () => {
    const store = new MemoryClaimStore();
    const now = 1_800_000_000_000;
    await store.put(claimKeyFor(now - 7_200_000, 'old'), new Uint8Array([1]));
    await store.put(claimKeyFor(now - 1_000, 'fresh'), new Uint8Array([2]));
    expect(claimKeyTime(claimKeyFor(now, 'abc'))).toBe(now);
    expect(await sweepClaims(store, 3_600_000, now)).toBe(1);
    expect(store.keys()).toEqual([claimKeyFor(now - 1_000, 'fresh')]);
  });
});

describe('the reference is signed', () => {
  const codecFor = (claims: MemoryClaimStore) => new Codec(keyring, { ...MEMORY_CAPABILITIES, maxMessageBytes: 4096 }, { claims });
  const attrs = (codec: Codec) => codec.base(hostSource('h1'), requestType('Execute'), {});

  it('packs an oversized body as a reference with an empty body', async () => {
    const claims = new MemoryClaimStore();
    const codec = codecFor(claims);
    const packed = await codec.packClaimed('p1', attrs(codec), { blob: 'x'.repeat(10_000) }, true);
    expect(packed.claimKey).toMatch(/^claims\/\d{13}\//);
    expect(packed.wire.body.byteLength).toBe(0);
    expect(packed.attributes.lfclaimsize).toBe(String(claims.objects.get(packed.claimKey!)!.byteLength));
    const raw = decodeWire(packed.wire);
    const { raw: resolved } = await codec.resolveClaim(raw, 'p1');
    expect(codec.unpack(resolved, 'p1').data).toEqual({ blob: 'x'.repeat(10_000) });
  });

  it('refuses a swapped reference, a wrong size, a wrong digest and a missing object', async () => {
    const claims = new MemoryClaimStore();
    const codec = codecFor(claims);
    const packed = await codec.packClaimed('p1', attrs(codec), { blob: 'x'.repeat(10_000) }, true);
    const raw = decodeWire(packed.wire);
    const swapped = { ...raw, attributes: { ...raw.attributes, lfclaim: claimKeyFor(1, 'zzz') } };
    await expect(codec.resolveClaim(swapped, 'p1')).rejects.toThrow(/bad signature/);
    const original = claims.objects.get(packed.claimKey!)!;
    claims.objects.set(packed.claimKey!, original.subarray(0, original.length - 1));
    await expect(codec.resolveClaim(raw, 'p1')).rejects.toMatchObject({ reason: 'size' });
    const flipped = new Uint8Array(original);
    flipped[5] ^= 1;
    claims.objects.set(packed.claimKey!, flipped);
    await expect(codec.resolveClaim(raw, 'p1')).rejects.toMatchObject({ reason: 'digest' });
    claims.objects.delete(packed.claimKey!);
    await expect(codec.resolveClaim(raw, 'p1')).rejects.toMatchObject({ reason: 'missing' });
  });

  it('without a store the old too_large error stays', async () => {
    const codec = new Codec(keyring, { ...MEMORY_CAPABILITIES, maxMessageBytes: 4096 });
    await expect(codec.packClaimed('p1', attrs(codec), { blob: 'x'.repeat(10_000) }, true)).rejects.toBeInstanceOf(EnvelopeError);
  });
});

const endpoint = process.env.LANDFLOW_TEST_CLAIM_S3;
describe.skipIf(!endpoint)('S3 claim store (MinIO)', () => {
  const store = () => new S3ClaimStore({ bucket: process.env.LANDFLOW_TEST_CLAIM_BUCKET ?? 'landflow', prefix: `claims-test-${randomBytes(3).toString('hex')}/`, endpoint, region: 'us-east-1', accessKeyId: process.env.LANDFLOW_CLAIM_ACCESS_KEY_ID, secretAccessKey: process.env.LANDFLOW_CLAIM_SECRET_ACCESS_KEY });
  it('puts, gets, lists, sweeps and deletes', async () => {
    const s = store();
    const key = claimKeyFor(Date.now(), 'abc123');
    const old = claimKeyFor(Date.now() - 7_200_000, 'old456');
    const body = new Uint8Array(randomBytes(300_000));
    await s.put(key, body);
    await s.put(old, new Uint8Array([1, 2, 3]));
    expect(Buffer.from((await s.get(key))!).equals(Buffer.from(body))).toBe(true);
    expect((await s.list('claims/')).sort()).toEqual([old, key].sort());
    expect(await sweepClaims(s, 3_600_000)).toBe(1);
    expect(await s.get(old)).toBeUndefined();
    await s.delete(key);
    await s.delete(key);
    expect(await s.get(key)).toBeUndefined();
    await s.close();
  });
});
