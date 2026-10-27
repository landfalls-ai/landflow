/**
 * Files over HTTP: request bodies that carry files (multipart uploads to webhooks and forms, raw binary bodies)
 * become `item.binary` entries, and stored files go out as responses (the binary API, Respond to Webhook).
 */
import { basename } from 'node:path';
import { baseMimeType, DEFAULT_MIME_TYPE, mimeTypeFromFileName, type BinaryRef, type JsonObject, type JsonValue } from '@landflow/protocol';
import { binaryLimits, storeBinary } from './access';
import { BinaryTooLargeError, type ByteRange, type StoredBinaryMeta } from './store';

/** The token of `Authorization: Bearer …`; undefined without one. */
export function bearerToken(request: Request): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization')?.trim() ?? '');
  return match?.[1];
}

/** A file name without directories or control characters. */
export function safeFileName(name: string | undefined | null): string | undefined {
  const clean = basename(String(name ?? '').replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return clean && clean !== '.' && clean !== '..' ? clean.slice(0, 255) : undefined;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The name of an upload to the binary API: `X-Landflow-File-Name` (percent-encoded) or `?fileName=`. */
export function uploadFileName(request: Request): string | undefined {
  const header = request.headers.get('x-landflow-file-name');
  return safeFileName(header !== null ? decode(header) : new URL(request.url).searchParams.get('fileName'));
}

/** `filename*=` (RFC 5987) or `filename=` of a Content-Disposition header. */
export function dispositionFileName(header: string | null): string | undefined {
  if (!header) return undefined;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended) return safeFileName(decode(extended[2].trim().replace(/^"|"$/g, '')));
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  return safeFileName(plain ? (plain[2] ?? plain[1]).trim() : undefined);
}

/** `inline` or `attachment`, with an ASCII fallback name and the UTF-8 one. */
export function contentDisposition(type: 'inline' | 'attachment', fileName: string | undefined): string {
  if (!fileName) return type;
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/** Types a browser could run script in when opened directly: served with a sandboxing CSP. */
const SAFE_INLINE = /^(image\/(png|jpeg|gif|webp|avif|bmp|x-icon)|audio\/|video\/|application\/pdf$)/;

/** Headers for a stored file: type, size, name, no sniffing, and a sandbox for anything that could be active. */
export function fileResponseHeaders(meta: Pick<StoredBinaryMeta, 'mimeType' | 'fileName' | 'fileSize'>, request?: Request): Headers {
  const download = request ? new URL(request.url).searchParams.get('download') : null;
  const headers = new Headers({
    'content-type': meta.mimeType || DEFAULT_MIME_TYPE,
    'content-length': String(meta.fileSize),
    'accept-ranges': 'bytes',
    'content-disposition': contentDisposition(download && !['0', 'false'].includes(download) ? 'attachment' : 'inline', meta.fileName),
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=3600',
  });
  if (!SAFE_INLINE.test(baseMimeType(meta.mimeType))) headers.set('content-security-policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
  return headers;
}

/**
 * The byte range a `Range` header asks of a file of `size` bytes: `bytes=a-b`, `a-` and `-n` (one range only).
 * `undefined` means serve the whole file (no header, several ranges, a malformed or foreign-unit header, or an
 * `If-Range` we can't validate: files have no ETag or date); `'unsatisfiable'` means 416.
 */
export function parseRange(request: Request, size: number): ByteRange | 'unsatisfiable' | undefined {
  const header = request.headers.get('range');
  if (!header || request.headers.has('if-range')) return undefined;
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!match || (!match[1] && !match[2])) return undefined;
  if (match[1]) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : Number.POSITIVE_INFINITY;
    if (end < start) return undefined;
    return start >= size ? 'unsatisfiable' : { start, end: Math.min(end, size - 1) };
  }
  const suffix = Number(match[2]);
  return suffix === 0 || size === 0 ? 'unsatisfiable' : { start: Math.max(size - suffix, 0), end: size - 1 };
}

/** Headers of a 206 for `range`, or of the 416 (`range` undefined) of a file of `size` bytes. */
export function rangeHeaders(headers: Headers, size: number, range?: ByteRange): Headers {
  if (range) {
    headers.set('content-range', `bytes ${range.start}-${range.end}/${size}`);
    headers.set('content-length', String(range.end - range.start + 1));
  } else {
    headers.set('content-range', `bytes */${size}`);
    headers.set('content-length', '0');
  }
  return headers;
}

/** Content types read as text (JSON, forms, XML…); anything else is a file. No type at all counts as text. */
export function isTextual(contentType: string | null): boolean {
  const mime = baseMimeType(contentType ?? '');
  if (!mime) return true;
  return (
    mime.startsWith('text/') ||
    mime.endsWith('+json') ||
    mime.endsWith('+xml') ||
    ['application/json', 'application/x-www-form-urlencoded', 'application/xml', 'application/javascript', 'application/graphql', 'application/x-ndjson'].includes(mime)
  );
}

export interface RequestBodyOptions {
  /** The execution whose scope uploads go into. */
  executionId: string;
  /** Store any body as a file, whatever its type (the Webhook trigger's "Raw Body"). */
  rawBody?: boolean;
  /** Property for a raw body (default `data`). */
  binaryPropertyName?: string;
}

/** Field names of multipart files, n8n's way: `files[]` → `files`; several files under one name → `files0`, `files1`… */
function multipartNames(entries: Array<[string, File]>): string[] {
  const counts = new Map<string, number>();
  const base = (key: string) => key.replace(/\[\]$/, '') || 'file';
  for (const [key] of entries) counts.set(base(key), (counts.get(base(key)) ?? 0) + 1);
  const seen = new Map<string, number>();
  return entries.map(([key]) => {
    const name = base(key);
    if (counts.get(name) === 1) return name;
    const index = seen.get(name) ?? 0;
    seen.set(name, index + 1);
    return `${name}${index}`;
  });
}

/** Store a multipart form's files and return its text fields (repeated names become arrays) plus the refs. */
export async function readMultipart(form: FormData, executionId: string): Promise<{ fields: JsonObject; binary: Record<string, BinaryRef> }> {
  const fields: JsonObject = {};
  const files: Array<[string, File]> = [];
  for (const [key, value] of form.entries()) {
    if (typeof value !== 'string') {
      if (value.size > 0 || value.name) files.push([key, value]);
      continue;
    }
    const name = key.replace(/\[\]$/, '');
    const previous = fields[name];
    fields[name] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value];
  }
  const binary: Record<string, BinaryRef> = {};
  const names = multipartNames(files);
  for (const [index, [, file]] of files.entries()) {
    const fileName = safeFileName(file.name);
    const mimeType = file.type && file.type !== DEFAULT_MIME_TYPE ? file.type : mimeTypeFromFileName(fileName);
    binary[names[index]] = await storeBinary(executionId, file.stream() as ReadableStream<Uint8Array>, { mimeType, ...(fileName && { fileName }) });
  }
  return { fields, binary };
}

