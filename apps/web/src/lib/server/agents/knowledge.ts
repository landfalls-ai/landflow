/**
 * Knowledge bases for standalone agents: a vector store collection (in-memory, SQLite or PGVector)
 * offered to the model as a `search_…` tool. The same store code as the vector store nodes, so a
 * workflow that inserts documents into a collection fills the knowledge base of that name.
 */
import { toToolName, type Embeddings } from '@landflow/engine';
import type { KnowledgeBaseToolConfig } from '../../shared/agents';
import { credentials } from '../credentials/vault';
import { openAiConnection } from '../nodes/models';
import { pgConfig, search } from '../nodes/vector-stores';
import { registry } from '../plugins/registry';
import { ollamaEmbeddings, openAiCompatibleEmbeddings } from '../rag/embeddings';
import { MemoryVectorStore, PgVectorStore, SqliteVectorStore, type VectorStore } from '../rag/stores';
import type { BuiltTool } from './tools';

/** The vector store node each kind of store matches (its icon in the timeline, its credential requirement). */
export const KNOWLEDGE_STORE_NODE: Record<KnowledgeBaseToolConfig['store'], string> = {
  memory: 'core.vectorStoreInMemory',
  sqlite: 'core.vectorStoreSqlite',
  pgvector: 'core.vectorStorePGVector',
};
const OPENAI_EMBEDDINGS_NODE = 'core.embeddingsOpenAi';
const DEFAULT_OLLAMA_URL = (process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');

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
    return openAiCompatibleEmbeddings(openAiConnection(credentialFor(OPENAI_EMBEDDINGS_NODE, 'openAiApi', config.credential)), {
      model: config.model || 'text-embedding-3-small',
      ...(dimensions && { dimensions }),
    });
  }
  return ollamaEmbeddings({
    baseUrl: config.baseUrl?.trim() || DEFAULT_OLLAMA_URL,
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
