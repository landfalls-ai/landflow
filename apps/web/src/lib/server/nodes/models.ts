/**
 * LanguageModel adapters supplied by the chat-model sub-nodes. Each adapter
 * maps the provider-neutral AgentMessage list onto its provider's wire format.
 * Every call is a `gen_ai.chat {model}` span (a child of the model sub-node's
 * span) and counts in the `landflow.ai.*` metrics.
 */
import Anthropic from '@anthropic-ai/sdk';
import { NodeOperationError, type JsonObject } from '@landflow/sdk';
import type { AgentMessage, LanguageModel, ModelTurn, ToolCall, ToolSpec } from '@landflow/engine';
import type { Attributes } from '@opentelemetry/api';
import { traceChat, traceEmbeddings } from '../telemetry';

/**
 * The engine's generate() input. Root nodes that need structured output (chains,
 * classifier, extractor) set `responseFormat: 'json'`; adapters with a JSON mode
 * (OpenAI's `response_format`, Ollama's `format`) use it, the others rely on the prompt.
 */
export type GenerateInput = Parameters<LanguageModel['generate']>[0];

/** What a provider call returned: the turn and the model that actually answered. */
interface ProviderReply {
  turn: ModelTurn;
  model?: string;
}

const describeReply = (reply: ProviderReply) => ({
  responseModel: reply.model,
  inputTokens: reply.turn.usage?.inputTokens,
  outputTokens: reply.turn.usage?.outputTokens,
  finishReasons: [reply.turn.stopReason],
});

const parseUrl = (url: string) => (URL.canParse(url) ? new URL(url) : undefined);

// ---------------------------------------------------------------------------
// Anthropic (Claude)
// ---------------------------------------------------------------------------

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * After a mid-output server-side fallback, model-internal blocks that precede
 * the last `fallback` marker must not be echoed back (text blocks may be).
 */
function echoable(content: Anthropic.Beta.BetaContentBlock[]): Anthropic.Beta.BetaContentBlockParam[] {
  const boundary = content.map((b) => b.type as string).lastIndexOf('fallback');
  return content.filter((block, index) => {
    if (index >= boundary) return true;
    return !['thinking', 'redacted_thinking', 'tool_use'].includes(block.type);
  }) as Anthropic.Beta.BetaContentBlockParam[];
}

function toAnthropicMessages(messages: AgentMessage[]): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((message): Anthropic.Beta.BetaMessageParam => {
    if (message.role === 'user') return { role: 'user', content: message.content };
    if (message.role === 'tool') {
      return {
        role: 'user',
        content: message.results.map((result) => ({
          type: 'tool_result' as const,
          tool_use_id: result.id,
          content: result.content,
          ...(result.isError && { is_error: true }),
        })),
      };
    }
    // Replay Claude's own blocks verbatim (thinking blocks must round-trip unchanged).
    if (message.raw?.provider === 'anthropic') {
      return { role: 'assistant', content: echoable(message.raw.content as Anthropic.Beta.BetaContentBlock[]) };
    }
    return {
      role: 'assistant',
      content: [
        ...(message.text ? [{ type: 'text' as const, text: message.text }] : []),
        ...message.toolCalls.map((call) => ({ type: 'tool_use' as const, id: call.id, name: call.name, input: call.input })),
      ],
    };
  });
}

