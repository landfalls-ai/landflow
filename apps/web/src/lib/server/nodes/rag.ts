/**
 * Retrieval (RAG) sub-nodes and the Question and Answer Chain, following
 * n8n's cluster nodes:
 * - Embeddings Ollama / Embeddings OpenAI (`ai_embedding`);
 * - Default Data Loader (`ai_document`), with an optional text splitter of its own;
 * - Recursive Character and Token Text Splitters (`ai_textSplitter`);
 * - Reranker (LLM) (`ai_reranker`), scoring passages with an attached chat model, and Reranker (Cohere), Cohere's
 *   `/v2/rerank` (or a compatible server);
 * - Question and Answer Chain: a root node that answers from what a retriever finds.
 * The vector stores that use them are in vector-stores.ts.
 */
import { defineNode, NodeOperationError, type ILoadOptionsContext, type ISupplyDataContext, type JsonObject, type NodeItem, type PropertyOption } from '@landflow/sdk';
import type { AiDocument, Embeddings, LanguageModel, Retriever, TextSplitter } from '@landflow/engine';
import { ollamaEmbeddings, openAiCompatibleEmbeddings } from '../rag/embeddings';
import { FileLoadError, type FileInput } from '../rag/files';
import { loadDocuments, metadataEntries } from '../rag/loader';
import { cohereReranker, llmReranker } from '../rag/rerank';
import { CODE_SEPARATORS, recursiveCharacterSplit, tokenSplit } from '../rag/splitters';
import { connectedModel, FALLBACK_PORT, FALLBACK_PROPERTY } from './fallback';
import { openAiConnection, openAiModels } from './models';
import { ollamaUrl } from '../config';

/** Default Ollama address (OLLAMA_URL, e.g. host.docker.internal in a container). */
const defaultOllamaUrl = () => ollamaUrl();
const RAG_COLOR = '#0ea5e9';
const subnode = { version: 1, kind: 'subnode' as const };

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

/** The server's embedding models (names with "embed"), or every model when none matches. */
async function embeddingModelOptions(ctx: ILoadOptionsContext): Promise<PropertyOption[]> {
  const connection = openAiConnection(ctx.getCredentials('openAiApi', { optional: true }));
  const models = await openAiModels(connection, ctx.http);
  const embedding = models.filter((model) => /embed/i.test(model.id));
  return (embedding.length ? embedding : models).sort((a, b) => a.id.localeCompare(b.id)).map((model) => ({ name: model.id, value: model.id }));
}

const embeddingOutput = [{ type: 'ai_embedding' as const, displayName: 'Embedding' }];

export const embeddingsOllamaNode = defineNode({
  description: {
    ...subnode,
    name: 'embeddingsOllama',
    displayName: 'Embeddings Ollama',
    description: 'Turn text into vectors with a local Ollama embedding model (nomic-embed-text, mxbai-embed-large…)',
    supplies: 'ai_embedding',
    categories: ['AI', 'Embeddings'],
    icon: 'brand:ollama',
    color: '#71717a',
    subtitle: '{{model}}',
    keywords: ['embeddings', 'vectors', 'ollama', 'nomic', 'local', 'rag'],
    inputs: [],
    outputs: embeddingOutput,
    properties: [
      { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: defaultOllamaUrl() },
      {
        name: 'model',
        displayName: 'Model',
        type: 'options',
        default: 'nomic-embed-text',
        options: [{ name: 'nomic-embed-text', value: 'nomic-embed-text' }],
        typeOptions: { loadOptionsMethod: 'models', loadOptionsDependsOn: ['baseUrl'] },
        description: 'Pull it first, e.g. `ollama pull nomic-embed-text`',
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          { name: 'dimensions', displayName: 'Dimensions', type: 'number', default: 0, description: 'Shorten the vectors (0: the model’s size). Only for models trained for it' },
          {
            name: 'documentPrefix',
            displayName: 'Document Prefix',
            type: 'string',
            default: '',
            placeholder: 'search_document: ',
            description: 'Put before every stored text (nomic-embed-text expects “search_document: ”)',
          },
          { name: 'queryPrefix', displayName: 'Query Prefix', type: 'string', default: '', placeholder: 'search_query: ', description: 'Put before every query (nomic-embed-text: “search_query: ”)' },
          { name: 'batchSize', displayName: 'Batch Size', type: 'number', default: 64, typeOptions: { minValue: 1, maxValue: 2048 } },
        ],
      },
    ],
  },
  supplyData(ctx): Embeddings {
    const options = ctx.getNodeParameter<{ dimensions?: number; documentPrefix?: string; queryPrefix?: string; batchSize?: number }>('options') ?? {};
    return ollamaEmbeddings({
      baseUrl: String(ctx.getNodeParameter('baseUrl') || defaultOllamaUrl()),
      model: String(ctx.getNodeParameter('model') || 'nomic-embed-text'),
      ...(Number(options.dimensions) > 0 && { dimensions: Number(options.dimensions) }),
      ...(options.documentPrefix && { documentPrefix: options.documentPrefix }),
      ...(options.queryPrefix && { queryPrefix: options.queryPrefix }),
      ...(options.batchSize && { batchSize: Number(options.batchSize) }),
    });
  },
  methods: {
    loadOptions: {
      async models(ctx) {
        const base = String(ctx.getCurrentParameters().baseUrl || defaultOllamaUrl()).replace(/\/+$/, '');
        const response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3_000) });
        const data = (await response.json()) as { models: Array<{ name: string; details?: { parameter_size?: string; family?: string }; capabilities?: string[] }> };
        // Embedding models report the `embedding` capability; older servers don't report capabilities at all.
        const embedding = data.models.filter((m) => m.capabilities?.includes('embedding') || /embed|bge|minilm|e5|gte/i.test(m.name));
        return (embedding.length ? embedding : data.models).map((m) => ({ name: m.name, value: m.name, ...(m.details?.parameter_size && { description: m.details.parameter_size }) }));
      },
    },
  },
});

