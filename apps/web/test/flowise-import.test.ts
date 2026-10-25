/**
 * Flowise import: format detection, each component family (chat models, memory, chains and prompt templates,
 * agents, tools, loaders, splitters, embeddings, vector stores, retriever tools, agentflow nodes), placeholders and
 * the report, full chatflows from the synthetic fixtures (handwritten in Flowise's export shape, not real exports)
 * and the import route.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NodeDescriptor } from '@landflow/protocol';
import type { Workflow } from '@landflow/engine';
import { importWorkflowJson } from '@/lib/server/n8n-import';
import { corePlugin } from '@/lib/server/nodes';
import { workflowSchema } from '@/lib/server/schemas';

const core = new Map<string, NodeDescriptor>(corePlugin.nodes.map((n) => [`core.${n.description.name}`, n.description]));
const resolveType = (type: string) => core.get(type);

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'flowise', name), 'utf8'));

function load(doc: unknown) {
  const { workflow, report } = importWorkflowJson(doc, { resolveType });
  const parsed = workflowSchema.safeParse(workflow);
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  const node = (name: string) => {
    const found = workflow.nodes.find((n) => n.name === name);
    if (!found) throw new Error(`no node ${name} (have ${workflow.nodes.map((n) => n.name).join(', ')})`);
    return found;
  };
  const edges = (from: string, to: string) => workflow.connections.filter((c) => c.source === node(from).id && c.target === node(to).id);
  return { workflow: workflow as Omit<Workflow, 'id'>, report, node, edges };
}

/** A one-component chatflow (plus optional neighbours), the shape Flowise exports. */
const flow = (nodes: Array<{ id: string; name: string; label?: string; inputs?: Record<string, unknown>; version?: number }>, edges: Array<[string, string, string]> = []) => ({
  nodes: nodes.map((n, i) => ({ id: n.id, position: { x: i * 400, y: 0 }, type: 'customNode', data: { id: n.id, name: n.name, label: n.label ?? n.name, version: n.version ?? 1, inputs: n.inputs ?? {} } })),
  edges: edges.map(([source, target, input], i) => ({ id: `e${i}`, source, sourceHandle: `${source}-output-x-X`, target, targetHandle: `${target}-input-${input}-X` })),
});

