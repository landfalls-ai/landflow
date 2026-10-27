/**
 * OpenAI nodes, for OpenAI or any OpenAI-compatible server (the `openAiApi`
 * credential holds the base URL, so Ollama's /v1 works with no key):
 * - OpenAI Chat Model: an `ai_languageModel` sub-node with tool calling, for
 *   the AI Agent and the chains;
 * - OpenAI: an action node to message a model or create embeddings.
 */
import {
  defineNode,
  NodeOperationError,
  type IExecuteContext,
  type ILoadOptionsContext,
  type JsonObject,
  type NodeItem,
  type PropertyOption,
} from '@landflow/sdk';
import { BINARY_INPUT_OPTIONS, optionalAttachments } from './attachments';
import { openAiChat, openAiConnection, openAiEmbeddings, openAiModel, openAiModels, openAiParts, type OpenAiConnection, type OpenAiMessage } from './models';
import { getPath } from './paths';
import { parseJsonReply } from './structured';

const credentials = [{ name: 'openAiApi', required: true }];
const OPENAI = { icon: 'lucide:aperture', color: '#10a37f' };

/** Models that can't chat (OpenAI's catalogue mixes them in). */
const NOT_CHAT = /(embed|tts|whisper|transcribe|dall-e|image|moderation|realtime|audio|search|instruct|davinci|babbage)/i;

async function listModels(ctx: ILoadOptionsContext, kind: 'chat' | 'embedding'): Promise<PropertyOption[]> {
  const connection = openAiConnection(ctx.getCredentials('openAiApi', { optional: true }));
  const models = await openAiModels(connection, ctx.http);
  const embedding = models.filter((model) => /embed/i.test(model.id));
  const chosen = kind === 'embedding' ? (embedding.length ? embedding : models) : models.filter((model) => !NOT_CHAT.test(model.id));
  return chosen
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((model) => ({ name: model.id, value: model.id, ...(model.owned_by && { description: `${connection.label} · ${model.owned_by}` }) }));
}

// ---------------------------------------------------------------------------
// OpenAI Chat Model (sub-node)
// ---------------------------------------------------------------------------

export const openAiChatModelNode = defineNode({
  description: {
    name: 'openAiChatModel',
    displayName: 'OpenAI Chat Model',
    description: 'OpenAI or any OpenAI-compatible API (Ollama, vLLM, LM Studio…), with tool calling',
    version: 1,
    kind: 'subnode',
    supplies: 'ai_languageModel',
    categories: ['AI', 'Models'],
    ...OPENAI,
    subtitle: '{{model}}',
    keywords: ['openai', 'gpt', 'chatgpt', 'llm', 'ollama', 'vllm', 'lm studio', 'openrouter'],
    credentials,
    inputs: [],
    outputs: [{ type: 'ai_languageModel', displayName: 'Model' }],
    properties: [
      {
        name: 'model',
        displayName: 'Model',
        type: 'options',
        default: 'gpt-5-mini',
        options: [{ name: 'gpt-5-mini', value: 'gpt-5-mini' }],
        typeOptions: { loadOptionsMethod: 'chatModels' },
        description: 'Loaded from the server’s /models list',
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          {
            name: 'temperature',
            displayName: 'Sampling Temperature',
            type: 'number',
            default: 0.7,
            typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 2 },
          },
          {
            name: 'maxTokens',
            displayName: 'Maximum Number of Tokens',
            type: 'number',
            default: -1,
            description: '-1: the model’s limit',
            typeOptions: { minValue: -1 },
          },
          {
            name: 'responseFormat',
            displayName: 'Response Format',
            type: 'options',
            default: 'text',
            options: [
              { name: 'Text', value: 'text', description: 'Regular text response' },
              { name: 'JSON', value: 'json_object', description: 'Always a JSON object. The prompt must mention JSON.' },
            ],
          },
        ],
      },
    ],
  },
  supplyData(ctx) {
    const options = ctx.getNodeParameter<{ temperature?: number; maxTokens?: number; responseFormat?: 'text' | 'json_object' }>('options') ?? {};
    return openAiModel(openAiConnection(ctx.getCredentials('openAiApi')), {
      model: String(ctx.getNodeParameter('model') ?? '').trim() || 'gpt-5-mini',
      ...(options.temperature !== undefined && { temperature: Number(options.temperature) }),
      ...(options.maxTokens !== undefined && { maxTokens: Number(options.maxTokens) }),
      ...(options.responseFormat && { responseFormat: options.responseFormat }),
    });
  },
  methods: { loadOptions: { chatModels: (ctx) => listModels(ctx, 'chat') } },
});

