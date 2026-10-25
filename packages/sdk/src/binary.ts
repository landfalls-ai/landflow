/**
 * Binary data for nodes (docs/protocol.md §11): read the files of input items and store new ones. Items carry
 * refs (`item.binary.data = { id, mimeType, fileName, fileSize, … }`); the bytes live in the host's binary store.
 * A remote plugin reaches it over HTTP with the request's `binaryAccess`; the host's in-process nodes get a direct
 * client through `ContextExtras.binary`. Small files are returned inline (`ref.data`) when going over HTTP would
 * cost a round trip; the host stores them.
 */
import { Readable } from 'node:stream';
import {
  completeBinaryRef,
  MAX_INLINE_BINARY_BYTES,
  mimeTypeFromFileName,
  type BinaryAccess,
  type BinaryRef,
  type ExecuteRequest,
} from '@landflow/protocol';
import { NodeOperationError } from './node';

/** What a node can hand to `prepareBinaryData`. Node.js `Readable`s are async iterables. */
export type BinaryInput = Uint8Array | ArrayBuffer | string | Blob | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

export interface BinaryFileMeta {
  fileName?: string;
  mimeType?: string;
}

/** Access to the host's binary store: HTTP for plugins (`httpBinaryClient`), direct for the host's own nodes. */
export interface BinaryDataClient {
  read(ref: BinaryRef, signal?: AbortSignal): Promise<Uint8Array>;
  stream(ref: BinaryRef, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  /** Store bytes; resolves with the stored ref (with `id`). */
  write(data: Uint8Array | ReadableStream<Uint8Array>, meta: BinaryFileMeta, signal?: AbortSignal): Promise<BinaryRef>;
  /** Return small files inline instead of calling `write` (saves a round trip over HTTP; pointless in-process). */
  readonly inlineSmallFiles?: boolean;
}

export interface IBinaryHelpers {
  /** The ref under `propertyName` of input item `itemIndex`; a NodeOperationError when the item has none. */
  assertBinaryData(itemIndex: number, propertyName?: string, inputIndex?: number): BinaryRef;
  /** The bytes of that file. */
  getBinaryDataBuffer(itemIndex: number, propertyName?: string, inputIndex?: number): Promise<Buffer>;
  /** The bytes of that file as a stream, for large files. */
  getBinaryStream(itemIndex: number, propertyName?: string, inputIndex?: number): Promise<ReadableStream<Uint8Array>>;
  /** The bytes of any ref (one from an earlier node, a sub-workflow, a JSON field). */
  binaryToBuffer(ref: BinaryRef): Promise<Buffer>;
  /** Store bytes and get the ref to attach: `{ json, binary: { data: await ctx.helpers.prepareBinaryData(bytes, 'a.pdf') } }`. */
  prepareBinaryData(data: BinaryInput, fileName?: string, mimeType?: string): Promise<BinaryRef>;
}

const NO_STORE = 'This host sent no binary access with the request, so files over 64 KiB can’t be stored (update the Landflow host)';

/** Bearer-token HTTP client for `ExecuteRequest.binaryAccess`. `fetcher` is usually the context's traced fetch. */
export function httpBinaryClient(access: BinaryAccess, fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch): BinaryDataClient {
  const base = access.url.replace(/\/+$/, '');
  const auth = { authorization: `Bearer ${access.token}` };
  const get = async (ref: BinaryRef, signal?: AbortSignal) => {
    if (!ref.id) throw new NodeOperationError('This file has neither an id nor inline data');
    const response = await fetcher(`${base}/${encodeURIComponent(ref.id)}`, { headers: auth, signal });
    if (!response.ok) throw new NodeOperationError(`Could not read file ${ref.fileName ?? ref.id}: ${response.status} ${await errorText(response)}`);
    return response;
  };
  return {
    inlineSmallFiles: true,
    read: async (ref, signal) => new Uint8Array(await (await get(ref, signal)).arrayBuffer()),
    stream: async (ref, signal) => (await get(ref, signal)).body ?? emptyStream(),
    async write(data, meta, signal) {
      const mimeType = meta.mimeType || mimeTypeFromFileName(meta.fileName);
      const headers: Record<string, string> = { ...auth, 'content-type': mimeType };
      if (meta.fileName) headers['x-landflow-file-name'] = encodeURIComponent(meta.fileName);
      const init: RequestInit & { duplex?: 'half' } = { method: 'POST', headers, body: data as BodyInit, signal };
      if (data instanceof ReadableStream) init.duplex = 'half';
      const response = await fetcher(base, init);
      if (response.status !== 201 && !response.ok) throw new NodeOperationError(`Could not store file ${meta.fileName ?? ''}: ${response.status} ${await errorText(response)}`.trim());
      return (await response.json()) as BinaryRef;
    },
  };
}

async function errorText(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    return (JSON.parse(text) as { error?: string }).error ?? text;
  } catch {
    return text.slice(0, 300);
  }
}

