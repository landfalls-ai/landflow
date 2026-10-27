/**
 * Flowise import: a chatflow or agentflow export (`nodes` whose `data.name` is the Flowise component, `edges`
 * between their anchors) converted to a Landflow workflow. Chatflows are graphs of LangChain components wired
 * into a final chain or agent; they become Landflow's AI nodes with sub-nodes (chat models, memory, tools,
 * embeddings, loaders, splitters, vector stores) and a Chat Trigger as the entry. Prompt templates are merged
 * into their chain, a vector store that both ingests and retrieves is split into an insert node (run by a Manual
 * Trigger, like Flowise's Upsert button) and a retrieval node, and a Retriever Tool becomes its store's tool mode.
 * Agentflow v2's start, agent and LLM nodes map with their inline model, tools and memory. Custom JS Function nodes
 * become Code nodes (Flowise's `$flow` and input variables defined above the original code). Document stores become a
 * loader + splitter + embeddings + vector store chain when their definition is in the file (a store export, or a
 * `documentStores` list next to a chatflow), else a retrieval node on the store's collection. Flowise credentials map to
 * Landflow credential slots by type, and are assigned when exactly one saved credential of that type exists. Anything
 * else becomes a disabled No Operation placeholder, as in the n8n importer, and everything is reported back.
 *
 * Pure: no file system or registry access. `resolveType` gives the registered descriptors (defaults, versions).
 */
import { nanoid } from 'nanoid';
import { SUPPORTED_FILES } from './rag/files';
import { defaultVersionOf, withPropertyDefaults, type ConnectionType } from '@landflow/protocol';
import type { StickyNote, Workflow, WorkflowConnection, WorkflowNode } from '@landflow/engine';
import type { ImportReport } from '../shared/types';
import type { ImportOptions, ImportResult } from './n8n-import';

type Params = Record<string, unknown>;

/** A node as Flowise exports it (React Flow node with the component in `data`). */
export interface FlowiseNode {
  id: string;
  position?: { x?: number; y?: number };
  type?: string;
  data?: {
    id?: string;
    label?: string;
    name?: string;
    version?: number;
    category?: string;
    inputs?: Params;
    credential?: string;
    /** Input anchors; the credential one lists the Flowise credential types the component takes. */
    inputParams?: Array<{ name?: string; type?: string; credentialNames?: string[] }>;
  };
}

export interface FlowiseEdge {
  id?: string;
  source: string;
  sourceHandle?: string;
  target: string;
  targetHandle?: string;
}

/** What a Flowise component is to the converter; sub-node roles name the Landflow connection type they supply. */
type Role = 'model' | 'memory' | 'tool' | 'embedding' | 'loader' | 'splitter' | 'vectorStore' | 'retrieverTool' | 'prompt' | 'chain' | 'agent' | 'flow' | 'function';

const SUPPLIES: Partial<Record<Role, ConnectionType>> = {
  model: 'ai_languageModel',
  memory: 'ai_memory',
  tool: 'ai_tool',
  embedding: 'ai_embedding',
  loader: 'ai_document',
  splitter: 'ai_textSplitter',
};

interface Ctx {
  node: FlowiseNode;
  name: string;
  inputs: Params;
  warn(message: string): void;
  /** Whether an edge arrives at this input anchor of the node. */
  connected(input: string): boolean;
}

interface Conversion {
  parameters: Params;
  notes?: string;
}

interface Mapping {
  role: Role;
  to: string;
  convert?: (ctx: Ctx) => Conversion;
  /** The Flowise credential type the component takes when its export doesn't say (`inputParams`). */
  credential?: string;
}

/** A Flowise credential type → the Landflow credential type and the slot (a node's credential requirement) it fills. */
export const FLOWISE_CREDENTIALS: Record<string, { type: string; slot: string; note?: string }> = {
  openAIApi: { type: 'core.openAiApi', slot: 'openAiApi' },
  azureOpenAIApi: { type: 'core.openAiApi', slot: 'openAiApi', note: 'Azure OpenAI: the credential needs the deployment’s base URL.' },
  groqApi: { type: 'core.openAiApi', slot: 'openAiApi', note: 'Groq: use an OpenAI API credential with https://api.groq.com/openai/v1.' },
  mistralAIApi: { type: 'core.openAiApi', slot: 'openAiApi', note: 'Mistral: use an OpenAI API credential with https://api.mistral.ai/v1.' },
  deepseekApi: { type: 'core.openAiApi', slot: 'openAiApi', note: 'DeepSeek: use an OpenAI API credential with https://api.deepseek.com/v1.' },
  openRouterApi: { type: 'core.openAiApi', slot: 'openAiApi', note: 'OpenRouter: use an OpenAI API credential with https://openrouter.ai/api/v1.' },
  localAIApi: { type: 'core.openAiApi', slot: 'openAiApi', note: 'LocalAI: use an OpenAI API credential with your server’s base URL.' },
  anthropicApi: { type: 'core.anthropicApi', slot: 'anthropicApi' },
  PostgresApi: { type: 'core.postgres', slot: 'postgres' },
  postgresApi: { type: 'core.postgres', slot: 'postgres' },
  cohereApi: { type: 'core.cohereApi', slot: 'cohereApi' },
};

