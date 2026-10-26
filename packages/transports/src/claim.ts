/**
 * The claim check (docs/protocol.md §14.6 "Size"): an event whose headers and body do not fit the broker's limits goes by
 * reference. The sender writes the already-encrypted body to a shared object store (S3-compatible: MinIO in dev) under a
 * fresh key, publishes the event with an empty body plus `lfclaim` / `lfclaimsize` / `lfclaimsha256` (signed like every
 * other attribute), and the receiver fetches, checks size and digest, and carries on as usual. The store only ever sees
 * ciphertext.
 *
 * - `ClaimStore` is the small interface (put / get / delete / list); `MemoryClaimStore` is for tests, `S3ClaimStore` for
 *   S3-compatible buckets (`@aws-sdk/client-s3`, an optional peer imported lazily).
 * - `claimStoreFromEnv()` reads one setting, `LANDFLOW_CLAIM_STORE=s3://<bucket>/<prefix>?endpoint=…&region=…&forcePathStyle=true`
 *   (or `memory://`), plus the credentials in `LANDFLOW_CLAIM_ACCESS_KEY_ID` / `LANDFLOW_CLAIM_SECRET_ACCESS_KEY` (falling back to
 *   `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`). An S3 store **refuses to start without an explicit
 *   endpoint** unless the URL says `aws=true` (the operator meant the real AWS endpoint).
 * - Lifetime: the receiver deletes the object once it has acknowledged the event; a sender deletes the request object of a call
 *   that failed; the key is `claims/<epoch ms, 13 digits>/<event id>`, so `sweepClaims()` (run by the client and the server
 *   every 10 min) can delete whatever is older than the TTL (default 1 h) after a crash. Keys are relative to the store's prefix.
 */
import { createHash } from 'node:crypto';

export const CLAIM_KEY_PREFIX = 'claims/';
export const DEFAULT_CLAIM_TTL_MS = 3_600_000;
export const CLAIM_SWEEP_INTERVAL_MS = 600_000;
/** `claims/<13 digits>/<event id>`: anything else in `lfclaim` is refused before the store is touched. */
export const CLAIM_KEY_RE = /^claims\/\d{13}\/[A-Za-z0-9._-]{1,128}$/;

export interface ClaimStore {
  readonly kind: string;
  put(key: string, body: Uint8Array): Promise<void>;
  /** `undefined` when the object does not exist (expired or deleted). */
  get(key: string): Promise<Uint8Array | undefined>;
  /** Idempotent: deleting a missing object is not an error. */
  delete(key: string): Promise<void>;
  /** Keys (relative to the store's prefix) starting with `prefix`. */
  list(prefix: string): Promise<string[]>;
  close?(): Promise<void>;
}

/** The claim could not be written, fetched or verified. `reason` says which. */
export class ClaimError extends Error {
  constructor(
    message: string,
    readonly reason: 'store' | 'missing' | 'size' | 'digest' | 'invalid',
  ) {
    super(message);
    this.name = 'ClaimError';
  }
}

export const claimKeyFor = (now: number, eventId: string): string => `${CLAIM_KEY_PREFIX}${String(now).padStart(13, '0')}/${eventId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128)}`;
export const claimKeyTime = (key: string): number | undefined => (CLAIM_KEY_RE.test(key) ? Number(key.slice(CLAIM_KEY_PREFIX.length, CLAIM_KEY_PREFIX.length + 13)) : undefined);
export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** In-process store for tests (and `memory://` in dev). `puts` / `deletes` count calls; `keys()` lists what is stored now. */
export class MemoryClaimStore implements ClaimStore {
  readonly kind = 'memory';
  readonly objects = new Map<string, Uint8Array>();
  readonly counters = { puts: 0, gets: 0, deletes: 0 };
  /** Make the next calls fail (`'put'`, `'get'`) to exercise store outages. */
  failNext: 'put' | 'get' | undefined;
  async put(key: string, body: Uint8Array): Promise<void> {
    if (this.failNext === 'put') {
      this.failNext = undefined;
      throw new Error('memory claim store: put failed');
    }
    this.counters.puts++;
    this.objects.set(key, new Uint8Array(body));
  }
  async get(key: string): Promise<Uint8Array | undefined> {
    if (this.failNext === 'get') {
      this.failNext = undefined;
      throw new Error('memory claim store: get failed');
    }
    this.counters.gets++;
    return this.objects.get(key);
  }
  async delete(key: string): Promise<void> {
    this.counters.deletes++;
    this.objects.delete(key);
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix));
  }
  keys(): string[] {
    return [...this.objects.keys()];
  }
}

export interface S3ClaimStoreOptions {
  bucket: string;
  /** Key prefix inside the bucket, e.g. `landflow-claims/`. */
  prefix?: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** Default `true` (MinIO, LocalStack). */
  forcePathStyle?: boolean;
  /** The operator deliberately uses the real AWS endpoint (no `endpoint`). */
  allowAws?: boolean;
}

/** S3-compatible claim store. The client is created on first use so `@aws-sdk/client-s3` stays an optional peer. */
export class S3ClaimStore implements ClaimStore {
  readonly kind = 's3';
  private readonly prefix: string;
  private sdk: Promise<{ client: import('@aws-sdk/client-s3').S3Client; mod: typeof import('@aws-sdk/client-s3') }> | undefined;

