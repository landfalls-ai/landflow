/**
 * Vector store nodes: In-Memory, SQLite and PGVector. As in n8n, one node works
 * in four modes, and its ports follow the mode (PortDescriptor.displayOptions):
 * - Insert Documents (main flow): input items → the Document loader → the
 *   Embedding model → the collection;
 * - Get Many (main flow): one search per input item, one output item per result;
 * - Retrieve Documents (As Tool for AI Agent): an `ai_tool` sub-node;
 * - Retrieve Documents (As Retriever for Chain): an `ai_retriever` sub-node.
 * Searches are by vector or hybrid (vector + keywords, fused with RRF), with an
 * optional Reranker sub-node and exact-match metadata filters.
 */
import {
  defineCredentialType,
  defineNode,
  NodeOperationError,
  type IBaseContext,
  type JsonObject,
  type NodeItem,
  type PortDescriptor,
  type PropertyDescriptor,
} from '@landflow/sdk';
import { toToolName, type AgentTool, type AiDocument, type DocumentLoader, type Embeddings, type Reranker, type Retriever } from '@landflow/engine';
import {
  insertDocuments,
  MemoryVectorStore,
  PgVectorStore,
  searchStore,
  SqliteVectorStore,
  type MetadataFilter,
  type PgConfig,
  type SearchMode,
  type VectorStore,
} from '../rag/stores';

type Mode = 'insert' | 'load' | 'retrieve-as-tool' | 'retrieve';
const SUB_MODES: Mode[] = ['retrieve-as-tool', 'retrieve'];
const SEARCH_MODES: Mode[] = ['load', 'retrieve-as-tool', 'retrieve'];
const VECTOR_COLOR = '#0ea5e9';

const MODE_LABEL: Record<Mode, string> = {
  insert: 'Insert Documents',
  load: 'Get Many',
  'retrieve-as-tool': 'Retrieve Documents (As Tool for AI Agent)',
  retrieve: 'Retrieve Documents (As Retriever for Chain)',
};

const PORTS: { inputs: PortDescriptor[]; outputs: PortDescriptor[] } = {
  inputs: [
    { type: 'main', displayOptions: { show: { mode: ['insert', 'load'] } } },
    { type: 'ai_document', displayName: 'Document', required: true, maxConnections: 1, displayOptions: { show: { mode: ['insert'] } } },
    { type: 'ai_embedding', displayName: 'Embedding', required: true, maxConnections: 1 },
    { type: 'ai_reranker', displayName: 'Reranker', required: true, maxConnections: 1, displayOptions: { show: { useReranker: [true] }, hide: { mode: ['insert'] } } },
  ],
  outputs: [
    { type: 'main', displayOptions: { show: { mode: ['insert', 'load'] } } },
    { type: 'ai_tool', displayName: 'Tool', displayOptions: { show: { mode: ['retrieve-as-tool'] } } },
    { type: 'ai_retriever', displayName: 'Retriever', displayOptions: { show: { mode: ['retrieve'] } } },
  ],
};