const CHAT_INPUT = '{{ $json.chatInput }}';
const STICKY_SIZE = [40, 4000] as const;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isObject = (value: unknown): value is Params => typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): Params[] => (Array.isArray(value) ? value.filter(isObject) : []);
const text = (value: unknown) => (value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value));
const num = (value: unknown, fallback: number) => {
  const n = typeof value === 'string' && !value.trim() ? NaN : Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const whole = (value: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) => Math.min(max, Math.max(min, Math.round(num(value, fallback))));
/** A Flowise input that holds a reference to another node (`{{chatOpenAI_0.data.instance}}`) rather than a value. */
const isReference = (value: unknown) => typeof value === 'string' && /^\{\{[\w-]+\.data\.instance\}\}$/.test(value.trim());
/** An input value, unless it is empty or a node reference. */
const value = (inputs: Params, key: string): unknown => {
  const v = inputs[key];
  return v === undefined || v === null || v === '' || isReference(v) || (Array.isArray(v) && v.every(isReference)) ? undefined : v;
};
const has = (inputs: Params, key: string) => value(inputs, key) !== undefined;
/** JSON given as text or as an object. */
function json(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
const clip = (source: string, limit = 1500) => (source.length > limit ? `${source.slice(0, limit)}…` : source);
const toolNameOf = (name: string) =>
  name
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------

const modelOptions = (inputs: Params) => ({
  ...(has(inputs, 'temperature') && { temperature: num(inputs.temperature, 0.7) }),
  ...(has(inputs, 'maxTokens') && { maxTokens: whole(inputs.maxTokens, 1024, 1) }),
});

const chatOpenAI = (ctx: Ctx): Conversion => {
  const base = text(value(ctx.inputs, 'basepath') ?? value(ctx.inputs, 'baseOptions'));
  if (base) ctx.warn(`${ctx.name}: set the base URL (${clip(base, 120)}) on the OpenAI API credential.`);
  return { parameters: { model: text(value(ctx.inputs, 'modelName')) || 'gpt-4o-mini', options: modelOptions(ctx.inputs) } };
};

/** OpenAI-compatible providers run on the OpenAI Chat Model with a credential that points at their base URL. */
const compatible =
  (provider: string) =>
  (ctx: Ctx): Conversion => {
    ctx.warn(`${ctx.name}: ${provider} runs on the OpenAI Chat Model; use an OpenAI API credential with ${provider}'s base URL.`);
    return { parameters: { model: text(value(ctx.inputs, 'modelName') ?? value(ctx.inputs, 'model')), options: modelOptions(ctx.inputs) } };
  };

const chatAnthropic = (ctx: Ctx): Conversion => ({
  parameters: {
    ...(has(ctx.inputs, 'modelName') && { model: text(ctx.inputs.modelName) }),
    ...(has(ctx.inputs, 'maxTokensToSample') && { maxTokens: whole(ctx.inputs.maxTokensToSample, 16_000, 256, 64_000) }),
  },
});

const chatOllama = (ctx: Ctx): Conversion => ({
  parameters: {
    ...(has(ctx.inputs, 'baseUrl') && { baseUrl: text(ctx.inputs.baseUrl) }),
    ...(has(ctx.inputs, 'modelName') && { model: text(ctx.inputs.modelName) }),
    ...(has(ctx.inputs, 'temperature') && { temperature: num(ctx.inputs.temperature, 0.2) }),
  },
});

const bufferMemory = (ctx: Ctx): Conversion => {
  if (has(ctx.inputs, 'sessionId')) ctx.warn(`${ctx.name}: set the agent's “Session Key” option to ${text(ctx.inputs.sessionId)}; memory keys live on the agent in Landflow.`);
  return { parameters: { turns: whole(value(ctx.inputs, 'k'), 10, 1, 100) } };
};

const summaryMemory = (ctx: Ctx): Conversion => {
  ctx.warn(`${ctx.name}: summary memory isn't available; it keeps the last 10 turns instead.`);
  return { parameters: { turns: 10 } };
};

/** Conversation Chain / LLM Chain → Basic LLM Chain; a prompt template sub-node is merged in later. */
const llmChain = (ctx: Ctx): Conversion => {
  if (ctx.connected('outputParser')) ctx.warn(`${ctx.name}: output parsers aren't imported; set “Require Specific Output Format” on the chain if you need JSON.`);
  if (ctx.connected('memory')) ctx.warn(`${ctx.name}: Landflow's Basic LLM Chain has no memory; the memory connection was dropped (an AI Agent keeps conversations).`);
  const system = text(value(ctx.inputs, 'systemMessagePrompt')).trim();
  return { parameters: { prompt: CHAT_INPUT, ...(system && { systemMessage: system }) } };
};

/** {context} and {question} placeholders of Flowise's QA prompts → Landflow's ({context} stays, the question is the query). */
const qaPrompt = (prompt: string) => prompt.replace(/\{question\}/g, '{{ $json.chatInput }}');

const retrievalQa = (ctx: Ctx): Conversion => {
  if (ctx.connected('memory')) ctx.warn(`${ctx.name}: the question and answer chain has no memory in Landflow; the memory connection was dropped.`);
  const prompt = text(value(ctx.inputs, 'responsePrompt') ?? value(ctx.inputs, 'systemMessagePrompt')).trim();
  return {
    parameters: {
      query: CHAT_INPUT,
      options: {
        ...(prompt && { systemPromptTemplate: qaPrompt(prompt) }),
        ...(value(ctx.inputs, 'returnSourceDocuments') !== undefined && { returnSourceDocuments: Boolean(ctx.inputs.returnSourceDocuments) }),
      },
    },
  };
};

const agent = (ctx: Ctx): Conversion => {
  const system = text(value(ctx.inputs, 'systemMessage') ?? value(ctx.inputs, 'systemMessagePrompt')).trim();
  const options: Params = {};
  if (has(ctx.inputs, 'maxIterations')) options.maxIterations = whole(ctx.inputs.maxIterations, 8, 1, 30);
  if (ctx.connected('outputParser')) ctx.warn(`${ctx.name}: output parsers aren't imported; the agent returns plain text.`);
  return { parameters: { prompt: CHAT_INPUT, ...(system && { systemMessage: system }), options } };
};

/** A tool Landflow can't run as such: an Execute Workflow tool whose workflow is left to choose. */
const workflowTool = (what: string, notes: (ctx: Ctx) => string) => (ctx: Ctx): Conversion => {
  ctx.warn(`${ctx.name}: ${what}`);
  return { parameters: { workflowId: '', inputSource: 'passthrough', mode: 'once' }, notes: notes(ctx) };
};

const customTool = workflowTool('Flowise custom tools run JavaScript Landflow doesn’t host; build the tool as a workflow (its code is in the node’s notes) and choose it.', (ctx) => {
  const description = text(value(ctx.inputs, 'customToolDesc')).trim();
  const schema = text(value(ctx.inputs, 'customToolSchema')).trim();
  const code = text(value(ctx.inputs, 'customToolFunc')).trim();
  return [description || `Flowise custom tool ${text(value(ctx.inputs, 'customToolName') ?? value(ctx.inputs, 'selectedTool'))}`, schema && `Input schema: ${clip(schema, 800)}`, code && `Flowise code:\n${clip(code, 3000)}`]
    .filter(Boolean)
    .join('\n\n');
});

const chainTool = workflowTool('move the chain it wrapped into its own workflow (start it with “When Called by a Workflow or Agent”) and choose that workflow.', (ctx) =>
  text(value(ctx.inputs, 'description')).trim() || `Runs the chain “${text(value(ctx.inputs, 'name'))}”.`,
);

const requestsTool =
  (method: 'GET' | 'POST') =>
  (ctx: Ctx): Conversion => {
    const url = text(value(ctx.inputs, 'requestsGetUrl') ?? value(ctx.inputs, 'requestsPostUrl') ?? value(ctx.inputs, 'url'));
    const body = method === 'POST' ? text(value(ctx.inputs, 'requestsPostBody') ?? value(ctx.inputs, 'body')) : '';
    const description = text(value(ctx.inputs, 'requestsGetDescription') ?? value(ctx.inputs, 'requestsPostDescription') ?? value(ctx.inputs, 'description')).trim();
    if (has(ctx.inputs, 'headers') || has(ctx.inputs, 'requestsGetHeaders') || has(ctx.inputs, 'requestsPostHeaders')) ctx.warn(`${ctx.name}: request headers weren't imported; add them on the node.`);
    return { parameters: { method, url, ...(body && { body }) }, ...(description && { notes: description }) };
  };

const embeddingsOpenAI = (ctx: Ctx): Conversion => {
  const options: Params = {};
  if (has(ctx.inputs, 'dimensions')) options.dimensions = whole(ctx.inputs.dimensions, 1536, 1);
  if (has(ctx.inputs, 'batchSize')) options.batchSize = whole(ctx.inputs.batchSize, 512, 1);
  return { parameters: { model: text(value(ctx.inputs, 'modelName')) || 'text-embedding-ada-002', options } };
};

const embeddingsOllama = (ctx: Ctx): Conversion => ({
  parameters: { ...(has(ctx.inputs, 'baseUrl') && { baseUrl: text(ctx.inputs.baseUrl) }), model: text(value(ctx.inputs, 'modelName')) || 'nomic-embed-text' },
});

/** A `data:text/plain;base64,…,filename:x.txt` upload (Flowise keeps uploaded files like this), decoded. */
function decodeUpload(raw: unknown): { text: string; filename?: string } | undefined {
  const first = Array.isArray(json(raw)) ? (json(raw) as unknown[])[0] : raw;
  const match = typeof first === 'string' ? /^data:([^;,]*)(?:;base64)?,([^,]*)(?:,filename:(.*))?$/.exec(first.trim()) : null;
  if (!match || (match[1] && !/^text\/|json|csv|markdown/.test(match[1]))) return undefined;
  try {
    return { text: Buffer.from(match[2], 'base64').toString('utf8'), ...(match[3] && { filename: match[3] }) };
  } catch {
    return undefined;
  }
}

const loaderMetadata = (inputs: Params) => {
  const metadata = json(value(inputs, 'metadata'));
  return isObject(metadata) ? Object.entries(metadata).map(([name, v]) => ({ name, value: text(v) })) : [];
};

/** Loaders of files: the Default Data Loader reads those from binary fields (PDF, DOCX, text, CSV, JSON…). */
const FILE_LOADERS = new Set(['pdfFile', 'docxFile', 'csvFile', 'jsonFile', 'jsonlinesFile', 'textFile', 'folderFiles']);

/** Document loaders → the Default Data Loader: inline text is kept; files and web pages have to be fed in as items. */
const loader = (ctx: Ctx): Conversion => {
  const component = ctx.node.data?.name ?? '';
  let data: string | undefined;
  if (component === 'plainText') data = text(value(ctx.inputs, 'text'));
  else if (component === 'textFile') {
    const upload = decodeUpload(ctx.inputs.txtFile);
    if (upload) data = upload.text.length > 20_000 ? `${upload.text.slice(0, 20_000)}` : upload.text;
    if (upload && upload.text.length > 20_000) ctx.warn(`${ctx.name}: the text file was cut at 20,000 characters; feed long files in through items.`);
  }
  if (data === undefined && component === 'documentStore') {
    ctx.warn(`${ctx.name}: the Flowise document store ${text(value(ctx.inputs, 'selectedStore'))} isn't defined in the file; feed its content in as items (or load it with a loader from the original source).`);
  } else if (data === undefined && FILE_LOADERS.has(component)) {
    ctx.warn(`${ctx.name}: Flowise loaded ${component}; the file isn't in the export. Feed it in as a binary file before the insert (HTTP Request, Read/Write Files or a form upload): the loader reads ${SUPPORTED_FILES}.`);
  } else if (data === undefined) {
    const source = text(value(ctx.inputs, 'url')) || component;
    ctx.warn(`${ctx.name}: Flowise loaded ${source}; that content isn't in the export. Feed it in as items before the insert (e.g. HTTP Request or Read/Write Files + Extract From File).`);
  }
  const metadata = loaderMetadata(ctx.inputs);
  return {
    parameters: {
      jsonMode: data !== undefined ? 'expressionData' : FILE_LOADERS.has(component) ? 'binaryData' : 'allInputData',
      ...(data === undefined && FILE_LOADERS.has(component) && { binaryField: '' }),
      ...(data !== undefined && { jsonData: data }),
      textSplittingMode: ctx.connected('textSplitter') ? 'custom' : 'simple',
      ...(metadata.length && { options: { metadata: { metadataValues: metadata } } }),
    },
  };
};

const CODE_LANGUAGES: Record<string, string> = { js: 'js', javascript: 'js', typescript: 'js', python: 'python', go: 'go', html: 'html', markdown: 'markdown' };

const splitter =
  (kind: 'recursive' | 'character' | 'markdown' | 'code' | 'html') =>
  (ctx: Ctx): Conversion => {
    const sizes = { chunkSize: whole(value(ctx.inputs, 'chunkSize'), 1000, 1), chunkOverlap: whole(value(ctx.inputs, 'chunkOverlap'), 200, 0) };
    if (kind === 'character') return { parameters: { ...sizes, options: { separators: JSON.stringify([text(value(ctx.inputs, 'separator')) || '\n\n', '']) } } };
    if (kind === 'markdown') return { parameters: { ...sizes, options: { splitCode: 'markdown' } } };
    if (kind === 'html') {
      ctx.warn(`${ctx.name}: HTML isn't converted to Markdown first; it splits along HTML tags.`);
      return { parameters: { ...sizes, options: { splitCode: 'html' } } };
    }
    if (kind === 'code') {
      const language = text(value(ctx.inputs, 'language')).toLowerCase();
      const splitCode = CODE_LANGUAGES[language];
      if (!splitCode) ctx.warn(`${ctx.name}: splitting ${language || 'that'} code isn't available; it splits as plain text.`);
      return { parameters: { ...sizes, ...(splitCode && { options: { splitCode } }) } };
    }
    const separators = json(value(ctx.inputs, 'separators'));
    return { parameters: { ...sizes, ...(Array.isArray(separators) && separators.length && { options: { separators: JSON.stringify(separators.map(String)) } }) } };
  };

const tokenSplitter = (ctx: Ctx): Conversion => ({
  parameters: { chunkSize: whole(value(ctx.inputs, 'chunkSize'), 1000, 1), chunkOverlap: whole(value(ctx.inputs, 'chunkOverlap'), 200, 0) },
});

/** Vector stores: the collection is the Flowise node (insert and retrieval share it); the mode is set per use later. */
const memoryVectorStore = (ctx: Ctx): Conversion => ({ parameters: { collection: text(value(ctx.inputs, 'collection')) || ctx.node.id, topK: whole(value(ctx.inputs, 'topK'), 4, 1, 100) } });

const postgresVectorStore = (ctx: Ctx): Conversion => {
  const host = text(value(ctx.inputs, 'host'));
  ctx.warn(`${ctx.name}: choose a Postgres credential${host ? ` for ${host}` : ''}; Landflow keeps its own table layout, so documents Flowise stored have to be inserted again.`);
  return { parameters: { tableName: text(value(ctx.inputs, 'tableName')) || 'documents', collection: text(value(ctx.inputs, 'collection')) || 'flowise', topK: whole(value(ctx.inputs, 'topK'), 4, 1, 100) } };
};

const chatTrigger = (ctx: Ctx): Conversion => {
  if (value(ctx.inputs, 'startInputType') === 'formInput') ctx.warn(`${ctx.name}: the start form became a chat; ask for its fields in the conversation or use a Form Trigger.`);
  return { parameters: {} };
};

/** Agentflow v2 messages: the system message, and the rest dropped with a warning. */
function systemOf(messages: unknown, ctx: Ctx): string {
  const all = list(json(messages));
  const system = all.filter((m) => m.role === 'system').map((m) => text(m.content).trim());
  if (all.length > system.length) ctx.warn(`${ctx.name}: only the system message was imported; the other preset messages were dropped.`);
  return system.join('\n\n');
}

const agentflowAgent = (ctx: Ctx): Conversion => {
  const system = systemOf(ctx.inputs.agentMessages, ctx);
  const prompt = text(value(ctx.inputs, 'agentUserMessage')).trim();
  if (list(json(ctx.inputs.agentKnowledgeDocumentStores)).length || list(json(ctx.inputs.agentKnowledgeVSEmbeddings)).length) {
    ctx.warn(`${ctx.name}: knowledge stores aren't imported; attach a vector store in “Retrieve Documents (As Tool)” mode.`);
  }
  return { parameters: { prompt: prompt ? flowVariables(prompt) : CHAT_INPUT, ...(system && { systemMessage: flowVariables(system) }), options: {} } };
};

const agentflowLlm = (ctx: Ctx): Conversion => {
  const system = systemOf(ctx.inputs.llmMessages, ctx);
  const prompt = text(value(ctx.inputs, 'llmUserMessage')).trim();
  if (value(ctx.inputs, 'llmEnableMemory')) ctx.warn(`${ctx.name}: Landflow's Basic LLM Chain has no memory; earlier turns aren't sent.`);
  return { parameters: { prompt: prompt ? flowVariables(prompt) : CHAT_INPUT, ...(system && { systemMessage: flowVariables(system) }) } };
};

/** Agentflow's `{{ question }}` is the chat message. */
const flowVariables = (template: string) => template.replace(/\{\{\s*question\s*\}\}/g, '{{ $json.chatInput }}');

// ---------------------------------------------------------------------------
// Custom JS Function → Code
// ---------------------------------------------------------------------------

/** A Flowise input variable's value as a JavaScript expression of the Code node (item `$json`). */
function variableExpression(raw: unknown, name: string, ctx: Ctx, notes: string[]): string {
  const value = text(raw).trim();
  if (!value) return 'undefined';
  if (/^\{\{\s*question\s*\}\}$/.test(value)) return '$json.chatInput';
  if (/^\{\{\s*(chat_?history|history)\s*\}\}$/i.test(value)) {
    notes.push(`$${name} was the chat history; it is an empty list here (an AI Agent keeps conversations in its memory).`);
    return '[]';
  }
  const vars = /^\{\{\s*\$vars\.([\w$]+)\s*\}\}$/.exec(value);
  if (vars) return `$vars.${vars[1]}`;
  if (isReference(value)) {
    notes.push(`$${name} came from another node's output in Flowise; it reads that node's output field (the nodes are connected in order).`);
    return '($json.output ?? $json.text ?? $json.response)';
  }
  if (/\{\{\s*question\s*\}\}/.test(value)) {
    ctx.warn(`${ctx.name}: $${name} mixes text with the question; it is a template string over $json.chatInput.`);
    return `\`${value.replace(/[`\\]/g, '\\$&').replace(/\$\{/g, '\\${').replace(/\{\{\s*question\s*\}\}/g, '${$json.chatInput}')}\``;
  }
  return JSON.stringify(value);
}

