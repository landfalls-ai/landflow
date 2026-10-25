/**
 * Item files (`item.binary`) as the run panels show them: which items carry files, how each one can be
 * previewed, and the URLs the host's binary route serves them at (`GET /api/binary/<id>`, no token from the
 * browser; `?download=1` makes it an attachment). Inline refs (base64 `data`, no id) use a data: URL instead.
 */
import { fileTypeOf, type BinaryRef, type NodeItem } from '@landflow/protocol';

/** Text-like files are fetched for a preview only up to this size… */
export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;
/** …and only this much of them is shown. */
export const TEXT_PREVIEW_SHOW_BYTES = 64 * 1024;

export type PreviewKind = 'image' | 'text' | 'pdf' | 'audio' | 'video' | 'none';

export interface BinaryEntry {
  /** Index of the item in its branch. */
  itemIndex: number;
  /** Key under `item.binary` ("data"). */
  property: string;
  ref: BinaryRef;
}

/** Every file of some items, in item order, skipping entries that are not refs. */
export function binaryEntriesOf(items: readonly NodeItem[] | undefined): BinaryEntry[] {
  const entries: BinaryEntry[] = [];
  (items ?? []).forEach((item, itemIndex) => {
    for (const [property, ref] of Object.entries(item?.binary ?? {})) {
      if (ref && typeof ref === 'object' && (ref.id || ref.data !== undefined)) entries.push({ itemIndex, property, ref });
    }
  });
  return entries;
}

/** Whether any item carries a file (the Binary mode appears only then). */
export function hasBinary(items: readonly NodeItem[] | undefined): boolean {
  return (items ?? []).some((item) => binaryEntriesOf([item]).length > 0);
}

/**
 * How a file can be shown inline. HTML, SVG, JSON and CSV preview as source text: the host serves HTML and
 * SVG sandboxed, and markup is never rendered in the editor.
 */
export function previewKindOf(ref: BinaryRef): PreviewKind {
  const mime = String(ref.mimeType ?? '').split(';')[0].trim().toLowerCase();
  if (mime === 'image/svg+xml') return 'text';
  const type = ref.fileType ?? fileTypeOf(mime);
  if (type === 'image') return 'image';
  if (type === 'pdf') return 'pdf';
  if (type === 'audio') return 'audio';
  if (type === 'video') return 'video';
  if (type === 'text' || type === 'json' || type === 'html') return 'text';
  return 'none';
}

/** A text preview is fetched only for files small enough. */
export function canPreviewText(ref: BinaryRef): boolean {
  return previewKindOf(ref) === 'text' && (ref.data !== undefined || !(ref.fileSize > TEXT_PREVIEW_MAX_BYTES));
}

/** Where the file is served: the binary route for stored refs, a data: URL for inline ones (undefined if neither). */
export function binaryUrl(ref: BinaryRef, options: { download?: boolean } = {}): string | undefined {
  if (ref.id) return `/api/binary/${encodeURIComponent(ref.id)}${options.download ? '?download=1' : ''}`;
  if (ref.data !== undefined) return `data:${ref.mimeType || 'application/octet-stream'};base64,${ref.data}`;
  return undefined;
}

/** The name a file is shown and saved under: its file name, else `<property>.<extension>`. */
export function displayName(entry: Pick<BinaryEntry, 'property' | 'ref'>): string {
  const { ref, property } = entry;
  return ref.fileName || (ref.fileExtension ? `${property}.${ref.fileExtension}` : property);
}

/** The first TEXT_PREVIEW_SHOW_BYTES of a text file's bytes, and whether it was cut. */
export function previewText(bytes: Uint8Array): { text: string; truncated: boolean } {
  const truncated = bytes.byteLength > TEXT_PREVIEW_SHOW_BYTES;
  // A cut multi-byte character decodes as U+FFFD; non-fatal decoding keeps the rest readable.
  const text = new TextDecoder('utf-8', { fatal: false }).decode(truncated ? bytes.subarray(0, TEXT_PREVIEW_SHOW_BYTES) : bytes);
  return { text, truncated };
}

/** An inline ref's bytes (base64 `data`). */
export function inlineBytes(ref: BinaryRef): Uint8Array {
  const raw = atob(ref.data ?? '');
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
