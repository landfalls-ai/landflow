/**
 * C20: re-index one document and embed only what is new. A chunk's identity is the SHA-256 of its text; a chunk whose
 * hash the collection already holds under the same embeddings model (`embedKey`) keeps its stored vector, and only
 * the rest go to the embeddings model, in one call. The document's chunks are then replaced in one store step, so a
 * search sees the old version or the new one and an embeddings failure leaves the old one. One function serves the
 * knowledge-base folder index, the Notion walk and the Vector Store node's "Upsert by Key".
 *
 * The rule is specified from behaviour (Supermemory's closed engine is not read or copied); ids are stable across passes.
 */
import { createHash } from 'node:crypto';
import type { Embeddings } from '@landflow/engine';
import type { JsonObject, JsonValue } from '@landflow/sdk';
import { recordChunks } from '../telemetry';
import { replaceDocuments, type MetadataFilter, type StoreInput, type VectorStore } from './stores';

/** SHA-256 of a chunk's text, hex. */
export const chunkHash = (text: string): string => createHash('sha256').update(text).digest('hex');

/** What an embeddings object may say beyond the engine's contract: the vector size it asks for and the server it asks. */
export type EmbeddingsIdentity = Embeddings & { readonly dimensions?: number; readonly endpoint?: string };

/**
 * Which embeddings produced a vector: a vector is reused only under the same provider, model, requested size and (for
 * an OpenAI-compatible server, where the same model name can be another model) the same endpoint, kept as a short hash.
 */
export function embedKeyOf(embeddings: Embeddings): string {
  const { dimensions, endpoint } = embeddings as EmbeddingsIdentity;
  const where = endpoint ? `@${createHash('sha256').update(endpoint.replace(/\/+$/, '')).digest('hex').slice(0, 8)}` : '';
  return `${embeddings.provider}:${embeddings.model}${dimensions ? `#${dimensions}` : ''}${where}`;
}

export interface SyncInput {
  collection: string;
  /** Selects the document's stored chunks (every chunk it holds is replaced), e.g. `{ source }` or `{ upsertKey }`. */
  match: MetadataFilter;
  /** The document's identity: the prefix of its chunk ids and the `documentKey` of their metadata. */
  documentKey: string;
  /** The document's chunks in order, with the metadata each is stored with (the hash and key fields are added). */
  chunks: Array<{ text: string; metadata: JsonObject }>;
}

export interface SyncResult {
  /** Chunks that kept a stored vector (a repeat of a text inside the document counts here too). */
  reused: number;
  /** Chunks sent to the embeddings model. */
  embedded: number;
  /** Stored chunks of the document that are gone (their text no longer occurs). */
  removed: number;
  /** The ids the document's chunks are stored under, in order. */
  ids: string[];
}

/** JSON with sorted keys: Postgres hands metadata back with its own key order. */
function canonical(value: JsonValue | undefined): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as JsonObject)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Diff one document's new chunks against what `match` selects, embed only the hashes the collection does not hold
 * for this embeddings model, and replace the document's chunks in one step. A document that did not change writes
 * nothing. Throws (leaving the old chunks) when embedding or the write fails.
 */
export async function syncDocument(store: VectorStore, embeddings: Embeddings, input: SyncInput, signal?: AbortSignal): Promise<SyncResult> {
  const { collection, match, documentKey } = input;
  const embedKey = embedKeyOf(embeddings);
  const repeats = new Map<string, number>();
  const prepared = input.chunks.map(({ text, metadata }) => {
    const hash = chunkHash(text);
    const n = repeats.get(hash) ?? 0;
    repeats.set(hash, n + 1);
    return { text, hash, id: `${documentKey}:${hash.slice(0, 16)}:${n}`, metadata: { ...metadata, chunkHash: hash, embedKey, documentKey } as JsonObject };
  });

  const stored = await store.metadataWhere(collection, match);
  const storedById = new Map(stored.map((row) => [row.id, row.metadata]));
  const unchanged = stored.length === prepared.length && prepared.every((chunk) => canonical(storedById.get(chunk.id)) === canonical(chunk.metadata));
  if (unchanged) {
    const result = { reused: prepared.length, embedded: 0, removed: 0, ids: prepared.map((chunk) => chunk.id) };
    recordChunks(result);
    return result;
  }

  const hashes = [...new Set(prepared.map((chunk) => chunk.hash))];
  // Stored metadata is only a claim: a vector is reused only when the stored text really hashes to the key.
  const held = new Map<string, number[]>();
  for (const [hash, chunk] of await store.vectorsByHash(collection, hashes, embedKey)) if (chunkHash(chunk.content) === hash) held.set(hash, chunk.embedding);
  const missing = hashes.filter((hash) => !held.has(hash));
  const textOf = new Map(prepared.map((chunk) => [chunk.hash, chunk.text]));
  let fresh = new Map<string, number[]>();
  if (missing.length) {
    const vectors = await embeddings.embedDocuments(missing.map((hash) => textOf.get(hash)!), signal);
    if (vectors.length !== missing.length) throw new Error(`The embeddings model returned ${vectors.length} vectors for ${missing.length} texts`);
    fresh = new Map(missing.map((hash, i) => [hash, vectors[i]]));
    // The same model at another size (a dimensions setting changed): the held vectors do not fit the new ones.
    const size = vectors[0]?.length;
    if (held.size && [...held.values()].some((vector) => vector.length !== size)) {
      const all = await embeddings.embedDocuments(hashes.map((hash) => textOf.get(hash)!), signal);
      if (all.length !== hashes.length) throw new Error(`The embeddings model returned ${all.length} vectors for ${hashes.length} texts`);
      fresh = new Map(hashes.map((hash, i) => [hash, all[i]]));
      held.clear();
    }
  }
  const embedded = fresh.size;
  const add: StoreInput[] = prepared.map((chunk) => ({ id: chunk.id, pageContent: chunk.text, metadata: chunk.metadata, embedding: fresh.get(chunk.hash) ?? held.get(chunk.hash)! }));
  await replaceDocuments(store, collection, { remove: match, add });
  const newIds = new Set(prepared.map((chunk) => chunk.id));
  const result = { reused: prepared.length - embedded, embedded, removed: stored.filter((row) => !newIds.has(row.id)).length, ids: prepared.map((chunk) => chunk.id) };
  recordChunks(result);
  return result;
}
