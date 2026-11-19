/**
 * Knowledge bases for standalone agents: a vector store collection (in-memory, SQLite or PGVector)
 * offered to the model as a `search_…` tool. The same store code as the vector store nodes, so a
 * workflow that inserts documents into a collection fills the knowledge base of that name.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { nanoid } from 'nanoid';
import { toToolName, type Embeddings } from '@landflow/engine';
import type { VectorKnowledgeBaseConfig as KnowledgeBaseToolConfig } from '../../shared/agents';
import { credentials } from '../credentials/vault';
import { openAiConnection } from '../nodes/models';
import { resolveInFilesDir } from '../nodes/files';
import { pgConfig, search } from '../nodes/vector-stores';
import { registry } from '../plugins/registry';
import { ollamaEmbeddings, openAiCompatibleEmbeddings } from '../rag/embeddings';
import { fileDocuments, fileKind, type FileInput } from '../rag/files';
import { recursiveCharacterSplit } from '../rag/splitters';
import { insertDocuments, MemoryVectorStore, PgVectorStore, SqliteVectorStore, type VectorStore } from '../rag/stores';
import type { JsonObject } from '@landflow/protocol';
import type { BuiltTool } from './tools';
import { targetOfKnowledge } from './tool-target'; // AG14:
import { ollamaUrl } from '../config';
import { isBrainCollection } from '../../shared/brain'; // NB06:
import { NOTION_DATA_NOTE } from '../brain/notion/data-note'; // NB06:

/** The vector store node each kind of store matches (its icon in the timeline, its credential requirement). */
export const KNOWLEDGE_STORE_NODE: Record<KnowledgeBaseToolConfig['store'], string> = {
  memory: 'core.vectorStoreInMemory',
  sqlite: 'core.vectorStoreSqlite',
  pgvector: 'core.vectorStorePGVector',
};
const OPENAI_EMBEDDINGS_NODE = 'core.embeddingsOpenAi';

/** A credential of `nodeType`'s requirement `name`, decrypted. */
function credentialFor(nodeType: string, name: string, ref: KnowledgeBaseToolConfig['credential']) {
  const resolved = registry.resolve(nodeType);
  if ('error' in resolved) throw new Error(resolved.error);
  return credentials.resolveFor({ type: nodeType, credentials: ref ? { [name]: ref } : undefined, parameters: {} }, resolved.descriptor)[name];
}

/**
 * NB06: the second brain's collections (`landflow-brain*`, `landflow-notion-<project>`) hold what other projects wrote, so no
 * agent's or project's saved knowledge setting may open one. The runtime alone passes `internal` for a project's own Notion brain
 * (the option is never read from a saved config).
 */
export interface KnowledgeInternal {
  allowReserved?: boolean;
}
const reserved = (collection: string) => `“${collection.trim()}” is the second brain’s own collection`;

function openStore(config: KnowledgeBaseToolConfig, internal?: KnowledgeInternal): VectorStore {
  if (!internal?.allowReserved && isBrainCollection(config.collection ?? '')) throw new Error(reserved(config.collection)); // NB06:
  // AG13: keyword search has no real vectors, and Postgres needs them
  if (config.store === 'pgvector' && config.embeddings?.provider === 'none') throw new Error('Keyword search (no embeddings model) works with the SQLite and in-memory stores only: Postgres needs real vectors. Pick an embeddings model');
  if (config.store === 'memory') return new MemoryVectorStore();
  if (config.store === 'sqlite') return new SqliteVectorStore();
  return new PgVectorStore(pgConfig(credentialFor(KNOWLEDGE_STORE_NODE.pgvector, 'postgres', config.credential)), config.tableName?.trim() || 'landflow_vectors');
}

function embeddingsFor(config: KnowledgeBaseToolConfig['embeddings']): Embeddings {
  const dimensions = Number(config.dimensions) > 0 ? Number(config.dimensions) : undefined;
  // AG13: keyword search stores one dimension per passage and makes no call: the stores' dimension checks hold, and nothing is embedded
  if (config.provider === 'none') return { provider: 'none', model: 'bm25', embedDocuments: async (texts) => texts.map(() => [0]), embedQuery: async () => [0] };
  if (config.provider === 'openai') {
    return openAiCompatibleEmbeddings(openAiConnection(credentialFor(OPENAI_EMBEDDINGS_NODE, 'openAiApi', config.credential), config.credential?.id), {
      model: config.model || 'text-embedding-3-small',
      ...(dimensions && { dimensions }),
    });
  }
  return ollamaEmbeddings({
    baseUrl: config.baseUrl?.trim() || ollamaUrl(),
    model: config.model || 'nomic-embed-text',
    ...(dimensions && { dimensions }),
    ...(config.queryPrefix && { queryPrefix: config.queryPrefix }),
  });
}

