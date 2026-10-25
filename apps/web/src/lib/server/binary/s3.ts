/**
 * S3 (or MinIO) binary store: `<prefix><scope>/<random>`, with the MIME type as Content-Type and the file name in
 * object metadata. Path-style addressing by default, which MinIO needs. Streams of unknown length are kept in
 * memory up to 8 MiB and spooled to a temporary file beyond that, so PutObject always gets a Content-Length.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import { DEFAULT_MIME_TYPE, type BinaryRef } from '@landflow/protocol';
import { byteCounter, newBinaryId, refOf, SCOPE, splitBinaryId, toNodeStream, type BinarySource, type BinaryStore, type PutOptions, type StoredBinaryMeta } from './store';

export interface S3BinaryStoreOptions {
  bucket: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Default true (MinIO and most S3-compatible servers). */
  forcePathStyle?: boolean;
  /** Key prefix, e.g. "binary/". */
  prefix?: string;
}

const MEMORY_LIMIT = 8 * 1024 * 1024;

/** The S3 settings from the environment (LANDFLOW_S3_*). */
export function s3OptionsFromEnv(env: NodeJS.ProcessEnv = process.env): S3BinaryStoreOptions {
  const bucket = env.LANDFLOW_S3_BUCKET;
  if (!bucket) throw new Error('LANDFLOW_BINARY_STORE=s3 needs LANDFLOW_S3_BUCKET');
  return {
    bucket,
    ...(env.LANDFLOW_S3_ENDPOINT && { endpoint: env.LANDFLOW_S3_ENDPOINT }),
    region: env.LANDFLOW_S3_REGION || 'us-east-1',
    ...(env.LANDFLOW_S3_ACCESS_KEY_ID && { accessKeyId: env.LANDFLOW_S3_ACCESS_KEY_ID }),
    ...(env.LANDFLOW_S3_SECRET_ACCESS_KEY && { secretAccessKey: env.LANDFLOW_S3_SECRET_ACCESS_KEY }),
    forcePathStyle: env.LANDFLOW_S3_FORCE_PATH_STYLE !== 'false',
    prefix: env.LANDFLOW_S3_PREFIX ?? 'binary/',
  };
}

export class S3BinaryStore implements BinaryStore {
  readonly kind = 's3' as const;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(options: S3BinaryStoreOptions) {
    this.bucket = options.bucket;
    this.prefix = options.prefix ?? 'binary/';
    this.client = new S3Client({
      region: options.region ?? 'us-east-1',
      forcePathStyle: options.forcePathStyle ?? true,
      ...(options.endpoint && { endpoint: options.endpoint }),
      // Without explicit keys the SDK's default chain applies (AWS_* variables, profiles, instance roles).
      ...(options.accessKeyId && options.secretAccessKey && { credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey } }),
    });
  }

  private key(id: string): string | undefined {
    const parts = splitBinaryId(id);
    return parts ? `${this.prefix}${parts[0]}/${parts[1]}` : undefined;
  }

  async put(scope: string, data: BinarySource, meta: { mimeType?: string; fileName?: string }, options: PutOptions = {}): Promise<BinaryRef> {
    const id = newBinaryId(scope);
    const mimeType = meta.mimeType || DEFAULT_MIME_TYPE;
    const createdAt = new Date().toISOString();
    const counter = byteCounter(options.maxBytes);
    const input = toNodeStream(data);
    input.once('error', (error) => counter.destroy(error));
    const source = input.pipe(counter);
    // Fill memory first; switch to a temporary file once the stream turns out to be big.
    const chunks: Buffer[] = [];
    let buffered = 0;
    let spool: { path: string; done: Promise<void>; push(chunk: Buffer): void; end(): void } | undefined;
    try {
      for await (const chunk of source as AsyncIterable<Buffer>) {
        if (spool) {
          spool.push(chunk);
          continue;
        }
        chunks.push(chunk);
        buffered += chunk.length;
        if (buffered > MEMORY_LIMIT) {
          spool = spoolFile(chunks.splice(0));
        }
      }
      let body: Buffer | Readable;
      let length: number;
      if (spool) {
        spool.end();
        await spool.done;
        length = (await stat(spool.path)).size;
        body = createReadStream(spool.path);
      } else {
        body = Buffer.concat(chunks);
        length = body.length;
      }
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key(id),
          Body: body,
          ContentLength: length,
          ContentType: mimeType,
          Metadata: { ...(meta.fileName && { filename: encodeURIComponent(meta.fileName) }), createdat: createdAt },
        }),
      );
      return refOf(id, { mimeType, ...(meta.fileName && { fileName: meta.fileName }), fileSize: length, createdAt });
    } catch (error) {
      input.destroy();
      throw error;
    } finally {
      if (spool) await rm(spool.path, { force: true });
    }
  }

  async head(id: string): Promise<StoredBinaryMeta | undefined> {
    const key = this.key(id);
    if (!key) return undefined;
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return metaOf(head);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async open(id: string): Promise<{ meta: StoredBinaryMeta; stream: Readable } | undefined> {
    const key = this.key(id);
    if (!key) return undefined;
    try {
      const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return { meta: metaOf(object), stream: object.Body as Readable };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async deleteScope(scope: string): Promise<number> {
    if (!SCOPE.test(scope)) return 0;
    let deleted = 0;
    for await (const page of this.list(`${this.prefix}${scope}/`)) {
      const keys = (page.Contents ?? []).map((object) => ({ Key: object.Key! }));
      if (!keys.length) continue;
      await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }));
      deleted += keys.length;
    }
    return deleted;
  }

  async scopes(): Promise<Array<{ scope: string; modifiedAt: number }>> {
    const newest = new Map<string, number>();
    for await (const page of this.list(this.prefix)) {
      for (const object of page.Contents ?? []) {
        const scope = object.Key!.slice(this.prefix.length).split('/')[0];
        if (SCOPE.test(scope)) newest.set(scope, Math.max(newest.get(scope) ?? 0, object.LastModified?.getTime() ?? 0));
      }
    }
    return [...newest].map(([scope, modifiedAt]) => ({ scope, modifiedAt }));
  }

  private async *list(prefix: string): AsyncGenerator<ListObjectsV2CommandOutput> {
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      yield page;
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  destroy() {
    this.client.destroy();
  }
}

function metaOf(object: { ContentType?: string; ContentLength?: number; Metadata?: Record<string, string>; LastModified?: Date }): StoredBinaryMeta {
  const fileName = object.Metadata?.filename;
  return {
    mimeType: object.ContentType || DEFAULT_MIME_TYPE,
    ...(fileName && { fileName: decodeURIComponent(fileName) }),
    fileSize: object.ContentLength ?? 0,
    createdAt: object.Metadata?.createdat ?? object.LastModified?.toISOString() ?? '',
  };
}

function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/** A temporary file that takes the chunks read so far and every later one. */
function spoolFile(initial: Buffer[]) {
  const path = join(tmpdir(), `landflow-binary-${randomBytes(8).toString('hex')}`);
  const passthrough = new Readable({ read() {} });
  for (const chunk of initial) passthrough.push(chunk);
  const done = pipeline(passthrough, createWriteStream(path));
  return { path, done, push: (chunk: Buffer) => void passthrough.push(chunk), end: () => void passthrough.push(null) };
}
