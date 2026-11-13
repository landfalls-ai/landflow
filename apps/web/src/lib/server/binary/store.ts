/**
 * The binary store: the bytes behind `item.binary` refs (docs/protocol.md §11). Files are grouped by scope, the
 * execution that owns them (`<scope>.<random>` ids), so deleting an execution deletes one directory or prefix.
 * Filesystem by default (`<data dir>/binary/<scope>/<random>` plus a `.json` sidecar); S3 or MinIO when
 * `LANDFLOW_BINARY_STORE=s3` (see ./s3.ts).
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BINARY_ID, completeBinaryRef, DEFAULT_MIME_TYPE, type BinaryRef } from '@landflow/protocol';
import { HttpError } from '../errors';

/** Bytes to store: a buffer, a Node or web stream, or any async iterable of chunks. */
export type BinarySource = Uint8Array | Readable | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

export interface StoredBinaryMeta {
  mimeType: string;
  fileName?: string;
  fileSize: number;
  createdAt: string;
}

/** An inclusive byte range of a file (`start` ≤ `end` < size). */
export interface ByteRange {
  start: number;
  end: number;
}

export interface PutOptions {
  /** Reject (and keep nothing) once the bytes pass this size. */
  maxBytes?: number;
}

export interface BinaryStore {
  readonly kind: 'filesystem' | 's3';
  /** Store bytes in a scope; resolves with the complete ref. */
  put(scope: string, data: BinarySource, meta: { mimeType?: string; fileName?: string }, options?: PutOptions): Promise<BinaryRef>;
  /** A file's metadata, or undefined when there is none. */
  head(id: string): Promise<StoredBinaryMeta | undefined>;
  /** A file's bytes as a stream (just `range` of them when given; `meta` always describes the whole file), or undefined when there is none. */
  open(id: string, range?: ByteRange): Promise<{ meta: StoredBinaryMeta; stream: Readable } | undefined>;
  /** Delete every file of a scope; resolves with how many went. */
  deleteScope(scope: string): Promise<number>;
  /** Every scope, with the time of its newest file (for the orphan sweep). */
  scopes(): Promise<Array<{ scope: string; modifiedAt: number }>>;
}

export class BinaryTooLargeError extends HttpError {
  constructor(readonly maxBytes: number) {
    super(`The file is larger than the ${maxBytes} byte limit (LANDFLOW_BINARY_MAX_BYTES)`, 413);
  }
}

export const SCOPE = /^[\w-]{1,64}$/;

/** A fresh `<scope>.<random>` id (126 random bits). */
export function newBinaryId(scope: string): string {
  if (!SCOPE.test(scope)) throw new Error(`Invalid binary scope "${scope}"`);
  return `${scope}.${randomBytes(16).toString('base64url')}`;
}

/** `[scope, random]` of a well-formed id, else undefined (keeps path traversal out of the stores). */
export function splitBinaryId(id: string): [string, string] | undefined {
  const match = BINARY_ID.exec(id);
  return match ? [match[1], match[2]] : undefined;
}

export function refOf(id: string, meta: StoredBinaryMeta): BinaryRef {
  return completeBinaryRef({ id, mimeType: meta.mimeType || DEFAULT_MIME_TYPE, ...(meta.fileName && { fileName: meta.fileName }), fileSize: meta.fileSize });
}

/** A Node stream over any BinarySource. */
export function toNodeStream(data: BinarySource): Readable {
  if (data instanceof Readable) return data;
  if (data instanceof Uint8Array) return Readable.from([data]);
  if (data instanceof ReadableStream) return Readable.fromWeb(data as import('node:stream/web').ReadableStream<Uint8Array>);
  return Readable.from(data);
}

/** Counts bytes on their way through and fails past `maxBytes`. */
export function byteCounter(maxBytes = Number.POSITIVE_INFINITY): Transform & { bytes: number } {
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      counter.bytes += chunk.length;
      if (counter.bytes > maxBytes) callback(new BinaryTooLargeError(maxBytes));
      else callback(null, chunk);
    },
  }) as Transform & { bytes: number };
  counter.bytes = 0;
  return counter;
}

export class FilesystemBinaryStore implements BinaryStore {
  readonly kind = 'filesystem' as const;
  constructor(readonly dir: string) {}

  private paths(id: string) {
    const parts = splitBinaryId(id);
    if (!parts) return undefined;
    const file = join(this.dir, parts[0], parts[1]);
    return { file, meta: `${file}.json` };
  }

  async put(scope: string, data: BinarySource, meta: { mimeType?: string; fileName?: string }, options: PutOptions = {}): Promise<BinaryRef> {
    const id = newBinaryId(scope);
    const paths = this.paths(id)!;
    await mkdir(join(this.dir, scope), { recursive: true });
    const tmp = `${paths.file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    const counter = byteCounter(options.maxBytes);
    try {
      await pipeline(toNodeStream(data), counter, createWriteStream(tmp));
      const stored: StoredBinaryMeta = { mimeType: meta.mimeType || DEFAULT_MIME_TYPE, ...(meta.fileName && { fileName: meta.fileName }), fileSize: counter.bytes, createdAt: new Date().toISOString() };
      await writeFile(paths.meta, JSON.stringify(stored));
      await rename(tmp, paths.file);
      return refOf(id, stored);
    } catch (error) {
      await rm(tmp, { force: true });
      await rm(paths.meta, { force: true });
      throw error;
    }
  }

  async head(id: string): Promise<StoredBinaryMeta | undefined> {
    const paths = this.paths(id);
    if (!paths) return undefined;
    try {
      const [meta] = await Promise.all([readFile(paths.meta, 'utf8'), stat(paths.file)]);
      return JSON.parse(meta) as StoredBinaryMeta;
    } catch {
      return undefined;
    }
  }

  async open(id: string, range?: ByteRange): Promise<{ meta: StoredBinaryMeta; stream: Readable } | undefined> {
    const meta = await this.head(id);
    return meta ? { meta, stream: createReadStream(this.paths(id)!.file, range && { start: range.start, end: range.end }) } : undefined;
  }

  async deleteScope(scope: string): Promise<number> {
    if (!SCOPE.test(scope)) return 0;
    const dir = join(this.dir, scope);
    const files = await readdir(dir).catch(() => [] as string[]);
    if (!files.length) return 0;
    await rm(dir, { recursive: true, force: true });
    return files.filter((name) => !name.endsWith('.json') && !name.endsWith('.tmp')).length;
  }

  async scopes(): Promise<Array<{ scope: string; modifiedAt: number }>> {
    const entries = await readdir(this.dir, { withFileTypes: true }).catch(() => []);
    const result: Array<{ scope: string; modifiedAt: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SCOPE.test(entry.name)) continue;
      const dir = join(this.dir, entry.name);
      let modifiedAt = (await stat(dir).catch(() => undefined))?.mtimeMs ?? 0;
      for (const name of await readdir(dir).catch(() => [] as string[])) modifiedAt = Math.max(modifiedAt, (await stat(join(dir, name)).catch(() => undefined))?.mtimeMs ?? 0);
      result.push({ scope: entry.name, modifiedAt });
    }
    return result;
  }
}

/** Read a whole file into memory (callers that need the bytes, not a stream). */
export async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}