/**
 * Flowise's Custom JS Function (a function body that `return`s a value; input variables are `$name`, the run is `$flow`)
 * → a Code node in "once for each item" mode: `$flow` and the variables are defined above the original code, which stays
 * as it was inside an async function, and its result goes to `output` next to the item's fields. What the Code node can't
 * offer (`$flow.state`, `require`) is listed in the node's notes and the report.
 */
const customFunction =
  (codeKey: string, variablesKey: string) =>
  (ctx: Ctx): Conversion => {
    const code = text(value(ctx.inputs, codeKey)).replace(/\r\n/g, '\n').trimEnd();
    if (!code.trim()) ctx.warn(`${ctx.name}: the function had no code; the Code node returns its input unchanged.`);
    const notes: string[] = [];
    const declarations = list(json(ctx.inputs[variablesKey])).flatMap((entry) => {
      const raw = text(entry.variableName).trim().replace(/^\$/, '');
      if (!raw) return [];
      const name = raw.replace(/[^\w$]/g, '_');
      if (name !== raw) notes.push(`The variable “${raw}” is $${name} here.`);
      return [`const $${name} = ${variableExpression(entry.variableValue, name, ctx, notes)};`];
    });
    const unsupported: Array<[RegExp, string]> = [
      [/\$flow\.state\b/, '$flow.state (agentflow state) has no equivalent: it is an empty object here'],
      [/\$flow\.(chatHistory|rawOutput|apiMessage)\b/, '$flow.chatHistory, $flow.rawOutput and $flow.apiMessage are not available'],
      [/\$flow\.chatflowId\b/, '$flow.chatflowId is an empty string'],
      [/\brequire\s*\(|\bimport\s*\(/, 'require() / import() of Flowise’s allowed dependencies may not be available in the sandbox; check the code runs'],
      [/\bprocess\.env\b/, 'process.env is not available in the sandbox: use $vars (Settings → Variables)'],
    ];
    for (const [pattern, note] of unsupported) if (pattern.test(code)) notes.push(note);
    for (const note of notes) if (!/^The variable/.test(note) && !/^\$[\w$]+ (was|came)/.test(note)) ctx.warn(`${ctx.name}: ${note}.`);
    const body = code.split('\n').map((line) => (line ? `  ${line}` : line)).join('\n');
    const converted = [
      `// Converted from the Flowise Custom JS Function “${ctx.name}”. $flow and the input variables come first; the original code is the function.`,
      `const $flow = { input: $json.chatInput ?? '', sessionId: $json.sessionId ?? '', chatId: $json.sessionId ?? '', chatflowId: '', state: {}, chatHistory: [] };`,
      ...declarations,
      'const flowiseFunction = async () => {',
      body,
      '};',
      'const output = await flowiseFunction();',
      'return { ...$json, output };',
    ].join('\n');
    return { parameters: { language: 'javascript', mode: 'each', codeEach: converted }, ...(notes.length && { notes: `Imported from Flowise.\n${notes.map((n) => `- ${n}`).join('\n')}` }) };
  };

// ---------------------------------------------------------------------------
// Document stores
// ---------------------------------------------------------------------------

/** A document store the file doesn't define: retrieval on a collection named after it (the collection may already exist). */
const documentStoreReference = (ctx: Ctx): Conversion => {
  const store = text(value(ctx.inputs, 'selectedStore')).trim();
  const collection = store || ctx.node.id;
  ctx.warn(
    `${ctx.name}: the Flowise document store ${store ? `“${store}” ` : ''}isn't defined in the file, so this node reads the collection “${collection}” of Landflow's SQLite store. Fill it with a loader, splitter and embeddings (or point the node at the store that already holds it) and attach the embeddings model it was filled with.`,
  );
  return { parameters: { collection, topK: whole(value(ctx.inputs, 'topK'), 4, 1, 100) } };
};

/** A Flowise document store as an export writes it (the Document Store page's API: loaders and configs are JSON text). */
export interface FlowiseDocumentStore {
  id?: string;
  name?: string;
  description?: string;
  loaders?: unknown;
  vectorStoreConfig?: unknown;
  embeddingConfig?: unknown;
}

/** Whether a parsed document is a document store export rather than a chatflow. */
export function isFlowiseDocumentStore(doc: Params): boolean {
  return !Array.isArray(doc.nodes) && (Array.isArray(json(doc.loaders)) || isObject(json(doc.vectorStoreConfig)) || isObject(json(doc.embeddingConfig))) && (typeof doc.name === 'string' || typeof doc.id === 'string');
}

/** `{ name, config }` of a store's embeddingConfig / vectorStoreConfig. */
const configOf = (raw: unknown): { name: string; config: Params } | undefined => {
  const parsed = json(raw);
  return isObject(parsed) && typeof parsed.name === 'string' ? { name: parsed.name, config: isObject(parsed.config) ? parsed.config : {} } : undefined;
};

/** The vector store components a document store's `vectorStoreConfig.name` maps to; the rest use Landflow's SQLite store. */
const STORE_COMPONENTS: Record<string, string> = { postgres: 'postgres', memoryVectorStore: 'memoryVectorStore', simpleStore: 'memoryVectorStore' };

/**
 * Expand each document store the nodes refer to into the Flowise nodes of its chain, so the ordinary conversion makes
 * the loader, splitter, embeddings and vector store (and the Upsert trigger): the `documentStoreVS` node becomes the
 * store's vector store with an embeddings node and one loader (with its splitter) per loader of the store; a
 * `documentStore` loader node becomes the store's loaders. Stores that aren't defined stay references.
 */
function expandDocumentStores(raws: FlowiseNode[], edges: FlowiseEdge[], stores: FlowiseDocumentStore[], warn: (message: string) => void): { raws: FlowiseNode[]; edges: FlowiseEdge[] } {
  const byKey = new Map<string, FlowiseDocumentStore>();
  for (const store of stores) for (const key of [store.id, store.name]) if (key) byKey.set(key, store);
  const outRaws: FlowiseNode[] = [];
  const outEdges: FlowiseEdge[] = [...edges];
  const virtual = (id: string, name: string, label: string, inputs: Params, at?: FlowiseNode['position']): FlowiseNode => ({ id, position: at, data: { id, name, label, inputs } });
  const link = (source: string, target: string, input: string) => outEdges.push({ source, sourceHandle: `${source}-output-x-X`, target, targetHandle: `${target}-input-${input}-X` });
  /** The store's loaders as nodes (each with its splitter) feeding `target`'s `document` input. */
  const addLoaders = (store: FlowiseDocumentStore, base: FlowiseNode, target: string | undefined) => {
    const loaders = list(json(store.loaders));
    loaders.forEach((entry, i) => {
      const loaderName = text(entry.loaderId);
      const config = isObject(json(entry.loaderConfig)) ? (json(entry.loaderConfig) as Params) : {};
      const id = `${base.id}__loader${i}`;
      const label = text(entry.loaderName) || loaderName || `Loader ${i + 1}`;
      if (!FLOWISE_TYPE_MAP[loaderName]) warn(`${text(store.name) || base.id}: the loader “${loaderName}” has no Landflow equivalent; it reads items like a Default Data Loader.`);
      outRaws.push(virtual(id, FLOWISE_TYPE_MAP[loaderName]?.role === 'loader' ? loaderName : 'plainText', label, FLOWISE_TYPE_MAP[loaderName]?.role === 'loader' ? config : {}, { x: (base.position?.x ?? 0) - 380, y: (base.position?.y ?? 0) + i * 160 - 200 }));
      const splitterName = text(entry.splitterId);
      if (splitterName && FLOWISE_TYPE_MAP[splitterName]?.role === 'splitter') {
        const splitterId = `${id}__splitter`;
        outRaws.push(virtual(splitterId, splitterName, text(entry.splitterName) || splitterName, isObject(json(entry.splitterConfig)) ? (json(entry.splitterConfig) as Params) : {}, { x: (base.position?.x ?? 0) - 700, y: (base.position?.y ?? 0) + i * 160 - 200 }));
        link(splitterId, id, 'textSplitter');
      }
      if (target) link(id, target, 'document');
    });
    return loaders.length;
  };

  for (const raw of raws) {
    const name = raw.data?.name;
    if (name !== 'documentStoreVS' && name !== 'documentStore') {
      outRaws.push(raw);
      continue;
    }
    const inputs = isObject(raw.data?.inputs) ? raw.data!.inputs! : {};
    const key = text(inputs.selectedStore).trim();
    const store = key ? byKey.get(key) : undefined;
    if (!store) {
      outRaws.push(raw);
      continue;
    }
    const storeName = text(store.name) || key;
    if (name === 'documentStore') {
      // The loader form: the store's own loaders replace it (edges that left it leave each of them).
      const outgoing = edges.filter((e) => e.source === raw.id);
      const count = addLoaders(store, raw, undefined);
      for (let i = 0; i < count; i++) for (const edge of outgoing) outEdges.push({ ...edge, source: `${raw.id}__loader${i}`, sourceHandle: `${raw.id}__loader${i}-output-x-X` });
      for (const edge of outgoing) outEdges.splice(outEdges.indexOf(edge), 1);
      if (!count) outRaws.push(raw);
      continue;
    }
    // The vector store form: the store's vector store, embeddings and loaders.
    const vector = configOf(store.vectorStoreConfig);
    const component = vector ? (STORE_COMPONENTS[vector.name] ?? 'sqliteVectorStore') : 'sqliteVectorStore';
    if (vector && !STORE_COMPONENTS[vector.name]) warn(`${storeName}: Flowise kept it in ${vector.name}; Landflow has no store for that, so it uses its SQLite store (documents are inserted again by “Upsert documents”).`);
    const vectorInputs: Params = { ...(vector?.config ?? {}), collection: storeName, ...(inputs.topK !== undefined && { topK: inputs.topK }) };
    outRaws.push({ ...raw, data: { ...raw.data, name: component, label: raw.data?.label ?? storeName, inputs: vectorInputs, ...(vector?.config.credential ? { credential: String(vector.config.credential) } : {}) } });
    const embedding = configOf(store.embeddingConfig);
    if (embedding && FLOWISE_TYPE_MAP[embedding.name]?.role === 'embedding') {
      const id = `${raw.id}__embeddings`;
      outRaws.push(virtual(id, embedding.name, embedding.name, embedding.config, { x: (raw.position?.x ?? 0) - 380, y: (raw.position?.y ?? 0) + 200 }));
      if (embedding.config.credential) outRaws[outRaws.length - 1].data!.credential = String(embedding.config.credential);
      link(id, raw.id, 'embeddings');
    } else warn(`${storeName}: its embeddings (${embedding?.name ?? 'none set'}) have no Landflow equivalent; attach an embeddings sub-node.`);
    if (!addLoaders(store, raw, raw.id)) warn(`${storeName}: the store has no loaders in the file; the node reads the collection as it is.`);
  }
  return { raws: outRaws, edges: outEdges };
}

/** The document store a parsed or textual import is, when it is one (a document store export instead of a chatflow). */
export function flowiseDocumentStoreOf(input: unknown): FlowiseDocumentStore | undefined {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value) && value.length === 1) value = value[0];
  return isObject(value) && isFlowiseDocumentStore(value) ? (value as FlowiseDocumentStore) : undefined;
}

