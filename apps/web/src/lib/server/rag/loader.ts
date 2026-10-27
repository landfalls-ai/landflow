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

/** Documents for `items`: each item's text split into chunks, with `itemIndex`, `chunk` and the configured metadata. */
export async function loadDocuments(items: NodeItem[], options: LoadOptions): Promise<AiDocument[]> {
  const documents: AiDocument[] = [];
  for (const [i, item] of items.entries()) {
    if (options.mode === 'binaryData') {
      const metadata = options.metadata?.(i) ?? {};
      for (const file of (await options.files?.(i)) ?? []) {
        documents.push(...(await fileDocuments(file, options.split, { itemIndex: i, ...metadata })));
      }
      continue;
    }
    const text = textOf(options.mode === 'allInputData' ? item.json : options.data?.(i));
    if (!text.trim()) continue;
    const chunks = await options.split(text);
    const metadata = options.metadata?.(i) ?? {};
    chunks.forEach((chunk, c) => documents.push({ pageContent: chunk, metadata: { itemIndex: i, chunk: c, ...metadata } }));
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