export function anthropicModel(options: { model: string; effort: Effort; maxTokens: number; fallback: boolean; apiKey?: string; baseUrl?: string }): LanguageModel {
  let client: Anthropic;
  try {
    // A selected Anthropic credential wins; otherwise the SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
    client = options.apiKey ? new Anthropic({ apiKey: options.apiKey, ...(options.baseUrl && { baseURL: options.baseUrl }) }) : new Anthropic();
  } catch (error) {
    throw new NodeOperationError('No Anthropic credentials found', {
      description: `Set ANTHROPIC_API_KEY for the Landflow server or run \`ant auth login\`. (${(error as Error).message})`,
    });
  }
  // Claude Haiku has no server-side fallback; every other current model opts in.
  const useFallback = options.fallback && !options.model.startsWith('claude-haiku');

  const address = parseUrl(client.baseURL)?.hostname;

  return {
    provider: 'anthropic',
    model: options.model,
    async generate(input): Promise<ModelTurn> {
      const request = { system: 'anthropic', model: options.model, attributes: { 'gen_ai.request.max_tokens': options.maxTokens, ...(address && { 'server.address': address }) } };
      return (await traceChat(request, () => call(input), describeReply)).turn;
    },
  };

  async function call({ system, messages, tools, signal }: Parameters<LanguageModel['generate']>[0]): Promise<ProviderReply> {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await client.beta.messages.create(
        {
          model: options.model,
          max_tokens: options.maxTokens,
          ...(system && { system }),
          messages: toAnthropicMessages(messages),
          ...(tools.length && {
            tools: tools.map((tool: ToolSpec) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
            })),
          }),
          output_config: { effort: options.effort },
          ...(useFallback && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
        },
        { signal },
      );
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) {
        throw new NodeOperationError('Anthropic rejected the credentials', {
          description: options.apiKey ? 'Check the API key of the Anthropic credential.' : 'Check ANTHROPIC_API_KEY / `ant auth status`.',
        });
      }
      if (error instanceof Anthropic.RateLimitError) {
        throw new NodeOperationError('Anthropic rate limit reached', { description: error.message });
      }
      if (error instanceof Anthropic.APIError) {
        throw new NodeOperationError(`Anthropic API error ${error.status ?? ''}`.trim(), { description: error.message });
      }
      throw error;
    }

    if (response.stop_reason === 'refusal') {
      const category = response.stop_details?.category ?? 'unspecified';
      return { turn: { text: `The model declined this request (category: ${category}).`, toolCalls: [], stopReason: 'refusal' }, model: response.model };
    }
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const toolCalls = response.content
      .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }));
    if (response.stop_reason === 'max_tokens' && toolCalls.length) {
      throw new NodeOperationError('Model output was cut off mid tool call', { description: 'Raise “Max Tokens” on the chat model node.' });
    }
    return {
      turn: {
        text,
        toolCalls,
        stopReason: response.stop_reason ?? 'end_turn',
        raw: { provider: 'anthropic', content: response.content },
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      },
      model: response.model,
    };
  }
}

// ---------------------------------------------------------------------------
// Ollama (local models, OpenAI-style tool calling via /api/chat)
// ---------------------------------------------------------------------------

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
}

export function ollamaModel(options: { baseUrl: string; model: string; temperature?: number }): LanguageModel {
  const base = options.baseUrl.replace(/\/+$/, '');
  const url = parseUrl(base);
  const address = url?.hostname;
  const port = Number(url?.port) || undefined;
  return {
    provider: 'ollama',
    model: options.model,
    async generate(input): Promise<ModelTurn> {
      const attributes = {
        ...(address && { 'server.address': address }),
        ...(port && { 'server.port': port }),
        ...(options.temperature !== undefined && { 'gen_ai.request.temperature': options.temperature }),
      };
      return (await traceChat({ system: 'ollama', model: options.model, attributes }, () => call(input), describeReply)).turn;
    },
  };

  async function call({ system, messages, tools, signal, responseFormat }: GenerateInput): Promise<ProviderReply> {
    const wire: OllamaMessage[] = [];
    if (system) wire.push({ role: 'system', content: system });
    for (const message of messages) {
      if (message.role === 'user') wire.push({ role: 'user', content: message.content });
      else if (message.role === 'assistant') {
        wire.push({
          role: 'assistant',
          content: message.text,
          ...(message.toolCalls.length && {
            tool_calls: message.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.input } })),
          }),
        });
      } else {
        for (const result of message.results) wire.push({ role: 'tool', content: result.content, tool_name: result.name });
      }
    }
    let response: Response;
    try {
      response = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: options.model,
          messages: wire,
          stream: false,
          ...(tools.length && {
            tools: tools.map((tool) => ({
              type: 'function',
              function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
            })),
          }),
          ...(options.temperature !== undefined && { options: { temperature: options.temperature } }),
          ...(responseFormat === 'json' && { format: 'json' }),
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
      });
    } catch (error) {
      throw new NodeOperationError(`Cannot reach Ollama at ${base}`, { description: (error as Error).message });
    }
    if (!response.ok) throw new NodeOperationError(`Ollama error ${response.status}`, { description: await response.text() });
    const data = (await response.json()) as {
      model?: string;
      message: { content?: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> | string } }> };
      done_reason?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const text = stripThinking(data.message.content ?? '');
    const toolCalls = (data.message.tool_calls ?? []).map((call, index) => ({
      id: `call_${Date.now().toString(36)}_${index}`,
      name: call.function.name,
      input: typeof call.function.arguments === 'string' ? safeJson(call.function.arguments) : call.function.arguments,
    }));
    return {
      turn: {
        text,
        toolCalls,
        stopReason: toolCalls.length ? 'tool_use' : (data.done_reason ?? 'stop'),
        usage: { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 },
      },
      model: data.model,
    };
  }
}