/** A document store export as a Flowise chatflow of its own: a vector store with its embeddings, loaders and splitters. */
export function documentStoreAsFlow(store: FlowiseDocumentStore): Params {
  const id = 'documentStore_0';
  const label = text(store.name) || 'Document store';
  return {
    name: label,
    description: text(store.description),
    documentStores: [store],
    nodes: [{ id, position: { x: 600, y: 0 }, data: { id, name: 'documentStoreVS', label, inputs: { selectedStore: text(store.id) || label } } }],
    edges: [],
  };
}

// ---------------------------------------------------------------------------
// The component map
// ---------------------------------------------------------------------------

const MODELS: Record<string, Mapping> = {
  chatOpenAI: { role: 'model', to: 'core.openAiChatModel', convert: chatOpenAI, credential: 'openAIApi' },
  chatOpenAICustom: { role: 'model', to: 'core.openAiChatModel', convert: compatible('This OpenAI-compatible model'), credential: 'openAIApi' },
  azureChatOpenAI: { role: 'model', to: 'core.openAiChatModel', convert: compatible('Azure OpenAI'), credential: 'azureOpenAIApi' },
  chatLocalAI: { role: 'model', to: 'core.openAiChatModel', convert: compatible('LocalAI'), credential: 'localAIApi' },
  groqChat: { role: 'model', to: 'core.openAiChatModel', convert: compatible('Groq'), credential: 'groqApi' },
  chatMistralAI: { role: 'model', to: 'core.openAiChatModel', convert: compatible('Mistral'), credential: 'mistralAIApi' },
  chatDeepseek: { role: 'model', to: 'core.openAiChatModel', convert: compatible('DeepSeek'), credential: 'deepseekApi' },
  chatOpenRouter: { role: 'model', to: 'core.openAiChatModel', convert: compatible('OpenRouter'), credential: 'openRouterApi' },
  chatAnthropic: { role: 'model', to: 'core.anthropicChatModel', convert: chatAnthropic, credential: 'anthropicApi' },
  chatOllama: { role: 'model', to: 'core.ollamaChatModel', convert: chatOllama },
  ollama: { role: 'model', to: 'core.ollamaChatModel', convert: chatOllama },
};

