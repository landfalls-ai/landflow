/**
 * AI SDK: a Landflow plugin with one node, "Generate with AI SDK", that calls a model through the Vercel AI SDK
 * (Ollama, an OpenAI-compatible endpoint, Anthropic or Google) and emits the AI SDK's spans as OpenTelemetry through
 * the plugin's own telemetry (docs/research/ai-sdk-verdict.md).
 *
 *   pnpm plugin:ai-sdk
 *
 * Serves HTTP on :7115 and gRPC on :7215, then announces both to the host. Keys come from saved credentials only.
 */
import { definePlugin } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';
import { GenerateWithAiSdk, aiSdkAnthropicApi, aiSdkGoogleApi, aiSdkOllamaApi, aiSdkOpenAiCompatibleApi } from './nodes/generate';

export const plugin = definePlugin({
  info: {
    id: 'ai-sdk',
    name: 'AI SDK',
    version: '0.1.0',
    description: 'Generate text or structured output with the Vercel AI SDK on Ollama, any OpenAI-compatible endpoint, Anthropic or Google',
    icon: 'file:ai-sdk.svg',
    color: '#111827',
    author: 'Landflow',
  },
  nodes: [new GenerateWithAiSdk()],
  credentialTypes: [aiSdkOllamaApi, aiSdkOpenAiCompatibleApi, aiSdkAnthropicApi, aiSdkGoogleApi],
  iconDir: new URL('../icons/', import.meta.url),
});

export const DEFAULT_MAX_CONCURRENCY = 4;

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(plugin, {
    http: 7115,
    grpc: 7215,
    host: process.env.LANDFLOW_HOST ?? (process.env.LANDFLOW_ADVERTISE_HOST ? '0.0.0.0' : '127.0.0.1'),
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
  });
}