/** Reasoning models served by Ollama and others may inline `<think>…</think>` before the answer. */
const stripThinking = (text: string) => text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

function safeJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { input: text };
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible APIs (OpenAI, Ollama's /v1, vLLM, LM Studio, OpenRouter…)
// ---------------------------------------------------------------------------

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** Where and how to call an OpenAI-compatible server, from an `openAiApi` credential. */
export interface OpenAiConnection {
  base: string;
  /** `gen_ai.system`: `ollama` when the URL points at Ollama (port 11434 or an "ollama" host), else `openai`. */
  system: 'openai' | 'ollama';
  /** Who to blame in error messages: OpenAI, Ollama or the host name. */
  label: string;
  /** api.openai.com, which takes `max_completion_tokens` instead of `max_tokens`. */
  official: boolean;
  headers: Record<string, string>;
  attributes: Attributes;
}

export function openAiConnection(credentials: JsonObject | undefined): OpenAiConnection {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const base = (text(credentials?.baseUrl) || OPENAI_BASE_URL).replace(/\/+$/, '');
  const url = parseUrl(base);
  if (!url || !/^https?:$/.test(url.protocol)) {
    throw new NodeOperationError(`Invalid base URL “${base}”`, { description: 'Use the API root, e.g. https://api.openai.com/v1 or http://127.0.0.1:11434/v1.' });
  }
  const official = url.hostname === 'api.openai.com';
  const system = url.port === '11434' || /ollama/i.test(url.hostname) ? 'ollama' : 'openai';
  const apiKey = text(credentials?.apiKey);
  const organization = text(credentials?.organization);
  return {
    base,
    system,
    label: official ? 'OpenAI' : system === 'ollama' ? 'Ollama' : url.host,
    official,
    headers: {
      'content-type': 'application/json',
      ...(apiKey && { authorization: `Bearer ${apiKey}` }),
      ...(organization && { 'openai-organization': organization }),
    },
    attributes: { 'server.address': url.hostname, ...(url.port && { 'server.port': Number(url.port) }) },
  };
}

/** An HTTP error from an OpenAI-compatible API, with its status. */
export class OpenAiApiError extends NodeOperationError {
  constructor(
    message: string,
    readonly status: number,
    description?: string,
  ) {
    super(message, { ...(description && { description }) });
    this.name = 'OpenAiApiError';
  }
}

function openAiError(connection: OpenAiConnection, status: number, body: string): OpenAiApiError {
  let serverMessage: string | undefined;
  try {
    const parsed = JSON.parse(body) as { error?: string | { message?: string }; message?: string };
    serverMessage = (typeof parsed.error === 'string' ? parsed.error : parsed.error?.message) ?? parsed.message;
  } catch {
    // Not JSON: keep the raw text.
  }
  const detail = serverMessage ?? body.slice(0, 500);
  const { label } = connection;
  if (status === 401) return new OpenAiApiError(`${label} rejected the API key`, status, `${detail} Check the API key of the OpenAI credential.`.trim());
  if (status === 403) return new OpenAiApiError(`${label} denied access`, status, detail);
  // The server's own message ("model 'x' not found") goes in the headline: it is all a continued item keeps.
  if (status === 404) {
    const hint = 'Check the model name and the base URL (it usually ends in /v1).';
    return serverMessage
      ? new OpenAiApiError(`${label}: ${serverMessage} (404)`, status, hint)
      : new OpenAiApiError(`${label}: not found (404)`, status, `${detail} ${hint}`.trim());
  }
  if (status === 429) return new OpenAiApiError(`${label} rate limit or quota reached`, status, detail);
  return new OpenAiApiError(`${label} API error ${status}`, status, detail);
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** One JSON request. HTTP and network failures become NodeOperationErrors that name the server. */
export async function openAiRequest<T>(
  connection: OpenAiConnection,
  path: string,
  init: { body?: unknown; signal?: AbortSignal; timeoutMs?: number; fetcher?: Fetcher } = {},
): Promise<T> {
  const timeout = AbortSignal.timeout(init.timeoutMs ?? 300_000);
  let response: Response;
  try {
    response = await (init.fetcher ?? fetch)(`${connection.base}${path}`, {
      method: init.body === undefined ? 'GET' : 'POST',
      headers: connection.headers,
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    if ((error as Error).name === 'TimeoutError') throw new NodeOperationError(`${connection.label} did not answer within ${Math.round((init.timeoutMs ?? 300_000) / 1000)} s`);
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    throw new NodeOperationError(`Cannot reach ${connection.label} at ${connection.base}`, { description: cause?.code ?? cause?.message ?? (error as Error).message });
  }
  const text = await response.text();
  if (!response.ok) throw openAiError(connection, response.status, text);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new NodeOperationError(`${connection.label} answered with something that is not JSON`, { description: text.slice(0, 300) });
  }
}

export interface OpenAiModelInfo {
  id: string;
  owned_by?: string;
}

/** `GET /models`. */
export async function openAiModels(connection: OpenAiConnection, fetcher?: Fetcher): Promise<OpenAiModelInfo[]> {
  const reply = await openAiRequest<{ data?: OpenAiModelInfo[] }>(connection, '/models', { timeoutMs: 10_000, ...(fetcher && { fetcher }) });
  return (reply.data ?? []).filter((model) => typeof model?.id === 'string');
}

export type OpenAiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ChatCompletion {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      refusal?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string | Record<string, unknown> } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface OpenAiChatOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** `json_object` asks for JSON on every call; per call, GenerateInput.responseFormat can ask too. */
  responseFormat?: 'text' | 'json_object';
}

export interface OpenAiChatResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string;
  refusal?: string;
  model?: string;
  usage: { inputTokens: number; outputTokens: number };
}

export function toOpenAiMessages(system: string | undefined, messages: AgentMessage[]): OpenAiMessage[] {
  const wire: OpenAiMessage[] = system ? [{ role: 'system', content: system }] : [];
  for (const message of messages) {
    if (message.role === 'user') wire.push({ role: 'user', content: message.content });
    else if (message.role === 'tool') for (const result of message.results) wire.push({ role: 'tool', tool_call_id: result.id, content: result.content });
    else {
      wire.push({
        role: 'assistant',
        content: message.text || (message.toolCalls.length ? null : ''),
        ...(message.toolCalls.length && {
          tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) } })),
        }),
      });
    }
  }
  return wire;
}