/**
 * A request body as JSON plus files: multipart uploads keep their text fields in `body` and store their files;
 * a non-text body (a PDF, an image, octet-stream), or any body with `rawBody`, is stored as one file; JSON, form
 * and text bodies are parsed as before.
 */
export async function readRequestBody(request: Request, options: RequestBodyOptions): Promise<{ body: JsonValue; binary?: Record<string, BinaryRef> }> {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || !request.body) return { body: {} };
  const { maxBytes } = binaryLimits();
  if (Number(request.headers.get('content-length')) > maxBytes) throw new BinaryTooLargeError(maxBytes);
  const type = request.headers.get('content-type');
  if (!options.rawBody && baseMimeType(type ?? '') === 'multipart/form-data') {
    const { fields, binary } = await readMultipart(await request.formData(), options.executionId);
    return { body: fields, ...(Object.keys(binary).length && { binary }) };
  }
  if (options.rawBody || !isTextual(type)) {
    const fileName = dispositionFileName(request.headers.get('content-disposition')) ?? safeFileName(request.headers.get('x-landflow-file-name') && decode(request.headers.get('x-landflow-file-name')!));
    const mimeType = type && baseMimeType(type) !== DEFAULT_MIME_TYPE ? type : mimeTypeFromFileName(fileName);
    const ref = await storeBinary(options.executionId, request.body as ReadableStream<Uint8Array>, { mimeType, ...(fileName && { fileName }) });
    return { body: {}, binary: { [options.binaryPropertyName?.trim() || 'data']: ref } };
  }
  const text = await request.text();
  if (baseMimeType(type ?? '') === 'application/x-www-form-urlencoded') return { body: Object.fromEntries(new URLSearchParams(text)) };
  try {
    return { body: text ? (JSON.parse(text) as JsonValue) : {} };
  } catch {
    return { body: text };
  }
}
