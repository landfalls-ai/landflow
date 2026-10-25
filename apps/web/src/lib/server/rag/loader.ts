/**
 * The Default Data Loader's work: turn input items into documents, one per
 * chunk. "Load All Input Data" reads the whole item as `key: value` lines;
 * "Load Specific Data" reads one value per item (an expression such as
 * `{{ $json.text }}`). Binary files come later, with binary data.
 */
import type { AiDocument } from '@landflow/engine';
import type { JsonObject, JsonValue, NodeItem } from '@landflow/sdk';

export interface LoadOptions {
  mode: 'allInputData' | 'expressionData';
  /** expressionData: the value to load for item `i`. */
  data?: (i: number) => unknown;
  /** Metadata for item `i`'s documents (added after the item and chunk numbers). */
  metadata?: (i: number) => JsonObject;
  /** Cuts one item's text into chunks. */
  split: (text: string) => Promise<string[]>;
}

const scalar = (value: JsonValue) => (typeof value === 'string' ? value : JSON.stringify(value));

/** A JSON value as readable text: strings as they are, objects as `key: value` lines (nested values as JSON). */
export function textOf(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value);
  return Object.entries(value as JsonObject)
    .filter(([, entry]) => entry !== undefined && entry !== null && entry !== '')
    .map(([key, entry]) => `${key}: ${scalar(entry)}`)
    .join('\n');
}

/** Documents for `items`: each item's text split into chunks, with `itemIndex`, `chunk` and the configured metadata. */
export async function loadDocuments(items: NodeItem[], options: LoadOptions): Promise<AiDocument[]> {
  const documents: AiDocument[] = [];
  for (const [i, item] of items.entries()) {
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