const emptyStream = () => new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });

/** Inline bytes as a stored-looking ref, before the host stores them. */
export function inlineBinary(bytes: Uint8Array, meta: BinaryFileMeta = {}): BinaryRef {
  return completeBinaryRef({
    mimeType: meta.mimeType || mimeTypeFromFileName(meta.fileName),
    ...(meta.fileName && { fileName: meta.fileName }),
    fileSize: bytes.byteLength,
    data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
  });
}

/** Bytes, or a stream for inputs whose size isn't known up front. */
async function normalizeInput(data: BinaryInput): Promise<Uint8Array | ReadableStream<Uint8Array>> {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (data instanceof ReadableStream) return data;
  if (data instanceof Readable) return Readable.toWeb(data) as ReadableStream<Uint8Array>;
  return Readable.toWeb(Readable.from(data as AsyncIterable<Uint8Array>)) as ReadableStream<Uint8Array>;
}

/** Read a stream into memory, failing once it passes `limit` bytes. */
async function collect(stream: ReadableStream<Uint8Array>, limit = Number.POSITIVE_INFINITY): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > limit) throw new NodeOperationError(NO_STORE);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const toBuffer = (bytes: Uint8Array) => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));

/** The binary half of `ctx.helpers`, over the request's input items and a client (none: only inline files work). */
export function createBinaryHelpers(request: Pick<ExecuteRequest, 'inputs'>, client: BinaryDataClient | undefined, signal?: AbortSignal): IBinaryHelpers {
  const read = async (ref: BinaryRef): Promise<Uint8Array> => {
    if (ref.data !== undefined && !ref.id) return Buffer.from(ref.data, 'base64');
    if (!client) throw new NodeOperationError(`Can’t read ${ref.fileName ?? ref.id}: the host sent no binary access with the request`);
    return client.read(ref, signal);
  };
  const helpers: IBinaryHelpers = {
    assertBinaryData(itemIndex, propertyName = 'data', inputIndex = 0) {
      const item = request.inputs[inputIndex]?.[itemIndex];
      const ref = item?.binary?.[propertyName];
      if (!ref || typeof ref !== 'object') {
        const available = Object.keys(item?.binary ?? {});
        throw new NodeOperationError(`Item ${itemIndex} has no binary file “${propertyName}”`, {
          itemIndex,
          description: available.length ? `Its files: ${available.join(', ')}` : 'It has no files. Use a node that outputs a file before this one (HTTP Request with “File” response, Read Files, a webhook upload…).',
        });
      }
      return ref;
    },
    getBinaryDataBuffer: async (itemIndex, propertyName, inputIndex) => toBuffer(await read(helpers.assertBinaryData(itemIndex, propertyName, inputIndex))),
    async getBinaryStream(itemIndex, propertyName, inputIndex) {
      const ref = helpers.assertBinaryData(itemIndex, propertyName, inputIndex);
      if (ref.data !== undefined && !ref.id) return Readable.toWeb(Readable.from([Buffer.from(ref.data, 'base64')])) as ReadableStream<Uint8Array>;
      if (!client) throw new NodeOperationError(`Can’t read ${ref.fileName ?? ref.id}: the host sent no binary access with the request`);
      return client.stream(ref, signal);
    },
    binaryToBuffer: async (ref) => toBuffer(await read(ref)),
    async prepareBinaryData(data, fileName, mimeType) {
      const meta: BinaryFileMeta = { ...(fileName && { fileName }), ...(mimeType && { mimeType }) };
      let input = await normalizeInput(data);
      if (!client) {
        const bytes = input instanceof Uint8Array ? input : await collect(input, MAX_INLINE_BINARY_BYTES);
        if (bytes.byteLength > MAX_INLINE_BINARY_BYTES) throw new NodeOperationError(NO_STORE);
        return inlineBinary(bytes, meta);
      }
      if (client.inlineSmallFiles && input instanceof Uint8Array && input.byteLength <= MAX_INLINE_BINARY_BYTES) return inlineBinary(input, meta);
      // An in-process store takes the stream as it is; keep fetch-friendly bytes for small inputs.
      if (input instanceof Uint8Array && !client.inlineSmallFiles) input = toBuffer(input);
      return client.write(input, meta, signal);
    },
  };
  return helpers;
}