/** The knowledge base as a tool: `{ query }` in, the best-matching passages out. */
export function knowledgeTool(config: KnowledgeBaseToolConfig, internal?: KnowledgeInternal): BuiltTool | { error: string } {
  const label = config.name || config.collection || 'Knowledge base';
  if (!config.collection?.trim()) return { error: `${label}: no collection set` };
  let store: VectorStore;
  let embeddings: Embeddings;
  try {
    store = openStore(config, internal);
    embeddings = embeddingsFor(config.embeddings);
  } catch (error) {
    return { error: `${label}: ${(error as Error).message}` };
  }
  const topK = Math.min(50, Math.max(1, Number(config.topK) || 4));
  return {
    kind: 'node',
    knowledge: true,
    // AG14: the collection, the store and how it searched; the document count comes with each call (cheap on SQLite only).
    target: targetOfKnowledge({ collection: config.collection.trim(), store: config.store, embeddings: config.embeddings }),
    nodeType: KNOWLEDGE_STORE_NODE[config.store],
    name: toToolName(config.name || `search_${config.collection}`),
    label,
    description: config.description || `Search the “${config.collection}” knowledge base for passages that help answer a question`,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to look for, in natural language' } },
      required: ['query'],
    },
    requireApproval: Boolean(config.requireApproval),
    async invoke(input, ctx) {
      const documents = await search(
        { store, collection: config.collection.trim(), embeddings, options: { searchMode: config.searchMode ?? 'vector' }, ...(ctx.signal && { signal: ctx.signal }) },
        String(input.query ?? ''),
        topK,
      );
      // AG14: with the document count, when it is cheap to read (the SQLite store).
      const count = config.store === 'sqlite' ? await documentCount(config, internal).catch(() => undefined) : undefined;
      return {
        output: {
          // NB06: the Notion brain's passages are other people's words: quoted data, not instructions.
          ...(internal?.allowReserved && { note: NOTION_DATA_NOTE }),
          results: documents.map((doc) => ({ pageContent: doc.pageContent, metadata: doc.metadata, ...(doc.score !== undefined && { score: doc.score }) })),
        },
        ...(count !== undefined && { target: targetOfKnowledge({ collection: config.collection.trim(), store: config.store, embeddings: config.embeddings }, count) }),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Uploaded documents
// ---------------------------------------------------------------------------

/** A document of the knowledge base, as the builder lists it (its chunks grouped by `documentId`). */
export interface KnowledgeDocument {
  documentId: string;
  fileName: string;
  mimeType?: string;
  chunks: number;
  pages?: number;
  uploadedAt?: string;
}

/** Files up to this size can be uploaded from the builder. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Add a file to the knowledge base: text from the loader (PDF, DOCX, text, Markdown, HTML, CSV, JSON), cut into
 * chunks by the recursive splitter, embedded with the base's embeddings model and stored in its collection with
 * `documentId`, `fileName`, `page` (where known) and `uploadedAt` metadata.
 */
export async function addKnowledgeDocument(config: KnowledgeBaseToolConfig, file: FileInput, extra: JsonObject = {}): Promise<KnowledgeDocument> { // AG13: `extra` (`{ source }`) joins every chunk's metadata
  if (!config.collection?.trim()) throw new Error('The knowledge base has no collection');
  const store = openStore(config);
  const embeddings = embeddingsFor(config.embeddings);
  const documentId = `doc_${nanoid(10)}`;
  const uploadedAt = new Date().toISOString();
  const documents = await fileDocuments(file, async (text) => recursiveCharacterSplit(text, { chunkSize: 1000, chunkOverlap: 200 }), { documentId, uploadedAt, ...extra });
  if (!documents.length) throw new Error(`${file.fileName ?? 'The file'} has no text to load (scanned PDFs need OCR first)`);
  const vectors = await embeddings.embedDocuments(documents.map((doc) => doc.pageContent));
  await insertDocuments(
    store,
    config.collection.trim(),
    documents.map((doc, i) => ({ pageContent: doc.pageContent, metadata: doc.metadata, embedding: vectors[i] })),
  );
  const pages = new Set(documents.map((doc) => doc.metadata.page).filter((page) => page !== undefined));
  return {
    documentId,
    fileName: file.fileName ?? 'document',
    ...(file.mimeType && { mimeType: file.mimeType }),
    chunks: documents.length,
    ...(pages.size && { pages: pages.size }),
    uploadedAt,
  };
}

/** The uploaded documents of the collection (chunks without a `documentId`, inserted by workflows, are counted apart). */
export async function listKnowledgeDocuments(config: KnowledgeBaseToolConfig, internal?: KnowledgeInternal): Promise<{ documents: KnowledgeDocument[]; otherChunks: number }> {
  const rows = await openStore(config, internal).metadataOf(config.collection.trim());
  const byId = new Map<string, KnowledgeDocument>();
  const pages = new Map<string, Set<unknown>>();
  let otherChunks = 0;
  for (const { metadata } of rows) {
    const documentId = typeof metadata.documentId === 'string' ? metadata.documentId : undefined;
    if (!documentId) {
      otherChunks++;
      continue;
    }
    const entry = byId.get(documentId) ?? {
      documentId,
      fileName: String(metadata.fileName ?? 'document'),
      ...(typeof metadata.mimeType === 'string' && { mimeType: metadata.mimeType }),
      chunks: 0,
      ...(typeof metadata.uploadedAt === 'string' && { uploadedAt: metadata.uploadedAt }),
    };
    entry.chunks++;
    if (metadata.page !== undefined) pages.set(documentId, (pages.get(documentId) ?? new Set()).add(metadata.page));
    byId.set(documentId, entry);
  }
  for (const [id, set] of pages) byId.get(id)!.pages = set.size;
  return { documents: [...byId.values()], otherChunks };
}

/** The documents a base holds: uploads by `documentId`, and (the Notion brain's) pages by `pageId`. */
async function documentCount(config: KnowledgeBaseToolConfig, internal?: KnowledgeInternal): Promise<number> {
  if (!internal?.allowReserved) return (await listKnowledgeDocuments(config, internal)).documents.length;
  const rows = await openStore(config, internal).metadataOf(config.collection.trim());
  return new Set(rows.map((row) => row.metadata.pageId).filter((id) => typeof id === 'string')).size;
}

/** Remove one uploaded document (all its chunks); returns how many chunks went. */
export function deleteKnowledgeDocument(config: KnowledgeBaseToolConfig, documentId: string): Promise<number> {
  return openStore(config).deleteWhere(config.collection.trim(), { documentId });
}

// ---------------------------------------------------------------------------
// AG13: indexing a folder of the files directory
// ---------------------------------------------------------------------------

/** At most this many files of a folder are indexed (the rest are not listed). */
export const MAX_FOLDER_FILES = 200;

/**
 * The files of `folder` (relative to the files directory) the loaders read, as paths relative to the files directory
 * (`runbooks/disk-full.md`), sorted, recursive, skipping dotfiles and anything a symlink leads out of the files directory.
 * Lists only; never reads a file. Throws when the folder is outside the files directory or is not a folder.
 */
export async function folderFiles(folder: string): Promise<{ root: string; files: string[]; truncated: boolean }> {
  const { root, path } = await resolveInFilesDir(folder);
  const top = await stat(path).catch(() => undefined);
  if (!top?.isDirectory()) throw new Error(`No folder named ${folder} in the files directory`);
  const files: string[] = [];
  let truncated = false;
  const walk = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join('/');
      try {
        await resolveInFilesDir(rel); // a symlink that leads out of the files directory throws here
        const info = await stat(full);
        if (info.isDirectory()) await walk(full);
        else if (info.isFile() && fileKind({ bytes: new Uint8Array(0), fileName: entry.name })) {
          if (files.length >= MAX_FOLDER_FILES) truncated = true;
          else files.push(rel);
        }
      } catch {
        // skipped: outside the files directory, or gone since it was listed
      }
    }
  };
  await walk(path);
  return { root, files, truncated };
}

export interface FolderIndex {
  documents: number;
  chunks: number;
  failed: Array<{ file: string; error: string }>;
}

/**
 * Index every file of `folder` into the knowledge base, each chunk carrying `source` (the file's path relative to the
 * files directory). Chunks of a file indexed before (same `source`) are removed first, so indexing twice replaces and
 * never duplicates.
 */
export async function indexFolder(config: KnowledgeBaseToolConfig, folder: string): Promise<FolderIndex> {
  const { files } = await folderFiles(folder);
  const store = openStore(config);
  const collection = config.collection.trim();
  const result: FolderIndex = { documents: 0, chunks: 0, failed: [] };
  for (const file of files) {
    try {
      const { path } = await resolveInFilesDir(file);
      const info = await stat(path);
      if (info.size > MAX_UPLOAD_BYTES) throw new Error(`Too large (${Math.round(info.size / 1024 / 1024)} MB; the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
      const bytes = new Uint8Array(await readFile(path));
      await store.deleteWhere(collection, { source: file });
      const added = await addKnowledgeDocument(config, { bytes, fileName: file }, { source: file });
      result.documents++;
      result.chunks += added.chunks;
    } catch (caught) {
      result.failed.push({ file, error: (caught as Error).message.slice(0, 300) });
    }
  }
  return result;
}