export const embeddingsOpenAiNode = defineNode({
  description: {
    ...subnode,
    name: 'embeddingsOpenAi',
    displayName: 'Embeddings OpenAI',
    description: 'Embeddings from OpenAI or any OpenAI-compatible API (Ollama’s /v1, vLLM, LM Studio…)',
    supplies: 'ai_embedding',
    categories: ['AI', 'Embeddings'],
    icon: 'brand:openai',
    color: '#10a37f',
    subtitle: '{{model}}',
    keywords: ['embeddings', 'vectors', 'openai', 'rag'],
    credentials: [{ name: 'openAiApi', required: true }],
    inputs: [],
    outputs: embeddingOutput,
    properties: [
      {
        name: 'model',
        displayName: 'Model',
        type: 'options',
        default: 'text-embedding-3-small',
        options: [{ name: 'text-embedding-3-small', value: 'text-embedding-3-small' }],
        typeOptions: { loadOptionsMethod: 'embeddingModels' },
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          { name: 'dimensions', displayName: 'Dimensions', type: 'number', default: 0, description: 'Shorten the vectors (text-embedding-3 models; 0: full size)' },
          { name: 'batchSize', displayName: 'Batch Size', type: 'number', default: 100, typeOptions: { minValue: 1, maxValue: 2048 } },
        ],
      },
    ],
  },
  supplyData(ctx): Embeddings {
    const options = ctx.getNodeParameter<{ dimensions?: number; batchSize?: number }>('options') ?? {};
    return openAiCompatibleEmbeddings(openAiConnection(ctx.getCredentials('openAiApi')), {
      model: String(ctx.getNodeParameter('model') || 'text-embedding-3-small'),
      ...(Number(options.dimensions) > 0 && { dimensions: Number(options.dimensions) }),
      ...(options.batchSize && { batchSize: Number(options.batchSize) }),
    });
  },
  methods: { loadOptions: { embeddingModels: (ctx) => embeddingModelOptions(ctx) } },
});

// ---------------------------------------------------------------------------
// Document loader
// ---------------------------------------------------------------------------