/** Flowise component (`data.name`) → Landflow. */
export const FLOWISE_TYPE_MAP: Record<string, Mapping> = {
  ...MODELS,
  bufferMemory: { role: 'memory', to: 'core.simpleMemory', convert: bufferMemory },
  bufferWindowMemory: { role: 'memory', to: 'core.simpleMemory', convert: bufferMemory },
  conversationSummaryMemory: { role: 'memory', to: 'core.simpleMemory', convert: summaryMemory },
  conversationSummaryBufferMemory: { role: 'memory', to: 'core.simpleMemory', convert: summaryMemory },
  conversationChain: { role: 'chain', to: 'core.chainLlm', convert: llmChain },
  llmChain: { role: 'chain', to: 'core.chainLlm', convert: llmChain },
  retrievalQAChain: { role: 'chain', to: 'core.chainRetrievalQa', convert: retrievalQa },
  conversationalRetrievalQAChain: { role: 'chain', to: 'core.chainRetrievalQa', convert: retrievalQa },
  toolAgent: { role: 'agent', to: 'core.aiAgent', convert: agent },
  conversationalAgent: { role: 'agent', to: 'core.aiAgent', convert: agent },
  openAIToolAgent: { role: 'agent', to: 'core.aiAgent', convert: agent },
  openAIFunctionAgent: { role: 'agent', to: 'core.aiAgent', convert: agent },
  conversationalRetrievalAgent: { role: 'agent', to: 'core.aiAgent', convert: agent },
  reactAgentChat: { role: 'agent', to: 'core.aiAgent', convert: agent },
  reactAgentLLM: { role: 'agent', to: 'core.aiAgent', convert: agent },
  mrklAgentChat: { role: 'agent', to: 'core.aiAgent', convert: agent },
  mrklAgentLLM: { role: 'agent', to: 'core.aiAgent', convert: agent },
  calculator: { role: 'tool', to: 'core.calculatorTool', convert: () => ({ parameters: {} }) },
  customTool: { role: 'tool', to: 'core.executeWorkflow', convert: customTool },
  chainTool: { role: 'tool', to: 'core.executeWorkflow', convert: chainTool },
  requestsGet: { role: 'tool', to: 'core.httpRequest', convert: requestsTool('GET') },
  requestsPost: { role: 'tool', to: 'core.httpRequest', convert: requestsTool('POST') },
  retrieverTool: { role: 'retrieverTool', to: '' },
  promptTemplate: { role: 'prompt', to: '' },
  chatPromptTemplate: { role: 'prompt', to: '' },
  openAIEmbeddings: { role: 'embedding', to: 'core.embeddingsOpenAi', convert: embeddingsOpenAI, credential: 'openAIApi' },
  ollamaEmbedding: { role: 'embedding', to: 'core.embeddingsOllama', convert: embeddingsOllama },
  plainText: { role: 'loader', to: 'core.documentDefaultDataLoader', convert: loader },
  textFile: { role: 'loader', to: 'core.documentDefaultDataLoader', convert: loader },
  pdfFile: { role: 'loader', to: 'core.documentDefaultDataLoader', convert: loader },
  docxFile: { role: 'loader', to: 'core.documentDefaultDataLoader', convert: loader },
  csvFile: { role: 'loader', to: 'core.documentDefaultDataLoader', convert: loader },
  jsonFile: { role: 'loader', to: 'core.documentDefaultDataLoader', convert: loader },
  jsonlinesFile: { role: 'loader', to: 'core.documentDefaultDataLoader', convert: loader },
  folderFiles: { role: 'loader', to: 'core.documentDefaultDataLoader', convert: loader },
  cheerioWebScraper: { role: 'loader', to: 'core.documentDefaultDataLoader', convert: loader },
  recursiveCharacterTextSplitter: { role: 'splitter', to: 'core.textSplitterRecursiveCharacterTextSplitter', convert: splitter('recursive') },
  characterTextSplitter: { role: 'splitter', to: 'core.textSplitterRecursiveCharacterTextSplitter', convert: splitter('character') },
  markdownTextSplitter: { role: 'splitter', to: 'core.textSplitterRecursiveCharacterTextSplitter', convert: splitter('markdown') },
  codeTextSplitter: { role: 'splitter', to: 'core.textSplitterRecursiveCharacterTextSplitter', convert: splitter('code') },
  htmlToMarkdownTextSplitter: { role: 'splitter', to: 'core.textSplitterRecursiveCharacterTextSplitter', convert: splitter('html') },
  tokenTextSplitter: { role: 'splitter', to: 'core.textSplitterTokenSplitter', convert: tokenSplitter },
  memoryVectorStore: { role: 'vectorStore', to: 'core.vectorStoreInMemory', convert: memoryVectorStore },
  postgres: { role: 'vectorStore', to: 'core.vectorStorePGVector', convert: postgresVectorStore, credential: 'PostgresApi' },
  // Flowise document stores: the vector store of a store defined elsewhere (expanded to its chain when the definition is known).
  documentStoreVS: { role: 'vectorStore', to: 'core.vectorStoreSqlite', convert: documentStoreReference },
  sqliteVectorStore: { role: 'vectorStore', to: 'core.vectorStoreSqlite', convert: (ctx) => ({ parameters: { collection: text(value(ctx.inputs, 'collection')) || ctx.node.id, topK: whole(value(ctx.inputs, 'topK'), 4, 1, 100) } }) },
  documentStore: { role: 'loader', to: 'core.documentDefaultDataLoader', convert: loader },
  customFunction: { role: 'function', to: 'core.code', convert: customFunction('javascriptFunction', 'functionInputVariables') },
  customFunctionAgentflow: { role: 'flow', to: 'core.code', convert: customFunction('customFunctionJavascriptFunction', 'customFunctionInputVariables') },
  startAgentflow: { role: 'flow', to: 'core.chatTrigger', convert: chatTrigger },
  agentAgentflow: { role: 'flow', to: 'core.aiAgent', convert: agentflowAgent },
  llmAgentflow: { role: 'flow', to: 'core.chainLlm', convert: agentflowLlm },
};

