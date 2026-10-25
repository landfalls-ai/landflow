/**
 * Helpers for binary data (`NodeItem.binary`) shared by the host and the TypeScript SDK: MIME types from file
 * names and back, the coarse file type the UI previews by, and the shape of store ids. The Go and Python SDKs
 * carry the same small tables.
 */
import type { BinaryFileType, BinaryRef } from './types';

/** Extension → MIME type for the formats workflows usually move around. */
const MIME_BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  xml: 'application/xml',
  json: 'application/json',
  ndjson: 'application/x-ndjson',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  js: 'text/javascript',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  rtf: 'application/rtf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  avif: 'image/avif',
  heic: 'image/heic',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  eml: 'message/rfc822',
  ics: 'text/calendar',
};

/** MIME type → preferred extension (the first extension listed for it above). */
const EXTENSION_BY_MIME: Record<string, string> = {};
for (const [extension, mime] of Object.entries(MIME_BY_EXTENSION)) EXTENSION_BY_MIME[mime] ??= extension;
EXTENSION_BY_MIME['text/plain'] = 'txt';
EXTENSION_BY_MIME['image/jpeg'] = 'jpg';
EXTENSION_BY_MIME['text/html'] = 'html';

export const DEFAULT_MIME_TYPE = 'application/octet-stream';

/** "report.PDF" → "pdf"; no extension → undefined. */
export function fileExtensionOf(fileName: string | undefined): string | undefined {
  const base = String(fileName ?? '').split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : undefined;
}

/** The MIME type for a file name, else application/octet-stream. */
export function mimeTypeFromFileName(fileName: string | undefined): string {
  const extension = fileExtensionOf(fileName);
  return (extension && MIME_BY_EXTENSION[extension]) || DEFAULT_MIME_TYPE;
}

/** "image/png" → "png"; parameters (`; charset=…`) are ignored. */
export function extensionFromMimeType(mimeType: string | undefined): string | undefined {
  return EXTENSION_BY_MIME[baseMimeType(mimeType)];
}

/** "text/csv; charset=utf-8" → "text/csv". */
export function baseMimeType(mimeType: string | undefined): string {
  return String(mimeType ?? '').split(';')[0].trim().toLowerCase();
}

/** n8n's coarse file type, which the UI previews by. */
export function fileTypeOf(mimeType: string | undefined): BinaryFileType {
  const mime = baseMimeType(mimeType);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'text/html') return 'html';
  if (mime === 'application/json' || mime.endsWith('+json') || mime === 'application/x-ndjson') return 'json';
  if (mime.startsWith('text/') || ['application/xml', 'application/yaml', 'application/javascript'].includes(mime) || mime.endsWith('+xml')) return 'text';
  return 'other';
}

/** A store id: `<scope>.<random>`, where the scope is the execution (or upload) the file belongs to. */
export const BINARY_ID = /^([\w-]{1,64})\.([\w-]{8,64})$/;

/** The scope part of a store id ("ex_abc.Xy3…" → "ex_abc"), or undefined for a malformed id. */
export function binaryScopeOf(id: string | undefined): string | undefined {
  return id ? BINARY_ID.exec(id)?.[1] : undefined;
}

/**
 * Fill in what a ref can derive: the MIME type from the file name, the extension from either, and the file type.
 * Fields already set are kept.
 */
export function completeBinaryRef<T extends Partial<BinaryRef>>(ref: T): T & Pick<BinaryRef, 'mimeType' | 'fileType'> {
  const mimeType = ref.mimeType && ref.mimeType !== DEFAULT_MIME_TYPE ? ref.mimeType : ref.fileName ? mimeTypeFromFileName(ref.fileName) : (ref.mimeType ?? DEFAULT_MIME_TYPE);
  const fileExtension = ref.fileExtension ?? fileExtensionOf(ref.fileName) ?? extensionFromMimeType(mimeType);
  return { ...ref, mimeType, ...(fileExtension && { fileExtension }), fileType: ref.fileType ?? fileTypeOf(mimeType) };
}

/** Every stored ref in some items (inline refs without an id are skipped). */
export function binaryRefsOf(items: Iterable<{ binary?: Record<string, BinaryRef> }>): BinaryRef[] {
  const refs: BinaryRef[] = [];
  for (const item of items) for (const ref of Object.values(item.binary ?? {})) if (ref && typeof ref === 'object' && ref.id) refs.push(ref);
  return refs;
}

/** "1.5 MB" style size for logs and the UI. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