// ---------------------------------------------------------------------------
// OpenAI (action)
// ---------------------------------------------------------------------------

interface MessageEntry {
  role?: 'system' | 'user' | 'assistant';
  content?: unknown;
}

const EMBEDDING_BATCH = 100;

async function messageModel(ctx: IExecuteContext, connection: OpenAiConnection): Promise<NodeItem[]> {
  const out: NodeItem[] = [];
  for (const [i] of ctx.getInputData().entries()) {
    const model = String(ctx.getNodeParameter('modelId', i) ?? '').trim();
    if (!model) throw new NodeOperationError('No model selected', { itemIndex: i });
    const messages: OpenAiMessage[] = (ctx.getNodeParameter<{ values?: MessageEntry[] }>('messages', i)?.values ?? [])
      .map((entry) => ({ role: entry.role ?? 'user', content: typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content ?? '') }))
      .filter((entry) => entry.content.trim() !== '' && entry.content !== '""') as OpenAiMessage[];
    if (!messages.some((message) => message.role === 'user')) {
      throw new NodeOperationError('No user message', { itemIndex: i, description: 'Add a message with the role “User”, e.g. {{ $json.text }}.' });
    }
    const jsonOutput = ctx.getNodeParameter<boolean>('jsonOutput', i);
    // OpenAI's JSON mode refuses prompts that never mention JSON.
    if (jsonOutput && !messages.some((message) => /json/i.test(String(message.content))))
      messages.unshift({ role: 'system', content: 'Respond with a JSON object.' });
    const options = ctx.getNodeParameter<{ temperature?: number; maxTokens?: number; passthroughBinaryImages?: boolean; binaryPropertyNames?: string; audioHandling?: string; transcriptionUrl?: string; transcriptionModel?: string; videoHandling?: string }>('options', i) ?? {};
    // "Include Binary as Input": the item's images and PDFs join the last user message.
    const attachments = await optionalAttachments(ctx, i, { ...options, transcriptionUrl: options.transcriptionUrl || connection.base }, { provider: 'openai', model });
    if (attachments) {
      const last = messages.map((m) => m.role).lastIndexOf('user');
      const message = messages[last] as { role: 'user'; content: string };
      messages[last] = { role: 'user', content: openAiParts(String(message.content), attachments) };
    }
    const result = await openAiChat(
      connection,
      {
        model,
        ...(options.temperature !== undefined && { temperature: Number(options.temperature) }),
        ...(options.maxTokens !== undefined && { maxTokens: Number(options.maxTokens) }),
        ...(jsonOutput && { responseFormat: 'json_object' as const }),
      },
      messages,
    );
    let content: unknown = result.refusal ?? result.text;
    if (jsonOutput && !result.refusal) {
      try {
        content = parseJsonReply(result.text);
      } catch (error) {
        throw new NodeOperationError(`The model did not return JSON: ${(error as Error).message}`, { itemIndex: i, description: result.text.slice(0, 300) });
      }
    }
    out.push({
      json: {
        message: { role: 'assistant', content: content as never, ...(result.refusal && { refusal: result.refusal }) },
        usage: { ...result.usage, totalTokens: result.usage.inputTokens + result.usage.outputTokens },
        finishReason: result.finishReason,
        model: result.model ?? model,
      },
      pairedItem: { item: i },
    });
  }
  return out;
}