const STICKY = new Set(['stickyNote', 'stickyNoteAgentflow']);

/** Whether a parsed document is a Flowise chatflow or agentflow export. */
export function isFlowiseDocument(doc: Params): boolean {
  const nodes = list(doc.nodes);
  return Array.isArray(doc.edges) && nodes.length > 0 && nodes.every((n) => isObject(n.data) && typeof n.data.name === 'string');
}

// ---------------------------------------------------------------------------
// Flowise flow → Landflow
// ---------------------------------------------------------------------------

/** The input anchor an edge arrives at: `<target>-input-<name>-<Types>` → name. */
function inputOf(edge: FlowiseEdge): string {
  const handle = edge.targetHandle ?? '';
  const prefix = `${edge.target}-input-`;
  const rest = handle.startsWith(prefix) ? handle.slice(prefix.length) : handle;
  return rest.split('-')[0] ?? '';
}

/** The output an agentflow edge leaves from: a trailing `-<n>` on the source handle (conditions), else 0. */
function outputIndexOf(edge: FlowiseEdge): number {
  const match = /-(\d+)$/.exec(edge.sourceHandle ?? '');
  return match ? Number(match[1]) : 0;
}

function uniqueName(base: string, taken: Set<string>) {
  let name = base.trim() || 'Node';
  if (taken.has(name)) {
    let i = 1;
    while (taken.has(`${name} ${i}`)) i++;
    name = `${name} ${i}`;
  }
  taken.add(name);
  return name;
}

/** Flowise prompt variables (`{name}`) → expressions: the user's question is the chat message; fixed values are inlined. */
function promptFrom(template: string, promptValues: unknown, ctx: { warn(m: string): void; name: string }): string {
  const values = isObject(json(promptValues)) ? (json(promptValues) as Params) : {};
  return template.replace(/\{([A-Za-z_][\w]*)\}/g, (_match, variable: string) => {
    const bound = values[variable];
    if (bound === undefined || bound === '' || /^\{\{\s*question\s*\}\}$/.test(text(bound).trim())) return CHAT_INPUT;
    if (isReference(bound) || /\{\{.*\}\}/.test(text(bound))) {
      ctx.warn(`${ctx.name}: the prompt variable {${variable}} came from another node in Flowise; it now reads {{ $json.${variable} }}.`);
      return `{{ $json.${variable} }}`;
    }
    return text(bound);
  });
}