  constructor(private readonly options: S3ClaimStoreOptions) {
    if (!options.bucket) throw new Error('claim store: the bucket is empty');
    if (!options.endpoint && !options.allowAws) {
      throw new Error('claim store: refusing to use the default (AWS) endpoint; set ?endpoint=… (MinIO, LocalStack) or ?aws=true if you mean the real S3');
    }
    this.prefix = options.prefix ? (options.prefix.endsWith('/') ? options.prefix : options.prefix + '/') : '';
  }

  private load() {
    this.sdk ??= import('@aws-sdk/client-s3').then((mod) => {
      const o = this.options;
      const client = new mod.S3Client({
        region: o.region ?? 'us-east-1',
        ...(o.endpoint && { endpoint: o.endpoint }),
        forcePathStyle: o.forcePathStyle ?? true,
        ...(o.accessKeyId && o.secretAccessKey && { credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey, ...(o.sessionToken && { sessionToken: o.sessionToken }) } }),
      });
      return { client, mod };
    });
    return this.sdk;
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const { client, mod } = await this.load();
    await client.send(new mod.PutObjectCommand({ Bucket: this.options.bucket, Key: this.prefix + key, Body: body, ContentLength: body.byteLength, ContentType: 'application/octet-stream' }));
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const { client, mod } = await this.load();
    try {
      const out = await client.send(new mod.GetObjectCommand({ Bucket: this.options.bucket, Key: this.prefix + key }));
      return out.Body ? await out.Body.transformToByteArray() : new Uint8Array();
    } catch (error) {
      const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return undefined;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const { client, mod } = await this.load();
    await client.send(new mod.DeleteObjectCommand({ Bucket: this.options.bucket, Key: this.prefix + key }));
  }

  async list(prefix: string): Promise<string[]> {
    const { client, mod } = await this.load();
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const out = await client.send(new mod.ListObjectsV2Command({ Bucket: this.options.bucket, Prefix: this.prefix + prefix, ContinuationToken: token }));
      for (const object of out.Contents ?? []) if (object.Key) keys.push(object.Key.slice(this.prefix.length));
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  async close(): Promise<void> {
    if (this.sdk) (await this.sdk).client.destroy();
  }
}

export interface ClaimSetting {
  store: ClaimStore;
  ttlMs: number;
  /** For display: the setting without credentials, e.g. `s3://landflow/landflow-claims/ @ http://127.0.0.1:59000`. */
  describe: string;
}

/** Parse a `LANDFLOW_CLAIM_STORE` value. Throws on a malformed or unsafe one (the caller decides whether that is fatal). */
export function parseClaimStore(value: string, env: NodeJS.ProcessEnv = process.env): ClaimSetting {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`LANDFLOW_CLAIM_STORE "${value}" is not a URL (expected s3://<bucket>/<prefix>?endpoint=…)`);
  }
  const q = url.searchParams;
  const ttl = q.get('ttl') ? Number(q.get('ttl')) * 1000 : DEFAULT_CLAIM_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error('LANDFLOW_CLAIM_STORE: ttl must be a positive number of seconds');
  if (url.protocol === 'memory:') return { store: new MemoryClaimStore(), ttlMs: ttl, describe: 'memory (in this process only)' };
  if (url.protocol !== 's3:') throw new Error(`LANDFLOW_CLAIM_STORE: scheme "${url.protocol}" is not supported (s3: or memory:)`);
  const bucket = decodeURIComponent(url.hostname);
  const prefix = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const store = new S3ClaimStore({
    bucket,
    prefix,
    endpoint: q.get('endpoint') || undefined,
    region: q.get('region') || undefined,
    forcePathStyle: q.get('forcePathStyle') === null ? true : q.get('forcePathStyle') !== 'false',
    allowAws: q.get('aws') === 'true',
    accessKeyId: env.LANDFLOW_CLAIM_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID || undefined,
    secretAccessKey: env.LANDFLOW_CLAIM_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY || undefined,
    sessionToken: env.AWS_SESSION_TOKEN || undefined,
  });
  return { store, ttlMs: ttl, describe: `s3://${bucket}/${prefix}${q.get('endpoint') ? ' @ ' + q.get('endpoint') : ''}` };
}

/** The claim store the environment configures, or `undefined` when `LANDFLOW_CLAIM_STORE` is unset. */
export function claimStoreFromEnv(env: NodeJS.ProcessEnv = process.env): ClaimSetting | undefined {
  const value = env.LANDFLOW_CLAIM_STORE?.trim();
  return value ? parseClaimStore(value, env) : undefined;
}

/** Delete the claims older than `ttlMs` (the key carries the time). Returns how many it deleted. */
export async function sweepClaims(store: ClaimStore, ttlMs: number, now = Date.now()): Promise<number> {
  let deleted = 0;
  for (const key of await store.list(CLAIM_KEY_PREFIX)) {
    const at = claimKeyTime(key);
    if (at !== undefined && at < now - ttlMs) {
      await store.delete(key);
      deleted++;
    }
  }
  return deleted;
}

/** Sweep now and then; returns the stop function. Failures are logged at debug and retried at the next tick. */
export function startClaimSweeper(store: ClaimStore, ttlMs: number, onError: (error: Error) => void, intervalMs = CLAIM_SWEEP_INTERVAL_MS, now: () => number = Date.now): () => void {
  const timer = setInterval(() => void sweepClaims(store, ttlMs, now()).catch((error: Error) => onError(error)), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