/** Properties every vector store has, after its own (collection, table…). */
const COMMON_PROPERTIES: PropertyDescriptor[] = [
  {
    name: 'clearStore',
    displayName: 'Clear Collection',
    type: 'boolean',
    default: false,
    description: 'Delete what the collection holds before inserting',
    displayOptions: { show: { mode: ['insert'] } },
  },
  { name: 'prompt', displayName: 'Prompt', type: 'string', default: '{{ $json.chatInput }}', required: true, description: 'What to search for, per input item', displayOptions: { show: { mode: ['load'] } } },
  { name: 'toolName', displayName: 'Tool Name', type: 'string', default: '', placeholder: 'search_docs', description: 'Defaults to the node name', displayOptions: { show: { mode: ['retrieve-as-tool'] } } },
  {
    name: 'toolDescription',
    displayName: 'Tool Description',
    type: 'string',
    default: 'Search the knowledge base for passages that help answer a question. Use it before answering questions about the documents.',
    typeOptions: { rows: 2 },
    description: 'Tells the model when to use the tool',
    displayOptions: { show: { mode: ['retrieve-as-tool'] } },
  },
  { name: 'topK', displayName: 'Limit', type: 'number', default: 4, typeOptions: { minValue: 1, maxValue: 100 }, description: 'Documents to return', displayOptions: { show: { mode: SEARCH_MODES } } },
  {
    name: 'includeDocumentMetadata',
    displayName: 'Include Metadata',
    type: 'boolean',
    default: true,
    displayOptions: { show: { mode: ['load', 'retrieve-as-tool'] } },
  },
  {
    name: 'useReranker',
    displayName: 'Rerank Results',
    type: 'boolean',
    default: false,
    description: 'Attach a Reranker sub-node that re-orders the results by relevance',
    displayOptions: { show: { mode: SEARCH_MODES } },
  },
  {
    name: 'options',
    displayName: 'Options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    displayOptions: { show: { mode: SEARCH_MODES } },
    values: [
      {
        name: 'searchMode',
        displayName: 'Search',
        type: 'options',
        default: 'vector',
        options: [
          { name: 'Vector', value: 'vector', description: 'By meaning: cosine similarity of the embeddings' },
          { name: 'Hybrid (Vector + Keywords)', value: 'hybrid', description: 'Also by keywords (BM25 / full-text), merged with reciprocal rank fusion' },
        ],
      },
      { name: 'candidates', displayName: 'Candidates', type: 'number', default: 20, typeOptions: { minValue: 1 }, description: 'Results each search contributes before fusion or reranking' },
      {
        name: 'metadataFilter',
        displayName: 'Metadata Filter',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        description: 'Only documents whose metadata has all of these values',
        groups: [
          {
            name: 'values',
            displayName: 'Condition',
            values: [
              { name: 'name', displayName: 'Name', type: 'string', default: '' },
              { name: 'value', displayName: 'Value', type: 'string', default: '' },
            ],
          },
        ],
      },
    ],
  },
];

const modeProperty: PropertyDescriptor = {
  name: 'mode',
  displayName: 'Operation Mode',
  type: 'options',
  default: 'insert',
  noDataExpression: true,
  options: (Object.keys(MODE_LABEL) as Mode[]).map((value) => ({ name: MODE_LABEL[value], value })),
};

const collectionProperty = (fallback: string): PropertyDescriptor => ({
  name: 'collection',
  displayName: 'Collection',
  type: 'string',
  default: fallback,
  required: true,
  description: 'Documents are kept per collection; insert and search with the same name',
});

export interface SearchOptionsParam {
  searchMode?: SearchMode;
  candidates?: number;
  metadataFilter?: { values?: Array<{ name?: string; value?: unknown }> };
}

/** Metadata filter conditions; values that look like numbers or booleans match as such. */
function metadataFilter(raw: SearchOptionsParam['metadataFilter']): MetadataFilter | undefined {
  const entries = (raw?.values ?? []).flatMap((entry) => {
    const name = String(entry.name ?? '').trim();
    if (!name) return [];
    const value = entry.value;
    const parsed = value === 'true' ? true : value === 'false' ? false : typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value)) ? Number(value) : value;
    return [[name, parsed ?? null]];
  });
  return entries.length ? (Object.fromEntries(entries) as MetadataFilter) : undefined;
}

export interface Searcher {
  store: VectorStore;
  collection: string;
  embeddings: Embeddings;
  reranker?: Reranker;
  options: SearchOptionsParam;
  signal?: AbortSignal;
}

/** Embed the query, search (vector or hybrid) and rerank when a reranker is attached. */
export async function search(searcher: Searcher, query: string, topK: number): Promise<AiDocument[]> {
  const text = query.trim();
  if (!text) throw new NodeOperationError('The search query is empty');
  const { store, collection, embeddings, reranker, options, signal } = searcher;
  const k = Math.max(1, Math.floor(topK));
  const candidates = Math.max(k, Number(options.candidates) || 20);
  const vector = await embeddings.embedQuery(text, signal);
  const found = await searchStore(store, collection, {
    query: text,
    vector,
    topK: reranker ? candidates : k,
    mode: options.searchMode === 'hybrid' ? 'hybrid' : 'vector',
    candidates,
    ...(metadataFilter(options.metadataFilter) && { filter: metadataFilter(options.metadataFilter) }),
  });
  if (!reranker) return found.slice(0, k);
  return (await reranker.rerank(text, found, { topK: k, ...(signal && { signal }) })).slice(0, k);
}

