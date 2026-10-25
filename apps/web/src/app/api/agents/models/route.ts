import { modelOptions } from '@/lib/server/agents/models';
import { error, handler, json } from '@/lib/server/http';
import type { ModelProvider } from '@/lib/shared/agents';

export const dynamic = 'force-dynamic';

const PROVIDERS: ModelProvider[] = ['anthropic', 'openai', 'ollama'];

export const GET = handler(async (request: Request) => {
  const url = new URL(request.url);
  const provider = url.searchParams.get('provider') as ModelProvider;
  if (!PROVIDERS.includes(provider)) return error(`provider must be one of ${PROVIDERS.join(', ')}`);
  try {
    const options = await modelOptions(provider, {
      credentialId: url.searchParams.get('credentialId') || undefined,
      baseUrl: url.searchParams.get('baseUrl') || undefined,
    });
    return json({ options });
  } catch (caught) {
    return json({ options: [], error: (caught as Error).message });
  }
});