/** One traced chat completion: a `gen_ai.chat {model}` span plus the AI metrics. */
export async function openAiChat(
  connection: OpenAiConnection,
  options: OpenAiChatOptions,
  messages: OpenAiMessage[],
  extra: { tools?: ToolSpec[]; json?: boolean; signal?: AbortSignal } = {},
): Promise<OpenAiChatResult> {
  const json = options.responseFormat === 'json_object' || extra.json;
  const maxTokens = options.maxTokens && options.maxTokens > 0 ? Math.round(options.maxTokens) : undefined;
  const body = {
    model: options.model,
    messages,
    ...(extra.tools?.length && {
      tools: extra.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
    }),
    ...(options.temperature !== undefined && { temperature: options.temperature }),
    ...(maxTokens && (connection.official ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens })),
    ...(json && { response_format: { type: 'json_object' } }),
  };
  const attributes = {
    ...connection.attributes,
    ...(options.temperature !== undefined && { 'gen_ai.request.temperature': options.temperature }),
    ...(maxTokens && { 'gen_ai.request.max_tokens': maxTokens }),
  };
  return traceChat(
    { system: connection.system, model: options.model, attributes },
    async () => parseCompletion(connection, await openAiRequest<ChatCompletion>(connection, '/chat/completions', { body, ...(extra.signal && { signal: extra.signal }) })),
    (result) => ({ responseModel: result.model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, finishReasons: [result.finishReason] }),
  );
}