const documentJson = (doc: AiDocument, includeMetadata: boolean): JsonObject => ({
  pageContent: doc.pageContent,
  ...(includeMetadata && { metadata: doc.metadata }),
});

interface StoreSpec {
  name: string;
  displayName: string;
  description: string;
  icon: string;
  keywords: string[];
  credentials?: Array<{ name: string; required?: boolean }>;
  /** The store's own properties (collection first), shown in every mode. */
  properties: PropertyDescriptor[];
  open(ctx: IBaseContext): VectorStore;
}

async function connected<T>(ctx: Pick<IBaseContext, 'getNode'> & { getInputConnectionData?: <U>(type: never, index?: number) => Promise<U[]> }, type: string, message: string, description: string): Promise<T> {
  const [value] = ctx.getInputConnectionData ? await ctx.getInputConnectionData<T>(type as never) : [];
  if (!value) throw new NodeOperationError(message, { description });
  return value;
}

function vectorStoreNode(spec: StoreSpec) {
  const collectionOf = (ctx: IBaseContext) => {
    const collection = String(ctx.getNodeParameter('collection', 0, '') ?? '').trim();
    if (!collection) throw new NodeOperationError('No collection set', { description: 'Set “Collection” to the name the documents are kept under.' });
    return collection;
  };
  const embeddingsOf = (ctx: Parameters<typeof connected>[0]) =>
    connected<Embeddings>(ctx, 'ai_embedding', 'No embeddings model connected', `Attach an embeddings sub-node (e.g. Embeddings Ollama) to the “Embedding” slot of “${ctx.getNode().name}”.`);
  const rerankerOf = async (ctx: IBaseContext & Parameters<typeof connected>[0]) =>
    ctx.getNodeParameter('useReranker', 0, false)
      ? connected<Reranker>(ctx, 'ai_reranker', 'No reranker connected', 'Attach a Reranker sub-node, or turn off “Rerank Results”.')
      : undefined;

  return defineNode({
    description: {
      name: spec.name,
      displayName: spec.displayName,
      description: spec.description,
      version: 1,
      kind: 'action',
      categories: ['AI', 'Vector Stores'],
      icon: spec.icon,
      color: VECTOR_COLOR,
      subtitle: '{{mode}} · {{collection}}',
      keywords: [...spec.keywords, 'vector store', 'rag', 'embeddings', 'retriever', 'knowledge base', 'semantic search', 'hybrid search'],
      ...(spec.credentials && { credentials: spec.credentials }),
      inputs: PORTS.inputs,
      outputs: PORTS.outputs,
      properties: [modeProperty, ...spec.properties, ...COMMON_PROPERTIES],
    },

    async execute(ctx) {
      const mode = ctx.getNodeParameter<Mode>('mode', 0) ?? 'insert';
      if (SUB_MODES.includes(mode)) {
        throw new NodeOperationError(`In “${MODE_LABEL[mode]}” mode the vector store is a sub-node`, {
          description: mode === 'retrieve' ? 'Attach it to a chain’s “Retriever” slot.' : 'Attach it to an AI Agent’s “Tool” slot.',
        });
      }
      const store = spec.open(ctx);
      const collection = collectionOf(ctx);
      const embeddings = await embeddingsOf(ctx);
      const items = ctx.getInputData();

      if (mode === 'insert') {
        const loader = await connected<DocumentLoader>(ctx, 'ai_document', 'No document loader connected', 'Attach a Default Data Loader to the “Document” slot.');
        if (ctx.getNodeParameter<boolean>('clearStore', 0)) await store.clear(collection);
        const documents = await loader.load(items);
        if (!documents.length) {
          ctx.logger.warn('The document loader produced no documents: nothing to insert');
          return [[]];
        }
        const vectors = await embeddings.embedDocuments(documents.map((doc) => doc.pageContent), ctx.signal);
        const ids = await insertDocuments(
          store,
          collection,
          documents.map((doc, i) => ({ pageContent: doc.pageContent, metadata: doc.metadata, embedding: vectors[i] })),
        );
        ctx.logger.info(`Inserted ${ids.length} document(s) into “${collection}” (${store.kind})`);
        return [
          documents.map(
            (doc, i): NodeItem => ({
              json: { id: ids[i], pageContent: doc.pageContent, metadata: doc.metadata },
              pairedItem: { item: Math.min(items.length - 1, Math.max(0, Number(doc.metadata.itemIndex) || 0)) },
            }),
          ),
        ];
      }

      // Get Many: one search per input item.
      const reranker = await rerankerOf(ctx);
      const out: NodeItem[] = [];
      for (const [i] of items.entries()) {
        const options = ctx.getNodeParameter<SearchOptionsParam>('options', i) ?? {};
        const includeMetadata = ctx.getNodeParameter<boolean>('includeDocumentMetadata', i) !== false;
        const query = String(ctx.getNodeParameter('prompt', i) ?? '');
        if (!query.trim()) throw new NodeOperationError('The prompt is empty', { itemIndex: i, description: 'Set “Prompt” to what to search for, e.g. {{ $json.chatInput }}.' });
        const documents = await search({ store, collection, embeddings, reranker, options, signal: ctx.signal }, query, Number(ctx.getNodeParameter('topK', i)) || 4);
        for (const doc of documents) out.push({ json: { document: documentJson(doc, includeMetadata), score: doc.score ?? null }, pairedItem: { item: i } });
      }
      return [out];
    },

    /** Retrieve modes: a tool for an AI Agent and a retriever for chains (one object serves both). */
    async supplyData(ctx): Promise<AgentTool & Retriever> {
      const mode = ctx.getNodeParameter<Mode>('mode') ?? 'insert';
      if (!SUB_MODES.includes(mode)) {
        throw new NodeOperationError(`“${ctx.getNode().name}” is in “${MODE_LABEL[mode]}” mode`, {
          description: 'Set “Operation Mode” to “Retrieve Documents (As Tool for AI Agent)” or “(As Retriever for Chain)” to attach it to an agent or chain.',
        });
      }
      const store = spec.open(ctx);
      const searcher: Searcher = {
        store,
        collection: collectionOf(ctx),
        embeddings: await embeddingsOf(ctx),
        reranker: await rerankerOf(ctx),
        options: ctx.getNodeParameter<SearchOptionsParam>('options') ?? {},
      };
      const topK = Number(ctx.getNodeParameter('topK')) || 4;
      const includeMetadata = ctx.getNodeParameter<boolean>('includeDocumentMetadata', 0, true) !== false;
      return {
        name: toToolName(String(ctx.getNodeParameter('toolName', 0, '') || ctx.getNode().name)),
        description: String(ctx.getNodeParameter('toolDescription', 0, '') || `Search the “${searcher.collection}” knowledge base`),
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'What to look for, in natural language' } },
          required: ['query'],
        },
        async invoke(input, signal) {
          const documents = await search({ ...searcher, ...(signal && { signal }) }, String(input.query ?? ''), topK);
          return { results: documents.map((doc) => ({ ...documentJson(doc, includeMetadata), ...(doc.score !== undefined && { score: doc.score }) })) };
        },
        retrieve: (query, options) => search({ ...searcher, ...(options?.signal && { signal: options.signal }) }, query, options?.topK ?? topK),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// The three stores
// ---------------------------------------------------------------------------

export const inMemoryVectorStoreNode = vectorStoreNode({
  name: 'vectorStoreInMemory',
  displayName: 'In-Memory Vector Store',
  description: 'Keep documents and their embeddings in the server’s memory (until it restarts) and search them',
  icon: 'lucide:memory-stick',
  keywords: ['memory', 'simple vector store', 'in memory'],
  properties: [collectionProperty('vector_store_key')],
  open: () => new MemoryVectorStore(),
});

export const sqliteVectorStoreNode = vectorStoreNode({
  name: 'vectorStoreSqlite',
  displayName: 'SQLite Vector Store',
  description: 'Keep documents and their embeddings in a SQLite file in Landflow’s data folder and search them',
  icon: 'brand:sqlite',
  keywords: ['sqlite', 'local', 'file', 'persistent'],
  properties: [collectionProperty('landflow')],
  open: () => new SqliteVectorStore(),
});

/** Postgres connection settings (host, port, database, user, password, SSL), used by the PGVector store. */
export const postgresCredential = defineCredentialType({
  name: 'postgres',
  displayName: 'Postgres',
  description: 'A Postgres database. The PGVector store needs the vector extension (CREATE EXTENSION vector).',
  icon: 'brand:postgresql',
  documentationUrl: 'https://github.com/pgvector/pgvector',
  properties: [
    { name: 'host', displayName: 'Host', type: 'string', default: 'localhost', required: true },
    { name: 'port', displayName: 'Port', type: 'number', default: 5432, required: true },
    { name: 'database', displayName: 'Database', type: 'string', default: 'postgres', required: true },
    { name: 'user', displayName: 'User', type: 'string', default: 'postgres', required: true },
    { name: 'password', displayName: 'Password', type: 'string', default: '', typeOptions: { password: true } },
    {
      name: 'ssl',
      displayName: 'SSL',
      type: 'options',
      default: 'disable',
      options: [
        { name: 'Disable', value: 'disable' },
        { name: 'Require (any certificate)', value: 'require' },
        { name: 'Verify Certificate', value: 'verify' },
      ],
    },
  ],
  async test(data) {
    const { default: pg } = await import('pg');
    const config = pgConfig(data);
    const client = new pg.Client({ ...config, ...(config.ssl !== 'disable' ? { ssl: { rejectUnauthorized: config.ssl === 'verify' } } : { ssl: false }), connectionTimeoutMillis: 10_000 });
    try {
      await client.connect();
      const { rows } = await client.query<{ version: string | null }>("SELECT (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS version");
      const version = rows[0]?.version;
      return { ok: true, message: version ? `Connected; pgvector ${version} is installed` : 'Connected; the vector extension is not installed yet (the PGVector store creates it if it may)' };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    } finally {
      await client.end().catch(() => undefined);
    }
  },
});

/** A `postgres` credential's values as connection settings. */
export function pgConfig(data: JsonObject | undefined): PgConfig {
  const text = (value: unknown, fallback = '') => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
  const ssl = text(data?.ssl, 'disable');
  return {
    host: text(data?.host, 'localhost'),
    port: Number(data?.port) || 5432,
    database: text(data?.database, 'postgres'),
    user: text(data?.user, 'postgres'),
    ...(typeof data?.password === 'string' && data.password && { password: data.password }),
    ssl: ssl === 'require' || ssl === 'verify' ? ssl : 'disable',
  };
}

export const pgVectorStoreNode = vectorStoreNode({
  name: 'vectorStorePGVector',
  displayName: 'Postgres PGVector Store',
  description: 'Keep documents and their embeddings in Postgres with pgvector and search them',
  icon: 'brand:postgresql',
  keywords: ['postgres', 'postgresql', 'pgvector', 'pg'],
  credentials: [{ name: 'postgres', required: true }],
  properties: [
    collectionProperty('landflow'),
    { name: 'tableName', displayName: 'Table Name', type: 'string', default: 'landflow_vectors', description: 'Created if missing; one table can hold many collections' },
  ],
  open: (ctx) => new PgVectorStore(pgConfig(ctx.getCredentials('postgres')), String(ctx.getNodeParameter('tableName', 0, 'landflow_vectors') || 'landflow_vectors')),
});
