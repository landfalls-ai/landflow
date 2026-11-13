/**
 * Knowledge bases for standalone agents: a vector store collection (in-memory, SQLite or PGVector)
 * offered to the model as a `search_…` tool. The same store code as the vector store nodes, so a
 * workflow that inserts documents into a collection fills the knowledge base of that name.
 */
import { nanoid } from 'nanoid';
import { toToolName, type Embeddings } from '@landflow/engine';
import type { KnowledgeBaseToolConfig } from '../../shared/agents';
import { credentials } from '../credentials/vault';
import { openAiConnection } from '../nodes/models';
import { pgConfig, search } from '../nodes/vector-stores';
import { registry } from '../plugins/registry';
import { ollamaEmbeddings, openAiCompatibleEmbeddings } from '../rag/embeddings';
import { fileDocuments, type FileInput } from '../rag/files';
import { recursiveCharacterSplit } from '../rag/splitters';
import { insertDocuments, MemoryVectorStore, PgVectorStore, SqliteVectorStore, type VectorStore } from '../rag/stores';
import type { BuiltTool } from './tools';
import { ollamaUrl } from '../config';

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

function openStore(config: KnowledgeBaseToolConfig): VectorStore {
  if (config.store === 'memory') return new MemoryVectorStore();
  if (config.store === 'sqlite') return new SqliteVectorStore();
  return new PgVectorStore(pgConfig(credentialFor(KNOWLEDGE_STORE_NODE.pgvector, 'postgres', config.credential)), config.tableName?.trim() || 'landflow_vectors');
}

function embeddingsFor(config: KnowledgeBaseToolConfig['embeddings']): Embeddings {
  const dimensions = Number(config.dimensions) > 0 ? Number(config.dimensions) : undefined;
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
export function knowledgeTool(config: KnowledgeBaseToolConfig): BuiltTool | { error: string } {
  const label = config.name || config.collection || 'Knowledge base';
  if (!config.collection?.trim()) return { error: `${label}: no collection set` };
  let store: VectorStore;
  let embeddings: Embeddings;
  try {
    store = openStore(config);
    embeddings = embeddingsFor(config.embeddings);
  } catch (error) {
    return { error: `${label}: ${(error as Error).message}` };
  }
  const topK = Math.min(50, Math.max(1, Number(config.topK) || 4));
  return {
    kind: 'node',
    knowledge: true,
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
      return { output: { results: documents.map((doc) => ({ pageContent: doc.pageContent, metadata: doc.metadata, ...(doc.score !== undefined && { score: doc.score }) })) } };
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
export async function addKnowledgeDocument(config: KnowledgeBaseToolConfig, file: FileInput): Promise<KnowledgeDocument> {
  if (!config.collection?.trim()) throw new Error('The knowledge base has no collection');
  const store = openStore(config);
  const embeddings = embeddingsFor(config.embeddings);
  const documentId = `doc_${nanoid(10)}`;
  const uploadedAt = new Date().toISOString();
  const documents = await fileDocuments(file, async (text) => recursiveCharacterSplit(text, { chunkSize: 1000, chunkOverlap: 200 }), { documentId, uploadedAt });
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
export async function listKnowledgeDocuments(config: KnowledgeBaseToolConfig): Promise<{ documents: KnowledgeDocument[]; otherChunks: number }> {
  const rows = await openStore(config).metadataOf(config.collection.trim());
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

/** Remove one uploaded document (all its chunks); returns how many chunks went. */
export function deleteKnowledgeDocument(config: KnowledgeBaseToolConfig, documentId: string): Promise<number> {
  return openStore(config).deleteWhere(config.collection.trim(), { documentId });
}