describe('Flowise import: chatflows', () => {
  it('detects Flowise and converts a conversation chain with its chat trigger', () => {
    const { workflow, report, node, edges } = load(fixture('conversation-chain.json'));
    expect(report.format).toBe('flowise');
    expect(workflow.name).toBe('Imported Flowise flow');
    expect(Object.fromEntries(workflow.nodes.map((n) => [n.name, n.type]))).toEqual({
      ChatOpenAI: 'core.openAiChatModel',
      'Buffer Memory': 'core.simpleMemory',
      'Conversation Chain': 'core.chainLlm',
      'When chat message received': 'core.chatTrigger',
    });
    expect(node('ChatOpenAI').parameters).toMatchObject({ model: 'gpt-4o-mini', options: { temperature: 0.4, maxTokens: 800 } });
    expect(node('Conversation Chain').parameters).toMatchObject({ prompt: '{{ $json.chatInput }}', systemMessage: 'You are a friendly assistant for a bike shop. Answer in two sentences.' });
    expect(edges('ChatOpenAI', 'Conversation Chain')).toMatchObject([{ type: 'ai_languageModel' }]);
    expect(edges('When chat message received', 'Conversation Chain')).toMatchObject([{ type: 'main', sourceIndex: 0, targetIndex: 0 }]);
    // The Basic LLM Chain has no memory slot: the edge is dropped and reported.
    expect(edges('Buffer Memory', 'Conversation Chain')).toHaveLength(0);
    expect(report.warnings).toContain("Conversation Chain: Landflow's Basic LLM Chain has no memory; the memory connection was dropped (an AI Agent keeps conversations).");
    expect(report.warnings).toContain('ChatOpenAI: credential dropped — pick a saved credential in the node.');
    expect(report.mapped).toContainEqual({ name: 'Conversation Chain', from: 'conversationChain', to: 'core.chainLlm' });
    expect(report.placeholders).toEqual([]);
    expect(report.connections).toBe(workflow.connections.length);
  });

  it('splits an ingesting and retrieving vector store into an insert node (Upsert trigger) and a retriever', () => {
    const { workflow, report, node, edges } = load(fixture('rag-chatflow.json'));
    const insert = node('In-Memory Vector Store (insert)');
    const retrieve = node('In-Memory Vector Store');
    expect(insert).toMatchObject({ type: 'core.vectorStoreInMemory', parameters: { mode: 'insert', collection: 'memoryVectorStore_0', clearStore: false } });
    expect(retrieve).toMatchObject({ type: 'core.vectorStoreInMemory', parameters: { mode: 'retrieve', collection: 'memoryVectorStore_0', topK: 3 } });
    expect(edges('Ollama Embeddings', 'In-Memory Vector Store (insert)')).toMatchObject([{ type: 'ai_embedding' }]);
    expect(edges('Ollama Embeddings', 'In-Memory Vector Store')).toMatchObject([{ type: 'ai_embedding' }]);
    expect(edges('Plain Text', 'In-Memory Vector Store (insert)')).toMatchObject([{ type: 'ai_document' }]);
    expect(edges('Upsert documents', 'In-Memory Vector Store (insert)')).toMatchObject([{ type: 'main' }]);
    expect(node('Upsert documents').type).toBe('core.manualTrigger');
    expect(edges('In-Memory Vector Store', 'Conversational Retrieval QA Chain')).toMatchObject([{ type: 'ai_retriever' }]);
    expect(edges('Recursive Character Text Splitter', 'Plain Text')).toMatchObject([{ type: 'ai_textSplitter' }]);
    expect(edges('ChatOllama', 'Conversational Retrieval QA Chain')).toMatchObject([{ type: 'ai_languageModel' }]);
    expect(edges('When chat message received', 'Conversational Retrieval QA Chain')).toHaveLength(1);

    expect(node('Plain Text').parameters).toMatchObject({
      jsonMode: 'expressionData',
      jsonData: 'Landflow ships evaluations and a Flowise importer.',
      textSplittingMode: 'custom',
      options: { metadata: { metadataValues: [{ name: 'source', value: 'release-notes' }] } },
    });
    expect(node('Recursive Character Text Splitter').parameters).toMatchObject({ chunkSize: 500, chunkOverlap: 50 });
    expect(node('Ollama Embeddings').parameters).toMatchObject({ baseUrl: 'http://127.0.0.1:11434', model: 'nomic-embed-text' });
    expect(node('ChatOllama').parameters).toMatchObject({ model: 'qwen3-coder:30b', temperature: 0.1, baseUrl: 'http://127.0.0.1:11434' });
    expect(node('Conversational Retrieval QA Chain').parameters).toMatchObject({
      query: '{{ $json.chatInput }}',
      options: { systemPromptTemplate: 'Answer from the context only.\n\n{context}\n\nQuestion: {{ $json.chatInput }}', returnSourceDocuments: true },
    });
    expect(edges('Buffer Window Memory', 'Conversational Retrieval QA Chain')).toHaveLength(0);
    expect(report.warnings).toContain('In-Memory Vector Store: run “Upsert documents” once to fill the store (Flowise\'s Upsert button).');
    expect(workflow.stickyNotes).toEqual([expect.objectContaining({ content: 'Upsert the release notes, then ask about them.', position: [-400, -300] })]);
    expect(report.stickyNotes).toBe(1);
  });

  it('converts a tool agent: model, memory, tools, chain and retriever tools, prompt templates and placeholders', () => {
    const { workflow, report, node, edges } = load(fixture('tool-agent.json'));
    expect(node('Tool Agent')).toMatchObject({ type: 'core.aiAgent', parameters: { prompt: '{{ $json.chatInput }}', systemMessage: 'You help the support team. Use the tools.', options: { maxIterations: 6 } } });
    expect(node('ChatAnthropic').parameters).toMatchObject({ model: 'claude-sonnet-5-5', maxTokens: 4000 });
    expect(node('Buffer Window Memory').parameters).toEqual({ turns: 4 });
    expect(edges('Buffer Window Memory', 'Tool Agent')).toMatchObject([{ type: 'ai_memory' }]);
    for (const tool of ['Calculator', 'Custom Tool', 'Chain Tool', 'Requests Get', 'Retriever Tool']) expect(edges(tool, 'Tool Agent'), tool).toMatchObject([{ type: 'ai_tool' }]);

    // Custom and chain tools: Execute Workflow tools whose workflow is left to choose.
    expect(node('Custom Tool')).toMatchObject({ type: 'core.executeWorkflow', parameters: { workflowId: '' } });
    expect(node('Custom Tool').notes).toContain('Look up the status of an order by its number');
    expect(node('Custom Tool').notes).toContain('Flowise code:\nconst res = await fetch');
    expect(node('Chain Tool')).toMatchObject({ type: 'core.executeWorkflow', notes: 'Drafts a polite reply to a customer' });
    expect(report.warnings.some((w) => w.startsWith('Chain Tool: move the chain it wrapped into its own workflow'))).toBe(true);
    // The wrapped chain keeps its prompt template, merged in, but no trigger.
    expect(node('LLM Chain').parameters).toMatchObject({ prompt: 'Write a polite reply to this customer message: {{ $json.chatInput }}' });
    expect(edges('ChatOllama', 'LLM Chain')).toMatchObject([{ type: 'ai_languageModel' }]);
    expect(workflow.nodes.some((n) => n.name === 'Prompt Template')).toBe(false);
    expect(report.mapped).toContainEqual({ name: 'Prompt Template', from: 'promptTemplate', to: 'core.chainLlm' });
    expect(report.warnings).toContain('LLM Chain: it ran inside a Chain Tool in Flowise; it has no trigger here until it moves to its own workflow.');
    expect(edges('When chat message received', 'Tool Agent')).toHaveLength(1);
    expect(workflow.connections.filter((c) => c.source === node('When chat message received').id)).toHaveLength(1);

    expect(node('Requests Get')).toMatchObject({ type: 'core.httpRequest', parameters: { method: 'GET', url: 'https://status.example.com/api' }, notes: 'Current service status' });
    // The Retriever Tool is its Postgres store in tool mode.
    expect(node('Retriever Tool')).toMatchObject({
      type: 'core.vectorStorePGVector',
      parameters: { mode: 'retrieve-as-tool', toolName: 'search_kb', toolDescription: 'Search the support knowledge base', tableName: 'support_docs', collection: 'flowise', topK: 5, includeDocumentMetadata: true },
    });
    expect(edges('OpenAI Embeddings', 'Retriever Tool')).toMatchObject([{ type: 'ai_embedding' }]);
    expect(node('OpenAI Embeddings').parameters).toMatchObject({ model: 'text-embedding-3-small', options: { dimensions: 512 } });
    expect(workflow.nodes.some((n) => n.name === 'Postgres')).toBe(false);

    // Unknown components: disabled placeholders, reported, their sub-node edges dropped.
    expect(node('Serp API')).toMatchObject({ type: 'core.noOp', disabled: true });
    expect(node('Serp API').notes).toContain('Placeholder for the Flowise node serpAPI');
    expect(report.placeholders).toEqual([{ name: 'Serp API', type: 'serpAPI' }]);
    expect(edges('Serp API', 'Tool Agent')).toHaveLength(0);
    expect(report.warnings).toContain("Connection Serp API → Tool Agent dropped: placeholders can't be sub-nodes.");
  });

  it('leaves out prompt templates that feed nothing and warns when no chain answers chats', () => {
    const { workflow, report } = load(flow([{ id: 'promptTemplate_0', name: 'promptTemplate', label: 'Prompt', inputs: { template: 'Hi {name}' } }]));
    expect(workflow.nodes).toEqual([]);
    expect(report.warnings).toEqual(['Prompt: the prompt template feeds no chain Landflow imported; it was dropped.', 'No chain or agent was found to answer chat messages; add a Chat Trigger where the conversation starts.']);
  });
});