function parseCompletion(connection: OpenAiConnection, completion: ChatCompletion): OpenAiChatResult {
  const choice = completion.choices?.[0];
  if (!choice?.message) throw new NodeOperationError(`${connection.label} returned no answer`, { description: JSON.stringify(completion).slice(0, 300) });
  const { message } = choice;
  const stamp = Date.now().toString(36);
  const toolCalls = (message.tool_calls ?? [])
    .filter((call) => call.function?.name)
    .map((call, index) => {
      const args = call.function!.arguments;
      return { id: call.id || `call_${stamp}_${index}`, name: call.function!.name!, input: typeof args === 'string' ? (args.trim() ? safeJson(args) : {}) : (args ?? {}) };
    });
  const finishReason = choice.finish_reason ?? (toolCalls.length ? 'tool_calls' : 'stop');
  if (finishReason === 'length' && toolCalls.length) {
    throw new NodeOperationError('Model output was cut off mid tool call', { description: 'Raise “Max Tokens” on the chat model node.' });
  }
  return {
    text: stripThinking(message.content ?? ''),
    toolCalls,
    finishReason,
    ...(message.refusal && { refusal: message.refusal }),
    ...(completion.model && { model: completion.model }),
    usage: { inputTokens: completion.usage?.prompt_tokens ?? 0, outputTokens: completion.usage?.completion_tokens ?? 0 },
  };
}

/** The OpenAI Chat Model sub-node's LanguageModel: chat completions with tool calling. */
export function openAiModel(connection: OpenAiConnection, options: OpenAiChatOptions): LanguageModel {
  return {
    provider: connection.system,
    model: options.model,
    async generate({ system, messages, tools, signal, responseFormat }: GenerateInput): Promise<ModelTurn> {
      const result = await openAiChat(connection, options, toOpenAiMessages(system, messages), { tools, json: responseFormat === 'json', ...(signal && { signal }) });
      if (result.refusal) return { text: result.refusal, toolCalls: [], stopReason: 'refusal', usage: result.usage };
      return { text: result.text, toolCalls: result.toolCalls, stopReason: result.finishReason, usage: result.usage };
    },
  };
}

/** `POST /embeddings` for a batch of texts, in a `gen_ai.embeddings {model}` span. */
export async function openAiEmbeddings(
  connection: OpenAiConnection,
  model: string,
  input: string[],
  options: { dimensions?: number; signal?: AbortSignal } = {},
): Promise<{ vectors: number[][]; model?: string; inputTokens?: number }> {
  return traceEmbeddings(
    { system: connection.system, model, attributes: connection.attributes },
    async () => {
      const reply = await openAiRequest<{ model?: string; data?: Array<{ index?: number; embedding?: unknown }>; usage?: { prompt_tokens?: number } }>(connection, '/embeddings', {
        body: { model, input, ...(options.dimensions && { dimensions: options.dimensions }) },
        ...(options.signal && { signal: options.signal }),
      });
      const data = [...(reply.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (data.length !== input.length || data.some((entry) => !Array.isArray(entry.embedding))) {
        throw new NodeOperationError(`${connection.label} returned ${data.length} embedding(s) for ${input.length} input(s)`, { description: 'Is this an embedding model?' });
      }
      return { vectors: data.map((entry) => entry.embedding as number[]), ...(reply.model && { model: reply.model }), ...(reply.usage?.prompt_tokens !== undefined && { inputTokens: reply.usage.prompt_tokens }) };
    },
    (result) => ({ responseModel: result.model, inputTokens: result.inputTokens, dimensions: result.vectors[0]?.length }),
  );
}
