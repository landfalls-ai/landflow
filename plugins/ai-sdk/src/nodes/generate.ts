import { NodeOperationError, defineCredentialType, type IExecuteContext, type INodeType, type JsonObject, type NodeDescriptor, type NodeItem } from '@landflow/sdk';
import { Output, generateText, jsonSchema, type LanguageModel } from 'ai';
import { OpenTelemetry } from '@ai-sdk/otel';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export const PROVIDERS = ['ollama', 'openaiCompatible', 'anthropic', 'google'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const OLLAMA_URL = 'http://127.0.0.1:11434';
export const MAX_PROMPT_LENGTH = 200_000;

type KeyCredential = { apiKey: string; baseUrl?: string };
type UrlCredential = { baseUrl?: string; apiKey?: string };

const keyField = { name: 'apiKey', displayName: 'API Key', type: 'string' as const, required: true, typeOptions: { password: true } };
const urlField = (description: string, def = '') => ({ name: 'baseUrl', displayName: 'API Base URL', type: 'string' as const, default: def, description });

export const aiSdkOllamaApi = defineCredentialType<UrlCredential>({
  name: 'aiSdkOllamaApi',
  displayName: 'AI SDK: Ollama',
  icon: 'file:ai-sdk.svg',
  description: 'A local or remote Ollama server. Both fields are optional.',
  properties: [urlField(`Default ${OLLAMA_URL}`), { name: 'apiKey', displayName: 'Bearer Token', type: 'string', typeOptions: { password: true }, default: '', description: 'Only behind a proxy that asks for one' }],
});
export const aiSdkOpenAiCompatibleApi = defineCredentialType<UrlCredential>({
  name: 'aiSdkOpenAiCompatibleApi',
  displayName: 'AI SDK: OpenAI-compatible',
  icon: 'file:ai-sdk.svg',
  description: 'Any server that speaks the OpenAI chat completions API (OpenAI, vLLM, LM Studio, OpenRouter, a gateway).',
  properties: [{ ...urlField('Including the /v1 part, for example https://api.openai.com/v1'), required: true }, { name: 'apiKey', displayName: 'API Key', type: 'string', typeOptions: { password: true }, default: '' }],
});
export const aiSdkAnthropicApi = defineCredentialType<KeyCredential>({
  name: 'aiSdkAnthropicApi',
  displayName: 'AI SDK: Anthropic',
  icon: 'file:ai-sdk.svg',
  description: 'An Anthropic API key.',
  properties: [keyField, urlField('Change it only for a proxy. Default https://api.anthropic.com/v1')],
});
export const aiSdkGoogleApi = defineCredentialType<KeyCredential>({
  name: 'aiSdkGoogleApi',
  displayName: 'AI SDK: Google Generative AI',
  icon: 'file:ai-sdk.svg',
  description: 'A Google AI Studio (Gemini) API key.',
  properties: [keyField, urlField('Change it only for a proxy. Default https://generativelanguage.googleapis.com/v1beta')],
});

/** Build the AI SDK model for a provider from the saved credential. Keys never come from parameters. */
export function buildModel(ctx: IExecuteContext, provider: Provider, modelId: string, structured: boolean): LanguageModel {
  const clean = (s: string | undefined) => s?.trim() || undefined;
  switch (provider) {
    case 'ollama': {
      const saved = ctx.getCredentials<UrlCredential>('aiSdkOllamaApi', { optional: true });
      const base = (clean(saved?.baseUrl) ?? OLLAMA_URL).replace(/\/+$/, '');
      return createOpenAICompatible({ name: 'ollama', baseURL: `${base}/v1`, apiKey: clean(saved?.apiKey), supportsStructuredOutputs: structured })(modelId);
    }
    case 'openaiCompatible': {
      const saved = ctx.getCredentials<UrlCredential>('aiSdkOpenAiCompatibleApi');
      const base = clean(saved.baseUrl);
      if (!base) throw new NodeOperationError('The OpenAI-compatible credential has no base URL');
      return createOpenAICompatible({ name: 'openai-compatible', baseURL: base.replace(/\/+$/, ''), apiKey: clean(saved.apiKey), supportsStructuredOutputs: structured })(modelId);
    }
    case 'anthropic': {
      const saved = ctx.getCredentials<KeyCredential>('aiSdkAnthropicApi');
      if (!clean(saved.apiKey)) throw new NodeOperationError('The Anthropic credential has no API key');
      return createAnthropic({ apiKey: saved.apiKey.trim(), baseURL: clean(saved.baseUrl) })(modelId);
    }
    case 'google': {
      const saved = ctx.getCredentials<KeyCredential>('aiSdkGoogleApi');
      if (!clean(saved.apiKey)) throw new NodeOperationError('The Google credential has no API key');
      return createGoogleGenerativeAI({ apiKey: saved.apiKey.trim(), baseURL: clean(saved.baseUrl) })(modelId);
    }
  }
}

function parseSchema(text: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new NodeOperationError('The JSON schema is not valid JSON', { description: (error as Error).message });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new NodeOperationError('The JSON schema must be a JSON object');
  return jsonSchema(parsed as Record<string, unknown>);
}

export class GenerateWithAiSdk implements INodeType {
  readonly description: NodeDescriptor = {
    name: 'generate',
    displayName: 'Generate with AI SDK',
    description: 'Generate text or structured output with the Vercel AI SDK on Ollama, an OpenAI-compatible endpoint, Anthropic or Google',
    version: 1,
    kind: 'action',
    categories: ['AI'],
    icon: 'file:ai-sdk.svg',
    color: '#111827',
    subtitle: '{{provider}}: {{model}}',
    keywords: ['ai sdk', 'vercel', 'llm', 'ollama', 'openai', 'anthropic', 'gemini', 'generate'],
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [
      { name: 'aiSdkOllamaApi', required: false, displayOptions: { show: { provider: ['ollama'] } } },
      { name: 'aiSdkOpenAiCompatibleApi', required: true, displayOptions: { show: { provider: ['openaiCompatible'] } } },
      { name: 'aiSdkAnthropicApi', required: true, displayOptions: { show: { provider: ['anthropic'] } } },
      { name: 'aiSdkGoogleApi', required: true, displayOptions: { show: { provider: ['google'] } } },
    ],
    outputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'the generated text (with a JSON schema: the JSON as text)' },
        output: { type: 'object', description: 'with a JSON schema: the parsed object' },
        model: { type: 'string', description: 'the model id the provider answered with' },
        provider: { type: 'string' },
        finishReason: { type: 'string' },
        usage: {
          type: 'object',
          properties: { inputTokens: { type: 'number' }, outputTokens: { type: 'number' }, totalTokens: { type: 'number' } },
        },
        traceId: { type: 'string', description: 'the OpenTelemetry trace id the AI SDK spans are in' },
      },
    },
    // A model call costs money and is not repeatable: no tool use, no broker redelivery.
    usableAsTool: false,
    properties: [
      {
        name: 'provider',
        displayName: 'Provider',
        type: 'options',
        default: 'ollama',
        options: [
          { name: 'Ollama', value: 'ollama', description: 'A local model, no key' },
          { name: 'OpenAI-compatible', value: 'openaiCompatible', description: 'Any server with an OpenAI-style /chat/completions' },
          { name: 'Anthropic', value: 'anthropic' },
          { name: 'Google (Gemini)', value: 'google' },
        ],
      },
      { name: 'model', displayName: 'Model', type: 'string', default: '', required: true, placeholder: 'llama3.2', description: 'The model id at the provider' },
      { name: 'system', displayName: 'System Prompt', type: 'string', default: '', typeOptions: { rows: 3 }, description: 'Optional instructions for the model' },
      { name: 'prompt', displayName: 'Prompt', type: 'string', default: '', required: true, typeOptions: { rows: 5 }, description: `At most ${MAX_PROMPT_LENGTH} characters` },
      {
        name: 'jsonSchema',
        displayName: 'JSON Schema (optional)',
        type: 'string',
        default: '',
        typeOptions: { rows: 5 },
        placeholder: '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}',
        description: 'When set, the model must answer with an object that matches this JSON schema; the node returns it in `output`',
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          { name: 'temperature', displayName: 'Temperature', type: 'number', default: 0.7 },
          { name: 'maxOutputTokens', displayName: 'Max Output Tokens', type: 'number', default: 1024 },
          { name: 'timeoutSeconds', displayName: 'Timeout (seconds)', type: 'number', default: 60 },
          { name: 'recordContent', displayName: 'Record Prompts and Answers in Spans', type: 'boolean', default: false, description: 'Off by default: spans carry model, tokens and timing but not the text' },
        ],
      },
    ],
  };

  async execute(ctx: IExecuteContext) {
    const items = ctx.getInputData();
    const out: NodeItem[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const provider = ctx.getNodeParameter<Provider>('provider', i, 'ollama');
        if (!PROVIDERS.includes(provider)) throw new NodeOperationError(`Unknown provider "${provider}"`);
        const modelId = String(ctx.getNodeParameter('model', i, '')).trim();
        if (!modelId) throw new NodeOperationError('No model');
        const prompt = String(ctx.getNodeParameter('prompt', i, ''));
        if (!prompt.trim()) throw new NodeOperationError('The prompt is empty');
        if (prompt.length > MAX_PROMPT_LENGTH) throw new NodeOperationError(`The prompt is longer than ${MAX_PROMPT_LENGTH} characters`);
        const system = String(ctx.getNodeParameter('system', i, '')).trim() || undefined;
        const schemaText = String(ctx.getNodeParameter('jsonSchema', i, '')).trim();
        const options = ctx.getNodeParameter<{ temperature?: number; maxOutputTokens?: number; timeoutSeconds?: number; recordContent?: boolean }>('options', i, {});
        const schema = schemaText ? parseSchema(schemaText) : undefined;
        const model = buildModel(ctx, provider, modelId, Boolean(schema));
        const record = options.recordContent === true;

        const json = await ctx.span('ai-sdk.generate', { 'ai_sdk.provider': provider, 'gen_ai.request.model': modelId }, async (span) => {
          // No tracer is passed: the integration uses the OpenTelemetry global that serve() registered, and the
          // active context, so the AI SDK's spans are children of this span and in the same trace.
          const result = await generateText({
            model,
            ...(system && { system }),
            prompt,
            ...(typeof options.temperature === 'number' && { temperature: options.temperature }),
            maxOutputTokens: Math.max(1, Math.min(Math.round(Number(options.maxOutputTokens ?? 1024)) || 1024, 32_000)),
            timeout: Math.max(1, Math.min(Number(options.timeoutSeconds ?? 60) || 60, 600)) * 1000,
            maxRetries: 0,
            ...(schema && { output: Output.object({ schema }) }),
            telemetry: { isEnabled: true, recordInputs: record, recordOutputs: record, functionId: 'landflow.ai-sdk.generate', integrations: [new OpenTelemetry()] },
          });
          const inputTokens = result.usage?.inputTokens ?? 0;
          const outputTokens = result.usage?.outputTokens ?? 0;
          return {
            text: result.text,
            ...(schema && { output: result.output as unknown as JsonObject }),
            model: result.response?.modelId ?? modelId,
            provider,
            finishReason: result.finishReason,
            usage: { inputTokens, outputTokens, totalTokens: result.usage?.totalTokens ?? inputTokens + outputTokens },
            traceId: span.spanContext().traceId,
          } as JsonObject;
        });
        out.push({ json, pairedItem: { item: i } });
      } catch (error) {
        if (!ctx.continueOnFail()) throw error;
        out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
      }
    }
    return out;
  }
}