describe('Flowise import: component families', () => {
  const single = (name: string, inputs: Record<string, unknown> = {}) => load(flow([{ id: `${name}_0`, name, label: 'X', inputs }]));

  it('maps chat models, including OpenAI-compatible providers', () => {
    expect(single('chatOllama', { modelName: 'llama3', baseUrl: 'http://ollama:11434' }).node('X')).toMatchObject({ type: 'core.ollamaChatModel', parameters: { model: 'llama3', baseUrl: 'http://ollama:11434' } });
    const groq = single('groqChat', { modelName: 'llama-3.3-70b' });
    expect(groq.node('X')).toMatchObject({ type: 'core.openAiChatModel', parameters: { model: 'llama-3.3-70b' } });
    expect(groq.report.warnings[0]).toMatch(/Groq runs on the OpenAI Chat Model/);
    expect(single('chatOpenAI', { modelName: 'gpt-5-mini', basepath: 'https://proxy.example.com/v1' }).report.warnings[0]).toMatch(/set the base URL \(https:\/\/proxy.example.com\/v1\)/);
  });

  it('maps memories', () => {
    expect(single('bufferMemory').node('X').parameters).toEqual({ turns: 10 });
    expect(single('bufferWindowMemory', { k: 3 }).node('X').parameters).toEqual({ turns: 3 });
    const summary = single('conversationSummaryMemory');
    expect(summary.node('X')).toMatchObject({ type: 'core.simpleMemory', parameters: { turns: 10 } });
    expect(summary.report.warnings[0]).toMatch(/summary memory isn't available/);
  });

  it('maps agents and retrieval chains', () => {
    for (const name of ['toolAgent', 'conversationalAgent', 'openAIToolAgent', 'reactAgentChat']) expect(single(name).node('X').type, name).toBe('core.aiAgent');
    expect(single('retrievalQAChain').node('X')).toMatchObject({ type: 'core.chainRetrievalQa', parameters: { query: '{{ $json.chatInput }}' } });
  });

  it('maps text splitters', () => {
    expect(single('recursiveCharacterTextSplitter', { chunkSize: 800, chunkOverlap: 0, separators: '["\\n\\n", "."]' }).node('X').parameters).toMatchObject({
      chunkSize: 800,
      chunkOverlap: 0,
      options: { separators: '["\\n\\n","."]' },
    });
    expect(single('characterTextSplitter', { separator: '---' }).node('X').parameters).toMatchObject({ options: { separators: '["---",""]' } });
    expect(single('markdownTextSplitter').node('X').parameters).toMatchObject({ options: { splitCode: 'markdown' } });
    expect(single('codeTextSplitter', { language: 'python' }).node('X').parameters).toMatchObject({ options: { splitCode: 'python' } });
    const rust = single('codeTextSplitter', { language: 'rust' });
    expect(rust.node('X').parameters.options).toEqual({});
    expect(rust.report.warnings[0]).toMatch(/splitting rust code isn't available/);
    expect(single('tokenTextSplitter', { chunkSize: 256, chunkOverlap: 16 }).node('X')).toMatchObject({ type: 'core.textSplitterTokenSplitter', parameters: { chunkSize: 256, chunkOverlap: 16 } });
  });

  it('maps loaders: inline text and uploaded text files are kept, other sources are fed in as items', () => {
    const upload = `data:text/plain;base64,${Buffer.from('Hello from a file').toString('base64')},filename:notes.txt`;
    expect(single('textFile', { txtFile: upload }).node('X').parameters).toMatchObject({ jsonMode: 'expressionData', jsonData: 'Hello from a file', textSplittingMode: 'simple' });
    const pdf = single('pdfFile', { pdfFile: 'data:application/pdf;base64,JVBERi0=' });
    expect(pdf.node('X').parameters).toMatchObject({ jsonMode: 'allInputData' });
    expect(pdf.report.warnings[0]).toMatch(/Flowise loaded pdfFile; that content isn't in the export/);
    expect(single('cheerioWebScraper', { url: 'https://example.com/docs' }).report.warnings[0]).toMatch(/Flowise loaded https:\/\/example.com\/docs/);
  });

  it('maps embeddings', () => {
    expect(single('openAIEmbeddings', { modelName: 'text-embedding-3-large', batchSize: '100' }).node('X').parameters).toMatchObject({ model: 'text-embedding-3-large', options: { batchSize: 100 } });
    expect(single('ollamaEmbedding', { modelName: 'mxbai-embed-large' }).node('X')).toMatchObject({ type: 'core.embeddingsOllama', parameters: { model: 'mxbai-embed-large' } });
  });

  it('a vector store that only ingests becomes one insert node with the Upsert trigger', () => {
    const { node, edges, report } = load(
      flow(
        [
          { id: 'plainText_0', name: 'plainText', label: 'Text', inputs: { text: 'abc' } },
          { id: 'openAIEmbeddings_0', name: 'openAIEmbeddings', label: 'Emb' },
          { id: 'postgres_0', name: 'postgres', label: 'PG', inputs: { tableName: 'kb' } },
        ],
        [
          ['plainText_0', 'postgres_0', 'document'],
          ['openAIEmbeddings_0', 'postgres_0', 'embeddings'],
        ],
      ),
    );
    expect(node('PG')).toMatchObject({ type: 'core.vectorStorePGVector', parameters: { mode: 'insert', tableName: 'kb', collection: 'flowise' } });
    expect(edges('Upsert documents', 'PG')).toHaveLength(1);
    expect(edges('Text', 'PG')).toMatchObject([{ type: 'ai_document' }]);
    expect(report.warnings.some((w) => w.startsWith('PG: choose a Postgres credential'))).toBe(true);
  });

  it('turns unknown components into disabled placeholders with their inputs in the notes', () => {
    const { node, report } = single('faiss', { basePath: '/data/faiss' });
    expect(node('X')).toMatchObject({ type: 'core.noOp', disabled: true });
    expect(node('X').notes).toBe('Placeholder for the Flowise node faiss (v1), which Landflow doesn\'t have. Original inputs: {"basePath":"/data/faiss"}');
    expect(report.placeholders).toEqual([{ name: 'X', type: 'faiss' }]);
  });
});

describe('Flowise import: agentflow v2', () => {
  it('maps start, agent (inline model, tools, memory) and LLM nodes; conditions become placeholders on the main flow', () => {
    const { workflow, report, node, edges } = load(fixture('agentflow-v2.json'));
    expect(node('Start').type).toBe('core.chatTrigger');
    expect(node('Support Agent')).toMatchObject({ type: 'core.aiAgent', parameters: { prompt: '{{ $json.chatInput }}', systemMessage: 'You are the support agent. Keep answers short.' } });
    expect(node('Support Agent Model')).toMatchObject({ type: 'core.ollamaChatModel', parameters: { model: 'qwen3-coder:30b', temperature: 0.3, baseUrl: 'http://127.0.0.1:11434' } });
    expect(edges('Support Agent Model', 'Support Agent')).toMatchObject([{ type: 'ai_languageModel' }]);
    expect(edges('Calculator', 'Support Agent')).toMatchObject([{ type: 'ai_tool' }]);
    expect(node('Support Agent Memory').parameters).toEqual({ turns: 8 });
    expect(edges('Support Agent Memory', 'Support Agent')).toMatchObject([{ type: 'ai_memory' }]);
    expect(report.warnings).toContain('Support Agent: the tool “googleCustomSearch” isn\'t available in Landflow; it was left out.');
    expect(report.warnings).toContain('Support Agent: only the system message was imported; the other preset messages were dropped.');

    expect(node('Needs follow-up?')).toMatchObject({ type: 'core.noOp', disabled: true });
    expect(edges('Start', 'Support Agent')).toMatchObject([{ type: 'main' }]);
    expect(edges('Support Agent', 'Needs follow-up?')).toMatchObject([{ type: 'main' }]);
    expect(edges('Needs follow-up?', 'Summarize')).toMatchObject([{ type: 'main' }]);
    expect(node('Summarize')).toMatchObject({ type: 'core.chainLlm', parameters: { prompt: 'Summarize: {{ $json.chatInput }}', systemMessage: 'Summarize the conversation for a ticket.' } });
    expect(node('Summarize Model')).toMatchObject({ type: 'core.openAiChatModel', parameters: { model: 'gpt-4o-mini' } });
    // The start node is the entry: no extra chat trigger.
    expect(workflow.nodes.filter((n) => n.type === 'core.chatTrigger')).toHaveLength(1);
    expect(workflow.stickyNotes).toHaveLength(1);
  });
});

describe('Flowise import over the route', () => {
  it('POST /api/workflows/import detects the format and saves the workflow', async () => {
    Object.assign(process.env, { LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
    const { POST } = await import('@/app/api/workflows/import/route');
    const response = await POST(
      new Request('http://localhost/api/workflows/import', { method: 'POST', body: JSON.stringify({ data: JSON.stringify(fixture('conversation-chain.json')), name: 'Bike shop chat' }) }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.report.format).toBe('flowise');
    expect(body.workflow).toMatchObject({ name: 'Bike shop chat', id: expect.stringMatching(/^wf_/) });
    expect(body.workflow.nodes.map((n: { type: string }) => n.type).sort()).toEqual(['core.chainLlm', 'core.chatTrigger', 'core.openAiChatModel', 'core.simpleMemory']);
  });
});