async function createEmbeddings(ctx: IExecuteContext, connection: OpenAiConnection): Promise<NodeItem[]> {
  const items = ctx.getInputData();
  const model = String(ctx.getNodeParameter('embeddingModel', 0) ?? '').trim();
  if (!model) throw new NodeOperationError('No embedding model selected');
  const options = ctx.getNodeParameter<{ dimensions?: number }>('embeddingOptions', 0) ?? {};
  const texts = items.map((item, i) => {
    const field = String(ctx.getNodeParameter('inputField', i) ?? '').trim();
    const value = getPath(item.json, field);
    if (value === undefined || value === null || value === '') {
      throw new NodeOperationError(`“${field}” is empty or missing`, {
        itemIndex: i,
        description: 'Set “Input Field” to the field that holds the text to embed.',
      });
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
  const out: NodeItem[] = [];
  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH) {
    const { vectors } = await openAiEmbeddings(connection, model, texts.slice(start, start + EMBEDDING_BATCH), {
      ...(options.dimensions && Number(options.dimensions) > 0 && { dimensions: Number(options.dimensions) }),
    });
    vectors.forEach((embedding, offset) => {
      const i = start + offset;
      out.push({ json: { ...items[i].json, embedding, dimensions: embedding.length } as JsonObject, pairedItem: { item: i } });
    });
  }
  return out;
}

export const openAiNode = defineNode({
  description: {
    name: 'openAi',
    displayName: 'OpenAI',
    description: 'Message a model or create embeddings, on OpenAI or any OpenAI-compatible API',
    version: 1,
    kind: 'action',
    categories: ['AI'],
    ...OPENAI,
    subtitle: '{{operation}}',
    keywords: ['openai', 'gpt', 'chatgpt', 'llm', 'embeddings', 'vectors', 'ollama'],
    credentials,
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    properties: [
      {
        name: 'resource',
        displayName: 'Resource',
        type: 'options',
        default: 'text',
        noDataExpression: true,
        options: [
          { name: 'Text', value: 'text' },
          { name: 'Embeddings', value: 'embeddings' },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        default: 'message',
        noDataExpression: true,
        displayOptions: { show: { resource: ['text'] } },
        options: [{ name: 'Message a Model', value: 'message', action: 'Message a model' }],
      },
      {
        name: 'embeddingsOperation',
        displayName: 'Operation',
        type: 'options',
        default: 'create',
        noDataExpression: true,
        displayOptions: { show: { resource: ['embeddings'] } },
        options: [{ name: 'Create Embeddings', value: 'create', action: 'Create embeddings' }],
      },
      {
        name: 'modelId',
        displayName: 'Model',
        type: 'options',
        default: 'gpt-5-mini',
        options: [{ name: 'gpt-5-mini', value: 'gpt-5-mini' }],
        typeOptions: { loadOptionsMethod: 'chatModels' },
        displayOptions: { show: { resource: ['text'] } },
      },
      {
        name: 'messages',
        displayName: 'Messages',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        displayOptions: { show: { resource: ['text'] } },
        default: {
          values: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: '' },
          ],
        },
        groups: [
          {
            name: 'values',
            displayName: 'Message',
            values: [
              {
                name: 'role',
                displayName: 'Role',
                type: 'options',
                default: 'user',
                options: [
                  { name: 'User', value: 'user', description: 'The prompt' },
                  { name: 'System', value: 'system', description: 'Instructions on how the model should behave' },
                  { name: 'Assistant', value: 'assistant', description: 'An earlier answer, as an example' },
                ],
              },
              { name: 'content', displayName: 'Prompt', type: 'string', default: '', typeOptions: { rows: 3 }, placeholder: '{{ $json.text }}' },
            ],
          },
        ],
      },
      {
        name: 'jsonOutput',
        displayName: 'Output Content as JSON',
        type: 'boolean',
        default: false,
        description: 'Ask for a JSON object and return it parsed',
        displayOptions: { show: { resource: ['text'] } },
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: { show: { resource: ['text'] } },
        values: [
          {
            name: 'temperature',
            displayName: 'Sampling Temperature',
            type: 'number',
            default: 0.7,
            typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 2 },
          },
          { name: 'maxTokens', displayName: 'Maximum Number of Tokens', type: 'number', default: 1024, typeOptions: { minValue: 1 } },
          ...BINARY_INPUT_OPTIONS,
        ],
      },
      {
        name: 'embeddingModel',
        displayName: 'Model',
        type: 'options',
        default: 'text-embedding-3-small',
        options: [{ name: 'text-embedding-3-small', value: 'text-embedding-3-small' }],
        typeOptions: { loadOptionsMethod: 'embeddingModels' },
        displayOptions: { show: { resource: ['embeddings'] } },
      },
      {
        name: 'inputField',
        displayName: 'Input Field',
        type: 'string',
        default: 'text',
        noDataExpression: true,
        required: true,
        description: 'The field that holds the text to embed (dot paths work)',
        displayOptions: { show: { resource: ['embeddings'] } },
      },
      {
        name: 'embeddingOptions',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: { show: { resource: ['embeddings'] } },
        values: [
          { name: 'dimensions', displayName: 'Dimensions', type: 'number', default: 512, description: 'Shorten the vectors (text-embedding-3 models only)' },
        ],
      },
    ],
  },
  async execute(ctx) {
    const connection = openAiConnection(ctx.getCredentials('openAiApi'));
    const resource = ctx.getNodeParameter<string>('resource', 0);
    return [resource === 'embeddings' ? await createEmbeddings(ctx, connection) : await messageModel(ctx, connection)];
  },
  methods: {
    loadOptions: {
      chatModels: (ctx) => listModels(ctx, 'chat'),
      embeddingModels: (ctx) => listModels(ctx, 'embedding'),
    },
  },
});
