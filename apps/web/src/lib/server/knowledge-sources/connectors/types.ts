/**
 * C22: what a source connector gives the sync: a listing of items with a version marker each, and the bytes of one item.
 * The sync compares markers, fetches only what is new or changed and writes through the knowledge base's own path; a connector
 * knows nothing of chunks, collections or the database. A message a connector throws is shown to the person: keep it free of secrets.
 */
import type { FileInput } from '../../rag/files';
import type { ItemRow } from '../store';

export interface SourceItem {
  /** Stable within the source (a path, an object key, a URL, a Drive file id): the unit of change and removal. */
  key: string;
  /** The file name the loader reads the kind from (`guide.md`, `index.html`). */
  name: string;
  /** Changes when the item's content does (mtime and size, an ETag, a checksum, a content hash). */
  version: string;
  size?: number;
  mimeType?: string;
  /** Where a person can open it. */
  url?: string;
  /** The connector's own note, stored with the item and handed back as `previous` next time. */
  extra?: string;
}

export interface Listing {
  items: SourceItem[];
  /** The listing is the source's whole content: only then may an item that is not in it be taken for gone. */
  complete: boolean;
  /** Why it is not whole (a cap, a part that could not be read). */
  note?: string;
}

export interface Connector {
  /** `previous`: what the last sync stored, for a connector that asks the source "unchanged since?". */
  list(signal: AbortSignal, previous: Map<string, ItemRow>): Promise<Listing>;
  /** The item's bytes. Throws for an item that can't be read (too large, gone since it was listed). */
  fetch(item: SourceItem, signal: AbortSignal): Promise<FileInput>;
}

/** A failure of one item or of a listing, in words a person can act on. */
export class SourceError extends Error {}