/** Convert a Flowise chatflow or agentflow export to a Landflow workflow document. */
export function convertFlowiseWorkflow(doc: Params, options: ImportOptions = {}): ImportResult {
  const report: ImportReport = { format: 'flowise', mapped: [], placeholders: [], stickyNotes: 0, connections: 0, warnings: [] };
  const warn = (message: string) => report.warnings.push(message);
  const descriptorOf = (type: string) => options.resolveType?.(type);
  // Document stores defined next to the chatflow (`documentStores`, or Flowise's export-all `DocumentStore`) expand to their chains.
  const stores = list(doc.documentStores ?? doc.DocumentStore) as FlowiseDocumentStore[];
  const expanded = expandDocumentStores(
    list(doc.nodes).filter((n): n is Params & FlowiseNode => typeof n.id === 'string' && isObject(n.data)) as FlowiseNode[],
    list(doc.edges).filter((e): e is Params & FlowiseEdge => typeof e.source === 'string' && typeof e.target === 'string') as FlowiseEdge[],
    stores,
    warn,
  );
  const raws = expanded.raws;
  const edges = expanded.edges;
  const rawById = new Map(raws.map((n) => [n.id, n]));
  const component = (id: string) => rawById.get(id)?.data?.name ?? '';
  const mappingOf = (id: string) => FLOWISE_TYPE_MAP[component(id)];
  const into = (id: string) => edges.filter((e) => e.target === id);
  const outOf = (id: string) => edges.filter((e) => e.source === id);

  const taken = new Set<string>();
  const nodes: WorkflowNode[] = [];
  const connections: WorkflowConnection[] = [];
  const seen = new Set<string>();
  const connect = (type: ConnectionType, source: string, target: string, sourceIndex = 0) => {
    const key = `${type}|${source}|${sourceIndex}|${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    connections.push({ id: `e_${nanoid(8)}`, type, source, sourceIndex, target, targetIndex: 0 });
  };
  const position = (raw: FlowiseNode, dx = 0, dy = 0): [number, number] => [Math.round(num(raw.position?.x, 0)) + dx, Math.round(num(raw.position?.y, 0)) + dy];
  const labelOf = (raw: FlowiseNode) => text(raw.data?.label) || text(raw.data?.name) || raw.id;

  /** Whether the Flowise node pointed at a saved credential (its id is all an export holds). */
  const hasCredential = (raw: FlowiseNode) => Boolean(raw.data?.credential || (isObject(raw.data?.inputs) && raw.data!.inputs!.credential));

  /**
   * The Flowise credential of a component → the credential slot of its Landflow node, by type: the component's
   * `inputParams` name the Flowise credential types (else the map's default), FLOWISE_CREDENTIALS gives the Landflow type
   * and slot. With exactly one saved credential of that type (`options.credentials`) the slot is filled; otherwise it's
   * reported to choose (several) or create (none). Keys and passwords never come along in an export.
   */
  const attachCredential = (raw: FlowiseNode, node: WorkflowNode, mapping: Mapping, reference = hasCredential(raw)) => {
    const named = raw.data?.inputParams?.find((param) => param.type === 'credential' || param.name === 'credential')?.credentialNames?.find((n) => FLOWISE_CREDENTIALS[n]);
    const flowise = named ?? mapping.credential;
    if (!reference && !(flowise && FLOWISE_CREDENTIALS[flowise])) return;
    const target = flowise ? FLOWISE_CREDENTIALS[flowise] : undefined;
    const declared = target ? (descriptorOf(node.type)?.credentials?.some((c) => c.name === target.slot) ?? true) : false;
    if (!target || !declared) {
      if (reference) warn(`${node.name}: credential dropped — pick a saved credential in the node.`);
      return;
    }
    const candidates = (options.credentials ?? []).filter((c) => c.type === target.type);
    const assigned = candidates.length === 1 ? candidates[0] : undefined;
    if (assigned) node.credentials = { ...node.credentials, [target.slot]: { id: assigned.id, name: assigned.name } };
    else if (reference) warn(`${node.name}: credential dropped — pick a saved credential in the node.`);
    if (target.note) warn(`${node.name}: ${target.note}`);
    (report.credentials ??= []).push({
      node: node.name,
      flowise: flowise!,
      type: target.type,
      slot: target.slot,
      status: assigned ? 'assigned' : candidates.length ? 'choose' : 'create',
      ...(assigned && { credential: assigned.name }),
    });
  };

  /** Add a Landflow node of `type` (registered defaults filled in). */
  const addNode = (type: string, name: string, at: [number, number], parameters: Params, extra: Partial<WorkflowNode> = {}): WorkflowNode => {
    const descriptor = descriptorOf(type);
    const node: WorkflowNode = {
      id: `n_${nanoid(8)}`,
      name: uniqueName(name, taken),
      type,
      typeVersion: descriptor ? defaultVersionOf(descriptor) : 1,
      position: at,
      parameters: descriptor ? withPropertyDefaults(descriptor.properties, parameters) : parameters,
      ...extra,
    };
    nodes.push(node);
    return node;
  };

  // Sticky notes.
  const stickyNotes: StickyNote[] = raws
    .filter((raw) => STICKY.has(component(raw.id)))
    .map((raw) => ({ id: `s_${nanoid(8)}`, content: text(raw.data?.inputs?.note).slice(0, 20_000), position: position(raw), width: 300, height: Math.min(STICKY_SIZE[1], Math.max(STICKY_SIZE[0], 160)) }));
  report.stickyNotes = stickyNotes.length;

  // 1. Every component but prompts, retriever tools and vector stores becomes one node (vector stores: per use, below).
  const built = new Map<string, WorkflowNode>();
  const placeholders = new Set<string>();
  const ctxFor = (raw: FlowiseNode, name: string): Ctx => ({
    node: raw,
    name,
    inputs: isObject(raw.data?.inputs) ? raw.data!.inputs! : {},
    warn,
    connected: (input) => into(raw.id).some((e) => inputOf(e) === input),
  });
  for (const raw of raws) {
    const name = component(raw.id);
    if (STICKY.has(name)) continue;
    const mapping = FLOWISE_TYPE_MAP[name];
    const label = labelOf(raw);
    if (!mapping) {
      if (hasCredential(raw)) warn(`${label}: credential dropped — pick a saved credential in the node.`);
      const node = addNode('core.noOp', label, position(raw), {}, { disabled: true, notes: `Placeholder for the Flowise node ${name} (v${raw.data?.version ?? 1}), which Landflow doesn't have. Original inputs: ${clip(JSON.stringify(raw.data?.inputs ?? {}))}` });
      built.set(raw.id, node);
      placeholders.add(raw.id);
      report.placeholders.push({ name: node.name, type: name });
      continue;
    }
    if (mapping.role === 'prompt' || mapping.role === 'retrieverTool' || mapping.role === 'vectorStore') continue;
    const converted = mapping.convert ? mapping.convert(ctxFor(raw, label)) : { parameters: {} };
    const node = addNode(mapping.to, label, position(raw), converted.parameters, converted.notes ? { notes: converted.notes } : {});
    built.set(raw.id, node);
    report.mapped.push({ name: node.name, from: name, to: mapping.to });
    attachCredential(raw, node, mapping);
  }

  // 2. Prompt templates are merged into the chains they feed.
  for (const raw of raws) {
    if (mappingOf(raw.id)?.role !== 'prompt') continue;
    const inputs = isObject(raw.data?.inputs) ? raw.data!.inputs! : {};
    const label = labelOf(raw);
    const targets = outOf(raw.id).map((e) => built.get(e.target)).filter((n): n is WorkflowNode => Boolean(n) && n!.type === 'core.chainLlm');
    if (!targets.length) {
      warn(`${label}: the prompt template feeds no chain Landflow imported; it was dropped.`);
      continue;
    }
    for (const chain of targets) {
      const human = component(raw.id) === 'chatPromptTemplate' ? text(inputs.humanMessagePrompt) : text(inputs.template);
      const system = component(raw.id) === 'chatPromptTemplate' ? text(inputs.systemMessagePrompt).trim() : '';
      chain.parameters = {
        ...chain.parameters,
        prompt: human.trim() ? promptFrom(human, inputs.promptValues, { warn, name: label }) : CHAT_INPUT,
        ...(system && { systemMessage: promptFrom(system, inputs.promptValues, { warn, name: label }) }),
      };
      report.mapped.push({ name: label, from: component(raw.id), to: chain.type });
      warn(`${label}: merged into “${chain.name}”'s prompt.`);
    }
  }

  // 3. Vector stores: one node per use. Documents arriving → an insert node run by a Manual Trigger; a chain → a
  //    retriever; a Retriever Tool → a tool for the agents it feeds.
  let upsertTrigger: WorkflowNode | undefined;
  for (const raw of raws) {
    const mapping = mappingOf(raw.id);
    if (mapping?.role !== 'vectorStore') continue;
    const label = labelOf(raw);
    const base = mapping.convert!(ctxFor(raw, label)).parameters;
    const { topK, ...shared } = base;
    const embeddings = into(raw.id).filter((e) => mappingOf(e.source)?.role === 'embedding' && built.has(e.source));
    const documents = into(raw.id).filter((e) => mappingOf(e.source)?.role === 'loader' && built.has(e.source));
    if (!embeddings.length) warn(`${label}: no embeddings were connected in Flowise; attach an embeddings sub-node.`);
    const uses: Array<{ mode: 'insert' | 'retrieve' | 'retrieve-as-tool'; consumers: WorkflowNode[]; extra?: Params; name: string; at: [number, number]; document?: FlowiseEdge }> = [];
    // Landflow's vector store takes one document loader: each loader gets an insert node of its own on the same collection.
    documents.forEach((document, d) => uses.push({ mode: 'insert', consumers: [], name: d ? `${label} (insert ${d + 1})` : label, at: position(raw, 0, -260 - d * 120), document }));
    const chains = outOf(raw.id).map((e) => built.get(e.target)).filter((n): n is WorkflowNode => n?.type === 'core.chainRetrievalQa');
    if (chains.length) uses.push({ mode: 'retrieve', consumers: chains, name: label, at: position(raw) });
    for (const toolEdge of outOf(raw.id).filter((e) => mappingOf(e.target)?.role === 'retrieverTool')) {
      const tool = rawById.get(toolEdge.target)!;
      const toolInputs = isObject(tool.data?.inputs) ? tool.data!.inputs! : {};
      const agents = outOf(tool.id).map((e) => built.get(e.target)).filter((n): n is WorkflowNode => n?.type === 'core.aiAgent');
      const toolLabel = labelOf(tool);
      uses.push({
        mode: 'retrieve-as-tool',
        consumers: agents,
        name: toolLabel,
        at: position(tool),
        extra: { toolName: toolNameOf(text(value(toolInputs, 'name')) || toolLabel), toolDescription: text(value(toolInputs, 'description')), includeDocumentMetadata: Boolean(toolInputs.returnSourceDocuments) },
      });
      report.mapped.push({ name: toolLabel, from: 'retrieverTool', to: mapping.to });
      warn(`${toolLabel}: merged into a copy of “${label}” in “Retrieve Documents (As Tool)” mode.`);
    }
    const others = outOf(raw.id).filter((e) => !chains.some((c) => c === built.get(e.target)) && mappingOf(e.target)?.role !== 'retrieverTool');
    for (const edge of others) warn(`Connection ${label} → ${labelOf(rawById.get(edge.target) ?? { id: edge.target })} dropped: Landflow vector stores serve chains as retrievers and agents as tools.`);
    if (!uses.length) uses.push({ mode: 'insert', consumers: [], name: label, at: position(raw) });
    // Names: the first use keeps the store's label; an insert next to a retriever is "<label> (insert)".
    if (uses.length > 1 && uses[0].mode === 'insert') uses[0].name = `${label} (insert)`;
    if (documents.length > 1) uses.slice(1, documents.length).forEach((use, d) => (use.name = `${label} (insert ${d + 2})`));

    uses.forEach((use, i) => {
      const parameters: Params = { ...shared, mode: use.mode, ...(use.mode === 'insert' ? { clearStore: false } : { topK }), ...use.extra };
      const node = addNode(mapping.to, use.name, use.at, parameters);
      attachCredential(raw, node, mapping);
      if (i === 0) built.set(raw.id, node);
      if (use.mode !== 'retrieve-as-tool') report.mapped.push({ name: node.name, from: component(raw.id), to: mapping.to });
      for (const edge of embeddings) connect('ai_embedding', built.get(edge.source)!.id, node.id);
      if (use.mode === 'insert') {
        if (use.document) connect('ai_document', built.get(use.document.source)!.id, node.id);
        upsertTrigger ??= addNode('core.manualTrigger', 'Upsert documents', [Math.round(num(raw.position?.x, 0)) - 320, Math.round(num(raw.position?.y, 0)) - 260], {});
        connect('main', upsertTrigger.id, node.id);
      }
      for (const consumer of use.consumers) connect(use.mode === 'retrieve' ? 'ai_retriever' : 'ai_tool', node.id, consumer.id);
    });
    if (documents.length) warn(`${label}: run “Upsert documents” once to fill the store (Flowise's Upsert button).`);
  }

  // 4. The other edges: sub-node capabilities (by the source's role), and agentflow's main flow.
  for (const edge of edges) {
    const sourceMapping = mappingOf(edge.source);
    const targetMapping = mappingOf(edge.target);
    const source = built.get(edge.source);
    const target = built.get(edge.target);
    const label = `${labelOf(rawById.get(edge.source) ?? { id: edge.source })} → ${labelOf(rawById.get(edge.target) ?? { id: edge.target })}`;
    if (!source || !target) continue;
    // Handled above: prompts, vector stores, retriever tools.
    if (sourceMapping?.role === 'vectorStore' || targetMapping?.role === 'vectorStore' || targetMapping?.role === 'retrieverTool' || sourceMapping?.role === 'prompt') continue;
    if (sourceMapping?.role === 'flow' && targetMapping?.role === 'flow') {
      connect('main', source.id, target.id, outputIndexOf(edge));
      continue;
    }
    if (placeholders.has(edge.source) || placeholders.has(edge.target)) {
      if (sourceMapping?.role === 'flow' || targetMapping?.role === 'flow' || (component(edge.source).endsWith('Agentflow') && component(edge.target).endsWith('Agentflow'))) {
        if (outputIndexOf(edge) === 0) connect('main', source.id, target.id);
        else warn(`Connection ${label} dropped: output ${outputIndexOf(edge) + 1} of a placeholder has no equivalent.`);
      } else warn(`Connection ${label} dropped: placeholders can't be sub-nodes.`);
      continue;
    }
    if (component(edge.target) === 'chainTool' && (sourceMapping?.role === 'chain' || sourceMapping?.role === 'agent')) continue;
    // A Custom JS Function runs in the main flow, between the chat message and the chains and agents it feeds (or is fed by).
    const inFlow = (role?: Role) => role === 'function' || role === 'chain' || role === 'agent' || role === 'flow';
    if ((sourceMapping?.role === 'function' || targetMapping?.role === 'function') && inFlow(sourceMapping?.role) && inFlow(targetMapping?.role)) {
      connect('main', source.id, target.id, outputIndexOf(edge));
      if (sourceMapping?.role === 'function') warn(`${label}: the function's result is in {{ $json.output }}; use it in ${target.name}'s prompt if it should see it.`);
      continue;
    }
    const type = sourceMapping && SUPPLIES[sourceMapping.role];
    const input = inputOf(edge);
    if (!type) {
      warn(`Connection ${label} dropped: Landflow can't connect those nodes that way.`);
      continue;
    }
    // Memory on chains has no slot (reported by the chain's converter).
    if (type === 'ai_memory' && target.type !== 'core.aiAgent') continue;
    const accepts = descriptorOf(target.type)?.inputs.some((port) => port.type === type) ?? true;
    if (!accepts) {
      warn(`Connection ${label} (${input || type}) dropped: “${target.name}” has no ${type.replace(/^ai_/, '')} slot in Landflow.`);
      continue;
    }
    connect(type, source.id, target.id);
  }

  // 5. Agentflow's inline models, tools and memory become sub-nodes.
  for (const raw of raws) {
    const name = component(raw.id);
    const node = built.get(raw.id);
    if (!node || (name !== 'agentAgentflow' && name !== 'llmAgentflow')) continue;
    const inputs = isObject(raw.data?.inputs) ? raw.data!.inputs! : {};
    const prefix = name === 'agentAgentflow' ? 'agent' : 'llm';
    const modelName = text(inputs[`${prefix}Model`]);
    const model = MODELS[modelName];
    const config = isObject(json(inputs[`${prefix}ModelConfig`])) ? (json(inputs[`${prefix}ModelConfig`]) as Params) : {};
    if (model) {
      const converted = model.convert!({ node: raw, name: `${node.name} model`, inputs: config, warn, connected: () => false });
      const sub = addNode(model.to, `${node.name} Model`, position(raw, -40, 220), converted.parameters);
      attachCredential({ ...raw, data: { ...raw.data, inputs: {}, credential: config.FLOWISE_CREDENTIAL_ID ? String(config.FLOWISE_CREDENTIAL_ID) : undefined } }, sub, model, Boolean(config.FLOWISE_CREDENTIAL_ID));
      connect('ai_languageModel', sub.id, node.id);
      report.mapped.push({ name: sub.name, from: modelName, to: model.to });
    } else warn(`${node.name}: the model “${modelName || 'none'}” has no Landflow chat model; attach one.`);
    if (name !== 'agentAgentflow') continue;
    list(json(inputs.agentTools)).forEach((entry, i) => {
      const tool = text(entry.agentSelectedTool);
      const mapping = FLOWISE_TYPE_MAP[tool];
      if (mapping?.role !== 'tool') {
        warn(`${node.name}: the tool “${tool}” isn't available in Landflow; it was left out.`);
        return;
      }
      const toolConfig = isObject(json(entry.agentSelectedToolConfig)) ? (json(entry.agentSelectedToolConfig) as Params) : {};
      const converted = mapping.convert ? mapping.convert({ node: raw, name: `${node.name} ${tool}`, inputs: toolConfig, warn, connected: () => false }) : { parameters: {} };
      const sub = addNode(mapping.to, tool === 'calculator' ? 'Calculator' : tool, position(raw, 160 + i * 140, 220), converted.parameters, converted.notes ? { notes: converted.notes } : {});
      connect('ai_tool', sub.id, node.id);
      report.mapped.push({ name: sub.name, from: tool, to: mapping.to });
    });
    if (inputs.agentEnableMemory) {
      const turns = inputs.agentMemoryType === 'windowSize' ? whole(inputs.agentMemoryWindowSize, 10, 1, 100) : 10;
      const sub = addNode('core.simpleMemory', `${node.name} Memory`, position(raw, 60, 220), { turns });
      connect('ai_memory', sub.id, node.id);
      report.mapped.push({ name: sub.name, from: 'agentMemory', to: 'core.simpleMemory' });
    }
  }

  // 6. Chatflows have no trigger: the chat message goes to the chains, agents and functions whose output nobody consumes
  //    (through the functions that feed them: the message enters at the start of that line).
  const hasFlowStart = raws.some((raw) => component(raw.id) === 'startAgentflow');
  if (!hasFlowStart) {
    const endings = raws.filter((raw) => {
      const role = mappingOf(raw.id)?.role;
      return (role === 'chain' || role === 'agent' || role === 'function') && built.has(raw.id) && !outOf(raw.id).some((e) => built.has(e.target) || mappingOf(e.target)?.role === 'retrieverTool');
    });
    const headsOf = (id: string, visited = new Set<string>()): string[] => {
      if (visited.has(id)) return [];
      visited.add(id);
      const incoming = connections.filter((c) => c.type === 'main' && c.target === id).map((c) => c.source);
      return incoming.length ? incoming.flatMap((source) => headsOf(source, visited)) : [id];
    };
    const tooled = raws.filter((raw) => ['chain', 'agent'].includes(mappingOf(raw.id)?.role ?? '') && outOf(raw.id).some((e) => component(e.target) === 'chainTool'));
    for (const raw of tooled) warn(`${labelOf(raw)}: it ran inside a Chain Tool in Flowise; it has no trigger here until it moves to its own workflow.`);
    if (endings.length) {
      const first = endings[0];
      const trigger = addNode('core.chatTrigger', 'When chat message received', [Math.round(num(first.position?.x, 0)) - 380, Math.round(num(first.position?.y, 0))], {});
      // Heads first: connecting as we go would make the trigger a head of the next line.
      const heads = new Set(endings.flatMap((raw) => headsOf(built.get(raw.id)!.id)));
      heads.delete(trigger.id);
      for (const head of heads) connect('main', trigger.id, head);
      if (heads.size > 1) warn(`The chat message goes to ${heads.size} chains, agents or functions (${[...heads].map((id) => nodes.find((n) => n.id === id)?.name).join(', ')}); Flowise answered with one of them.`);
    } else if (!upsertTrigger) {
      warn('No chain or agent was found to answer chat messages; add a Chat Trigger where the conversation starts.');
    }
  }

  report.connections = connections.length;
  report.warnings = [...new Set(report.warnings)];
  const name = text(doc.name).trim() || text(doc.title).trim() || 'Imported Flowise flow';
  return {
    workflow: {
      name,
      ...(typeof doc.description === 'string' && doc.description && { description: doc.description }),
      nodes,
      connections,
      ...(stickyNotes.length && { stickyNotes }),
    } as Omit<Workflow, 'id'>,
    report,
  };
}
