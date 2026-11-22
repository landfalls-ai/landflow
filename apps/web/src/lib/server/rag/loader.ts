/**
 * The Default Data Loader's work: turn input items into documents, one per
 * chunk. "Load All Input Data" reads the whole item as `key: value` lines;
 * "Load Specific Data" reads one value per item (an expression such as
 * `{{ $json.text }}`); "Load Binary Files" reads the files of each item (PDF, DOCX, text, Markdown, HTML, CSV, JSON).
 */
import type { AiDocument } from '@landflow/engine';
import type { JsonObject, JsonValue, NodeItem } from '@landflow/sdk';
import { fileDocuments, type FileInput } from './files';
import { textOf } from './text';

export { textOf };

export interface LoadOptions {
  mode: 'allInputData' | 'expressionData' | 'binaryData';
  /** expressionData: the value to load for item `i`. */
  data?: (i: number) => unknown;
  /** Metadata for item `i`'s documents (added after the item and chunk numbers). */
  metadata?: (i: number) => JsonObject;
  /** binaryData: the files of item `i` (the loader's "Binary Fields"; none named: every file). */
  files?: (i: number) => Promise<FileInput[]>;
  /** Cuts one item's text into chunks. */
  split: (text: string) => Promise<string[]>;
}

/**
 * Metadata the re-index writes itself (C20): a workflow's metadata cannot set them, or a plain insert could plant a
 * chunk that claims another text's hash, or a key another document owns.
 */
export const RESERVED_CHUNK_METADATA = ['chunkHash', 'embedKey', 'documentKey', 'upsertKey'] as const;
const withoutReserved = (metadata: JsonObject): JsonObject => Object.fromEntries(Object.entries(metadata).filter(([key]) => !(RESERVED_CHUNK_METADATA as readonly string[]).includes(key)));

/** Documents for `items`: each item's text split into chunks, with `itemIndex`, `chunk` and the configured metadata. */
export async function loadDocuments(items: NodeItem[], options: LoadOptions): Promise<AiDocument[]> {
  const documents: AiDocument[] = [];
  for (const [i, item] of items.entries()) {
    if (options.mode === 'binaryData') {
      const metadata = withoutReserved(options.metadata?.(i) ?? {});
      for (const file of (await options.files?.(i)) ?? []) {
        documents.push(...(await fileDocuments(file, options.split, { ...metadata, itemIndex: i })));
      }
      continue;
    }
    const text = textOf(options.mode === 'allInputData' ? item.json : options.data?.(i));
    if (!text.trim()) continue;
    const chunks = await options.split(text);
    const metadata = withoutReserved(options.metadata?.(i) ?? {});
    chunks.forEach((chunk, c) => documents.push({ pageContent: chunk, metadata: { ...metadata, itemIndex: i, chunk: c } }));
  }
  return documents;
}

/** Metadata entries from the loader's fixedCollection (`{ metadataValues: [{ name, value }] }`), empty names skipped. */
export function metadataEntries(raw: unknown): JsonObject {
  const values = (raw as { metadataValues?: Array<{ name?: unknown; value?: unknown }> } | undefined)?.metadataValues ?? [];
  return Object.fromEntries(
    values.flatMap((entry) => {
      const name = String(entry.name ?? '').trim();
      return name ? [[name, (entry.value ?? null) as JsonValue]] : [];
    }),
  );
}