/** The files of input item `i` named by the loader's “Binary Fields” (none named: all of them). */
async function binaryFiles(ctx: ISupplyDataContext, items: NodeItem[], i: number): Promise<FileInput[]> {
  const binary = items[i]?.binary ?? {};
  const wanted = String(ctx.getNodeParameter('binaryField', i, 'data') ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const keys = wanted.length ? wanted : Object.keys(binary);
  if (!keys.length) throw new NodeOperationError(`Item ${i} has no binary files`, { itemIndex: i, description: 'Send files with the items (a Read/Write Files, HTTP Request or Form node), or use another loader mode.' });
  const files: FileInput[] = [];
  for (const key of keys) {
    const ref = binary[key];
    if (!ref) throw new NodeOperationError(`Item ${i} has no binary field “${key}”`, { itemIndex: i, description: `It has: ${Object.keys(binary).join(', ') || 'no binary data'}.` });
    // The loader's context reads the files of the items it loads (the vector store's input).
    const bytes = await ctx.helpers.getBinaryDataBuffer(i, key);
    files.push({ bytes, fileName: ref.fileName ?? key, ...(ref.mimeType && { mimeType: ref.mimeType }) });
  }
  return files;
}

export const defaultDataLoaderNode = defineNode({
  description: {
    ...subnode,
    name: 'documentDefaultDataLoader',
    displayName: 'Default Data Loader',
    description: 'Turn input items into documents for a vector store, split into chunks',
    supplies: 'ai_document',
    categories: ['AI', 'Document Loaders'],
    icon: 'lucide:file-input',
    color: RAG_COLOR,
    keywords: ['loader', 'documents', 'json', 'text', 'rag', 'ingest'],
    inputs: [{ type: 'ai_textSplitter', displayName: 'Text Splitter', maxConnections: 1, required: true, displayOptions: { show: { textSplittingMode: ['custom'] } } }],
    outputs: [{ type: 'ai_document', displayName: 'Document' }],
    properties: [
      {
        name: 'jsonMode',
        displayName: 'Mode',
        type: 'options',
        default: 'allInputData',
        noDataExpression: true,
        options: [
          { name: 'Load All Input Data', value: 'allInputData', description: 'Each item’s fields become “key: value” lines' },
          { name: 'Load Specific Data', value: 'expressionData', description: 'One value per item, usually an expression' },
          { name: 'Load Binary Files', value: 'binaryData', description: 'The items’ files: PDF, DOCX, text, Markdown, HTML, CSV or JSON' },
        ],
      },
      {
        name: 'binaryField',
        displayName: 'Binary Fields',
        type: 'string',
        default: 'data',
        placeholder: 'e.g. data, attachment_0',
        displayOptions: { show: { jsonMode: ['binaryData'] } },
        description: 'Which binary fields to read, comma-separated. Empty: every file of the item. Each chunk keeps the file name and, where the file has pages, the page',
      },
      {
        name: 'jsonData',
        displayName: 'Data',
        type: 'string',
        default: '{{ $json.text }}',
        typeOptions: { rows: 2 },
        displayOptions: { show: { jsonMode: ['expressionData'] } },
        description: 'Evaluated for every input item of the vector store',
      },
      {
        name: 'textSplittingMode',
        displayName: 'Text Splitting',
        type: 'options',
        default: 'simple',
        noDataExpression: true,
        options: [
          { name: 'Simple', value: 'simple', description: 'Chunks of 1000 characters with 200 characters of overlap' },
          { name: 'Custom', value: 'custom', description: 'Attach a text splitter sub-node' },
        ],
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          {
            name: 'metadata',
            displayName: 'Metadata',
            type: 'fixedCollection',
            typeOptions: { multipleValues: true },
            default: {},
            description: 'Stored with every chunk; vector stores can filter on it',
            groups: [
              {
                name: 'metadataValues',
                displayName: 'Metadata',
                values: [
                  { name: 'name', displayName: 'Name', type: 'string', default: '' },
                  { name: 'value', displayName: 'Value', type: 'string', default: '' },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  async supplyData(ctx) {
    const mode = ctx.getNodeParameter<'allInputData' | 'expressionData' | 'binaryData'>('jsonMode') ?? 'allInputData';
    const custom = ctx.getNodeParameter('textSplittingMode') === 'custom';
    const [splitter] = custom ? ((await ctx.getInputConnectionData?.<TextSplitter>('ai_textSplitter')) ?? []) : [];
    if (custom && !splitter) {
      throw new NodeOperationError('No text splitter connected', { description: 'Attach a text splitter to the Default Data Loader, or set “Text Splitting” to Simple.' });
    }
    return {
      async load(items: NodeItem[]): Promise<AiDocument[]> {
        try {
          return await loadDocuments(items, {
            mode,
            data: (i) => ctx.getNodeParameter('jsonData', i),
            files: (i) => binaryFiles(ctx, items, i),
            metadata: (i) => metadataEntries(ctx.getNodeParameter<{ metadata?: unknown }>('options', i)?.metadata),
            split: splitter ? (text) => splitter.splitText(text) : async (text) => recursiveCharacterSplit(text, { chunkSize: 1000, chunkOverlap: 200 }),
          });
        } catch (error) {
          if (error instanceof FileLoadError) throw new NodeOperationError(error.message, { ...(error.description && { description: error.description }) });
          throw error;
        }
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Text splitters
// ---------------------------------------------------------------------------

const splitterOutput = [{ type: 'ai_textSplitter' as const, displayName: 'Text Splitter' }];
const chunkProperties = (size: number, unit: string) => [
  { name: 'chunkSize', displayName: 'Chunk Size', type: 'number' as const, default: size, typeOptions: { minValue: 1 }, description: `Maximum ${unit} per chunk` },
  { name: 'chunkOverlap', displayName: 'Chunk Overlap', type: 'number' as const, default: 0, typeOptions: { minValue: 0 }, description: `${unit[0].toUpperCase()}${unit.slice(1)} repeated from the previous chunk` },
];

/** A splitter error (overlap ≥ size…) as a NodeOperationError. */
function splitter(split: (text: string) => string[]): TextSplitter {
  return {
    async splitText(text) {
      try {
        return split(text);
      } catch (error) {
        throw new NodeOperationError((error as Error).message);
      }
    },
  };
}

export const recursiveCharacterTextSplitterNode = defineNode({
  description: {
    ...subnode,
    name: 'textSplitterRecursiveCharacterTextSplitter',
    displayName: 'Recursive Character Text Splitter',
    description: 'Split text at paragraphs, then lines, then words, until every chunk fits (recommended)',
    supplies: 'ai_textSplitter',
    categories: ['AI', 'Text Splitters'],
    icon: 'lucide:scissors',
    color: RAG_COLOR,
    subtitle: '{{chunkSize}} characters',
    keywords: ['split', 'chunk', 'text', 'rag'],
    inputs: [],
    outputs: splitterOutput,
    properties: [
      ...chunkProperties(1000, 'characters'),
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          {
            name: 'splitCode',
            displayName: 'Split Code',
            type: 'options',
            default: 'none',
            description: 'Use the separators of a language or format',
            options: [
              { name: 'None', value: 'none' },
              { name: 'Markdown', value: 'markdown' },
              { name: 'JavaScript / TypeScript', value: 'js' },
              { name: 'Python', value: 'python' },
              { name: 'Go', value: 'go' },
              { name: 'HTML', value: 'html' },
            ],
          },
          {
            name: 'separators',
            displayName: 'Separators',
            type: 'json',
            default: '["\\n\\n", "\\n", " ", ""]',
            description: 'A JSON list, tried in order; "" splits between characters. Overrides Split Code',
          },
          { name: 'keepSeparator', displayName: 'Keep Separator', type: 'boolean', default: true, description: 'Keep each separator at the start of the next chunk' },
        ],
      },
    ],
  },
  supplyData(ctx): TextSplitter {
    const options = ctx.getNodeParameter<{ splitCode?: string; separators?: unknown; keepSeparator?: boolean }>('options') ?? {};
    let separators = options.splitCode && options.splitCode !== 'none' ? CODE_SEPARATORS[options.splitCode] : undefined;
    if (options.separators !== undefined && options.separators !== '') {
      const parsed = typeof options.separators === 'string' ? safeParse(options.separators) : options.separators;
      if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === 'string')) throw new NodeOperationError('Separators must be a JSON list of strings', { description: 'For example ["\\n\\n", "\\n", " ", ""].' });
      separators = parsed;
    }
    const chunkSize = Number(ctx.getNodeParameter('chunkSize'));
    const chunkOverlap = Number(ctx.getNodeParameter('chunkOverlap'));
    return splitter((text) => recursiveCharacterSplit(text, { chunkSize, chunkOverlap, ...(separators && { separators }), keepSeparator: options.keepSeparator !== false }));
  },
});

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export const tokenTextSplitterNode = defineNode({
  description: {
    ...subnode,
    name: 'textSplitterTokenSplitter',
    displayName: 'Token Splitter',
    description: 'Split text into chunks of about N tokens (an estimate: no model vocabulary needed)',
    supplies: 'ai_textSplitter',
    categories: ['AI', 'Text Splitters'],
    icon: 'lucide:split',
    color: RAG_COLOR,
    subtitle: '{{chunkSize}} tokens',
    keywords: ['split', 'chunk', 'tokens', 'rag'],
    inputs: [],
    outputs: splitterOutput,
    properties: chunkProperties(1000, 'tokens'),
  },
  supplyData(ctx): TextSplitter {
    const chunkSize = Number(ctx.getNodeParameter('chunkSize'));
    const chunkOverlap = Number(ctx.getNodeParameter('chunkOverlap'));
    return splitter((text) => tokenSplit(text, { chunkSize, chunkOverlap }));
  },
});

// ---------------------------------------------------------------------------
// Reranker
// ---------------------------------------------------------------------------

export const llmRerankerNode = defineNode({
  description: {
    ...subnode,
    name: 'rerankerLlm',
    displayName: 'Reranker (LLM)',
    description: 'Re-order retrieved documents by relevance, scored by the attached chat model',
    supplies: 'ai_reranker',
    categories: ['AI', 'Rerankers'],
    icon: 'lucide:arrow-down-wide-narrow',
    color: RAG_COLOR,
    subtitle: 'top {{topN}}',
    keywords: ['rerank', 'reranker', 'relevance', 'rag', 'cross-encoder'],
    inputs: [{ type: 'ai_languageModel', displayName: 'Model', required: true, maxConnections: 1 }],
    outputs: [{ type: 'ai_reranker', displayName: 'Reranker' }],
    properties: [
      { name: 'topN', displayName: 'Top N', type: 'number', default: 4, typeOptions: { minValue: 1 }, description: 'Documents to keep (the vector store’s Limit, when smaller, wins)' },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          { name: 'instructions', displayName: 'Instructions', type: 'string', default: '', typeOptions: { rows: 2 }, description: 'Extra guidance for the model, e.g. “prefer official policy pages”' },
          { name: 'maxCharacters', displayName: 'Characters per Document', type: 'number', default: 1000, typeOptions: { minValue: 100 }, description: 'Each document is cut to this length in the prompt' },
        ],
      },
    ],
  },
  async supplyData(ctx) {
    const [model] = (await ctx.getInputConnectionData?.<LanguageModel>('ai_languageModel')) ?? [];
    if (!model) throw new NodeOperationError('No chat model connected to the reranker', { description: 'Attach a chat model to the Reranker’s “Model” slot.' });
    const options = ctx.getNodeParameter<{ instructions?: string; maxCharacters?: number }>('options') ?? {};
    return llmReranker(model, {
      topK: Number(ctx.getNodeParameter('topN')) || 4,
      ...(options.instructions && { instructions: options.instructions }),
      ...(options.maxCharacters && { maxCharacters: Number(options.maxCharacters) }),
    });
  },
});

export const cohereRerankerNode = defineNode({
  description: {
    ...subnode,
    name: 'rerankerCohere',
    displayName: 'Reranker (Cohere)',
    description: 'Re-order retrieved documents with Cohere’s rerank API (or a Cohere-compatible server)',
    supplies: 'ai_reranker',
    categories: ['AI', 'Rerankers'],
    icon: 'lucide:arrow-down-wide-narrow',
    color: '#39594d',
    subtitle: '{{model}}',
    keywords: ['rerank', 'reranker', 'cohere', 'relevance', 'rag', 'cross-encoder', 'jina', 'vllm'],
    credentials: [{ name: 'cohereApi', required: true }],
    inputs: [],
    outputs: [{ type: 'ai_reranker', displayName: 'Reranker' }],
    properties: [
      { name: 'model', displayName: 'Model', type: 'string', default: 'rerank-v3.5', description: 'rerank-v3.5, rerank-english-v3.0, rerank-multilingual-v3.0, or the model your compatible server serves' },
      { name: 'topN', displayName: 'Top N', type: 'number', default: 4, typeOptions: { minValue: 1 }, description: 'Documents to keep (the vector store’s Limit, when smaller, wins)' },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          { name: 'maxTokensPerDoc', displayName: 'Max Tokens per Document', type: 'number', default: 4096, typeOptions: { minValue: 1 }, description: 'Longer passages are cut by the API' },
          { name: 'keepOrderOnFailure', displayName: 'Keep Order on Failure', type: 'boolean', default: false, description: 'When the call fails, return the documents in retrieval order instead of failing the search' },
        ],
      },
    ],
  },
  supplyData(ctx) {
    const credential = ctx.getCredentials<{ apiKey?: string; baseUrl?: string }>('cohereApi');
    const options = ctx.getNodeParameter<{ maxTokensPerDoc?: number; keepOrderOnFailure?: boolean }>('options') ?? {};
    return cohereReranker({
      ...(credential?.baseUrl && { baseUrl: credential.baseUrl }),
      ...(credential?.apiKey && { apiKey: credential.apiKey }),
      model: String(ctx.getNodeParameter('model') || 'rerank-v3.5'),
      topK: Number(ctx.getNodeParameter('topN')) || 4,
      ...(options.maxTokensPerDoc && { maxTokensPerDoc: Number(options.maxTokensPerDoc) }),
      ...(options.keepOrderOnFailure && { keepOrderOnFailure: true }),
    });
  },
});

// ---------------------------------------------------------------------------
// Question and Answer Chain
// ---------------------------------------------------------------------------

const DEFAULT_QA_PROMPT =
  'Use the following pieces of context to answer the user’s question. If you don’t know the answer, just say that you don’t know, don’t try to make up an answer.\n----------------\n{context}';

export const retrievalQaChainNode = defineNode({
  description: {
    version: 1,
    kind: 'action',
    name: 'chainRetrievalQa',
    displayName: 'Question and Answer Chain',
    description: 'Answer a question from the documents a retriever finds (RAG)',
    categories: ['AI'],
    icon: 'lucide:message-circle-question',
    color: '#a855f7',
    keywords: ['rag', 'qa', 'question', 'answer', 'retrieval', 'knowledge', 'documents'],
    inputs: [
      { type: 'main' },
      { type: 'ai_languageModel', displayName: 'Chat Model', required: true, maxConnections: 1 },
      FALLBACK_PORT,
      { type: 'ai_retriever', displayName: 'Retriever', required: true, maxConnections: 1 },
    ],
    outputs: [{ type: 'main' }],
    properties: [
      { name: 'query', displayName: 'Query', type: 'string', default: '{{ $json.chatInput }}', required: true, typeOptions: { rows: 2 } },
      FALLBACK_PROPERTY,
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          {
            name: 'systemPromptTemplate',
            displayName: 'System Prompt Template',
            type: 'string',
            default: DEFAULT_QA_PROMPT,
            typeOptions: { rows: 5 },
            description: '{context} is replaced by the retrieved documents',
          },
          { name: 'returnSourceDocuments', displayName: 'Include Source Documents', type: 'boolean', default: false, description: 'Add the retrieved documents to the output' },
        ],
      },
    ],
  },
  async execute(ctx) {
    const model = await connectedModel(ctx, 'Question and Answer Chain');
    const [retriever] = (await ctx.getInputConnectionData?.<Retriever>('ai_retriever')) ?? [];
    if (!retriever) throw new NodeOperationError('No retriever connected', { description: 'Attach a vector store in “Retrieve Documents (As Retriever)” mode to the “Retriever” slot.' });
    const out: NodeItem[] = [];
    for (const [i] of ctx.getInputData().entries()) {
      const query = String(ctx.getNodeParameter('query', i) ?? '').trim();
      if (!query) throw new NodeOperationError('The query is empty', { itemIndex: i, description: 'Send a chat message or set “Query”.' });
      const options = ctx.getNodeParameter<{ systemPromptTemplate?: string; returnSourceDocuments?: boolean }>('options', i) ?? {};
      const documents = await retriever.retrieve(query, { ...(ctx.signal && { signal: ctx.signal }) });
      const context = documents.map((doc) => doc.pageContent).join('\n\n');
      const template = options.systemPromptTemplate || DEFAULT_QA_PROMPT;
      const system = template.includes('{context}') ? template.replace(/\{context\}/g, context) : `${template}\n\n${context}`;
      const turn = await model.generate({ system, messages: [{ role: 'user', content: query }], tools: [], ...(ctx.signal && { signal: ctx.signal }) });
      ctx.logger.info(`item ${i}: answered from ${documents.length} document(s)`);
      out.push({
        json: {
          response: turn.text,
          ...(options.returnSourceDocuments && {
            sourceDocuments: documents.map((doc) => ({ pageContent: doc.pageContent, metadata: doc.metadata, ...(doc.score !== undefined && { score: doc.score }) })) as unknown as JsonObject[],
          }),
        },
        pairedItem: { item: i },
      });
    }
    return [out];
  },
});
