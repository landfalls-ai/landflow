/**
 * SB19: the model Spotlight uses. The list comes only from what the server is configured for; every Spotlight route
 * checks `model` against it (400 "Not a model this server offers"); a saved default applies when none is asked; only an
 * admin changes the default.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFakeLiteLlm } from './fake-litellm';

// A fake Ollama: the model list (a chat model, a second one, an embedding model) and /api/chat, recording what it was asked.
const asked: Array<{ path: string; model?: string }> = [];
const DEFAULT_TAGS: Array<{ name: string; capabilities?: string[] }> = [{ name: 'qwen3-coder:30b', capabilities: ['completion', 'tools'] }, { name: 'llama3.2:3b', capabilities: ['completion'] }, { name: 'nomic-embed-text:latest', capabilities: ['embedding'] }];
let tags = DEFAULT_TAGS;
const ollama: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c as Buffer));
  req.on('end', () => {
    const path = (req.url ?? '/').split('?')[0];
    res.setHeader('content-type', 'application/json');
    if (path === '/api/tags') {
      res.end(JSON.stringify({ models: tags }));
      return;
    }
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: string }) : {};
    asked.push({ path, model: body.model });
    res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: JSON.stringify({ suggestions: [] }) }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 8 }));
  });
});
await new Promise<void>((resolve) => ollama.listen(0, '127.0.0.1', resolve));
const gateway = await startFakeLiteLlm({ models: ['qwen3-coder:30b', 'claude-sonnet-5-5'] });

const ENV = {
  LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-spotlight-model-')),
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_BUILDER_MODEL: 'qwen3-coder:30b',
  OLLAMA_URL: `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`,
};
const previousEnv = { ...process.env };
for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'LANDFLOW_LLM_GATEWAY_URL', 'LANDFLOW_LLM_GATEWAY_KEY']) delete process.env[key];
Object.assign(process.env, ENV);

const { corePlugin } = await import('@/lib/server/nodes');
const { registry } = await import('@/lib/server/plugins/registry');
const { spotlightModels, resolveSpotlightModel, forgetSpotlightModels, saveSpotlightDefault, effectiveSpotlightDefault } = await import('@/lib/server/assistant/models-list');
const { forgetGatewayModels } = await import('@/lib/server/llm-gateway/models');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { aiUsageMeter, saveAiCaps } = await import('@/lib/server/ai-usage');
const { database } = await import('@/lib/server/db');
const settingsRoute = await import('@/app/api/settings/spotlight/route');
const chatRoute = await import('@/app/api/assistant/chat/route');
const buildRoute = await import('@/app/api/ai/build/route');
const designRoute = await import('@/app/api/agents/design/route');
const agentRoute = await import('@/app/api/assistant/agent/route');
const suggestRoute = await import('@/app/api/assistant/suggest/route');

type User = Awaited<ReturnType<typeof createUser>>;
let member: User;
const as = async <T>(user: User | undefined, fn: () => Promise<T>): Promise<T> => {
  enableTestAuth(user);
  try {
    return await fn();
  } finally {
    enableTestAuth();
  }
};

beforeAll(async () => {
  registry.registerBuiltin(corePlugin);
  member = await createUser({ email: 'mia@spotlight.test', name: 'Mia', role: 'member', password: 'mia-password-1' });
});

afterAll(async () => {
  await gateway.close();
  await new Promise<void>((resolve) => ollama.close(() => resolve()));
  for (const key of [...Object.keys(ENV), 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'LANDFLOW_LLM_GATEWAY_URL', 'LANDFLOW_LLM_GATEWAY_KEY']) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

beforeEach(() => {
  forgetSpotlightModels();
  forgetGatewayModels();
  asked.length = 0;
  tags = DEFAULT_TAGS;
  database().sqlite.exec("DELETE FROM settings WHERE key = 'spotlight'");
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.LANDFLOW_LLM_GATEWAY_URL;
  delete process.env.LANDFLOW_LLM_GATEWAY_KEY;
});

const post = (path: string, body: unknown) => new Request(`http://spotlight.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const put = (body: unknown) => new Request('http://spotlight.test/api/settings/spotlight', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
type Route = (request: Request) => Promise<Response>;
const call = (route: unknown, request: Request) => (route as Route)(request);

const workflow = { name: 'W', nodes: [{ id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }], connections: [] };
const chat = (model?: string) => post('/api/assistant/chat', { messages: [{ role: 'user', content: 'Hello' }], workflow, ...(model && { model }) });

describe('the models Spotlight may use', () => {
  it('lists only the chat models Ollama has, never an embedding model, and no key-only provider', async () => {
    expect((await spotlightModels()).map((m) => m.id)).toEqual(['qwen3-coder:30b', 'llama3.2:3b']);
    expect((await spotlightModels()).every((m) => m.local && m.source === 'ollama')).toBe(true);
  });

  it('adds litellm/… when the server has a gateway', async () => {
    process.env.LANDFLOW_LLM_GATEWAY_URL = gateway.origin;
    process.env.LANDFLOW_LLM_GATEWAY_KEY = 'sk-fake-master';
    const models = await spotlightModels();
    expect(models.map((m) => m.id)).toEqual(['qwen3-coder:30b', 'llama3.2:3b', 'litellm/claude-sonnet-5-5', 'litellm/qwen3-coder:30b']);
    expect(models.find((m) => m.id === 'litellm/qwen3-coder:30b')).toMatchObject({ source: 'gateway', local: false });
  });

  it('adds anthropic/… only when the server has its own key (and makes no call)', async () => {
    expect((await spotlightModels()).some((m) => m.id.startsWith('anthropic/'))).toBe(false);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-made-up-for-a-test';
    const models = await spotlightModels();
    expect(models.filter((m) => m.source === 'anthropic').length).toBeGreaterThan(0);
    expect(models.every((m) => m.id.startsWith('anthropic/') || !m.id.includes('/') || m.id.startsWith('litellm/'))).toBe(true);
  });
});

describe('the list is trustworthy', () => {
  it('filters non-chat models by Ollama\'s capabilities when it sends them, the name only as the fallback (SB19-N4)', async () => {
    tags = [{ name: 'qwen3-coder:30b', capabilities: ['completion', 'tools'] }, { name: 'bge-m3:latest', capabilities: ['embedding'] }, { name: 'tts-helper:7b', capabilities: ['completion'] }, { name: 'all-minilm-embed:latest' }, { name: 'plain-old:7b' }];
    const ids = (await spotlightModels()).map((m) => m.id);
    expect(ids).toEqual(['qwen3-coder:30b', 'tts-helper:7b', 'plain-old:7b']);
  });

  it('does not cache a list when a source did not answer: a gateway that fails once, then answers, is listed once the short cache ends (IR-4)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let fail = true;
    const flaky = createServer((req, res) => {
      if (fail) {
        fail = false;
        res.statusCode = 500;
        res.end('{"error":"down"}');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'claude-sonnet-5-5', object: 'model', owned_by: 'x' }] }));
    });
    await new Promise<void>((resolve) => flaky.listen(0, '127.0.0.1', resolve));
    try {
      process.env.LANDFLOW_LLM_GATEWAY_URL = `http://127.0.0.1:${(flaky.address() as AddressInfo).port}`;
      process.env.LANDFLOW_LLM_GATEWAY_KEY = 'sk-fake-master';
      expect((await spotlightModels()).some((m) => m.id.startsWith('litellm/'))).toBe(false);
      vi.setSystemTime(Date.now() + 9_000);
      expect(await resolveSpotlightModel('litellm/claude-sonnet-5-5')).toEqual({ model: 'litellm/claude-sonnet-5-5' });
    } finally {
      vi.useRealTimers();
      await new Promise<void>((resolve) => flaky.close(() => resolve()));
    }
  });

  it('keeps an incomplete list for a few seconds, so a host without Ollama does not list on every request', async () => {
    const before = asked.length;
    const down = process.env.OLLAMA_URL;
    process.env.OLLAMA_URL = 'http://127.0.0.1:1';
    let calls = 0;
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => (calls++, real(url, init)));
    try {
      await spotlightModels();
      const first = calls;
      await spotlightModels();
      expect(calls).toBe(first); // the second request is served from the short cache
      expect(first).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
      process.env.OLLAMA_URL = down;
      forgetSpotlightModels();
    }
    expect(asked.length).toBe(before);
  });

  it('lists a default that is an anthropic/ or openai/ model as cloud, a bare name as local (IR-3)', async () => {
    const { describeSpotlightModel } = await import('@/lib/server/assistant/models-list');
    expect(describeSpotlightModel('anthropic/claude-sonnet-5-5')).toEqual({ id: 'anthropic/claude-sonnet-5-5', label: 'claude-sonnet-5-5', source: 'anthropic', local: false });
    expect(describeSpotlightModel('openai/gpt-x')).toMatchObject({ source: 'openai', local: false });
    expect(describeSpotlightModel('litellm/qwen3.8')).toMatchObject({ source: 'gateway', local: false });
    expect(describeSpotlightModel('qwen3-coder:30b')).toMatchObject({ source: 'ollama', local: true });
  });
});

describe('the default', () => {
  it('is the server’s own until an admin saves another, and falls back when the saved one is no longer listed', async () => {
    expect(await effectiveSpotlightDefault()).toBe('qwen3-coder:30b');
    expect(await saveSpotlightDefault('llama3.2:3b')).toEqual({ ok: true });
    expect(await resolveSpotlightModel()).toEqual({ model: 'llama3.2:3b' });
    database().upsert('settings', { key: 'spotlight', value: JSON.stringify({ model: 'gone:1b' }) });
    expect(await resolveSpotlightModel()).toEqual({ model: 'qwen3-coder:30b' });
  });

  it('is saved through the settings route by an admin, never by a member, and never an unlisted model', async () => {
    expect((await as(member, () => call(settingsRoute.PUT, put({ model: 'llama3.2:3b' })))).status).toBe(403);
    const refused = await call(settingsRoute.PUT, put({ model: 'anthropic/claude-x' }));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe('Not a model this server offers: anthropic/claude-x');
    const saved = await call(settingsRoute.PUT, put({ model: 'llama3.2:3b' }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ default: 'llama3.2:3b' });
    // Any reader sees the same list.
    const read = await as(member, () => (settingsRoute.GET as unknown as () => Promise<Response>)());
    expect(((await read.json()) as { models: unknown[] }).models).toHaveLength(2);
  });
});

describe('the routes check the model', () => {
  it('chat refuses a model the server does not offer, and runs a listed one as a member', async () => {
    const refused = await as(member, () => call(chatRoute.POST, chat('anthropic/claude-x')));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe('Not a model this server offers: anthropic/claude-x');
    const ok = await as(member, () => call(chatRoute.POST, chat('llama3.2:3b')));
    expect(ok.status).toBe(200);
    await ok.text();
    expect(asked.filter((a) => a.path === '/api/chat').map((a) => a.model)).toContain('llama3.2:3b');
  });

  it('chat with no model uses the Settings default', async () => {
    await saveSpotlightDefault('llama3.2:3b');
    const ok = await call(chatRoute.POST, chat());
    expect(ok.status).toBe(200);
    await ok.text();
    expect(asked.filter((a) => a.path === '/api/chat').map((a) => a.model)).toEqual(['llama3.2:3b']);
  });

  it('build, design, agent and suggest refuse an unlisted model the same way', async () => {
    const run = { status: 'success', items: 1 };
    const requests = [
      [buildRoute.POST, post('/api/ai/build', { prompt: 'send an email', model: 'openai/gpt-x' })],
      [designRoute.POST, post('/api/agents/design', { name: 'Triage', model: 'openai/gpt-x' })],
      [agentRoute.POST, post('/api/assistant/agent', { messages: [{ role: 'user', content: 'make one' }], model: 'openai/gpt-x' })],
      [suggestRoute.POST, post('/api/assistant/suggest', { workflow, nodeId: 'a', run, model: 'openai/gpt-x' })],
    ] as const;
    for (const [route, request] of requests) {
      const response = await call(route, request);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe('Not a model this server offers: openai/gpt-x');
    }
    expect(asked.filter((a) => a.path === '/api/chat')).toHaveLength(0);
  });

  it('a member over their AI cap gets the cap error from the build route (it runs in a usage scope)', async () => {
    saveAiCaps({ credentials: {}, users: { [member.id]: { name: 'Mia', dayTokens: 10 } } });
    aiUsageMeter().invalidateCaps();
    try {
      // The first call goes over the cap (20 tokens of 10) and is counted; the next one is refused.
      await as(member, () => call(buildRoute.POST, post('/api/ai/build', { prompt: 'a flow with one step' })));
      const second = await as(member, () => call(buildRoute.POST, post('/api/ai/build', { prompt: 'a flow with one step' })));
      expect(second.status).toBe(429); // SB19-N2: as the design route answers a reached cap
      expect(((await second.json()) as { error: string }).error).toMatch(/AI usage cap reached/);
    } finally {
      saveAiCaps({ credentials: {}, users: {} });
      aiUsageMeter().invalidateCaps();
    }
  });
});

describe('the after-run suggestion request (IR-2)', () => {
  it('sends the session\'s pick, and nothing when no model was picked', async () => {
    const { useSuggestions } = await import('@/components/editor/assistant');
    const { useSpotlightModel } = await import('@/components/editor/spotlight-model');
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body?: string }) => {
      bodies.push(JSON.parse(init.body ?? '{}'));
      return new Response(JSON.stringify({ suggestions: [] }), { status: 200 });
    });
    try {
      useSpotlightModel.setState({ default: 'qwen3-coder:30b', models: [{ id: 'qwen3-coder:30b', label: 'q', source: 'ollama', local: true }, { id: 'qwen3.8', label: 'q8', source: 'ollama', local: true }], pick: 'qwen3.8' });
      useSuggestions.getState().request('n1', { status: 'error', startedAt: '2026-11-16T10:00:00Z', durationMs: 5, inputs: [], outputs: [] } as never);
      await vi.waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0].model).toBe('qwen3.8');
      useSpotlightModel.setState({ pick: undefined });
      useSuggestions.getState().request('n1', { status: 'error', startedAt: '2026-11-16T10:00:01Z', durationMs: 5, inputs: [], outputs: [] } as never);
      await vi.waitFor(() => expect(bodies).toHaveLength(2));
      expect(bodies[1]).not.toHaveProperty('model');
    } finally {
      vi.unstubAllGlobals();
      useSpotlightModel.setState({ pick: undefined, models: [] });
      useSuggestions.getState().clear();
    }
  });
});

describe('the model picker loads the list only where it shows (SB19-N8)', () => {
  const media = (matches: boolean) => {
    const listeners = new Set<() => void>();
    const query = { matches, addEventListener: (_: string, l: () => void) => listeners.add(l), removeEventListener: (_: string, l: () => void) => listeners.delete(l) };
    return { query: query as unknown as MediaQueryList, listeners, widen: () => { query.matches = true; listeners.forEach((l) => l()); } };
  };

  it('does not fetch on a phone, and fetches once the window reaches md', async () => {
    const { loadWhenWide } = await import('@/components/editor/spotlight-model');
    const load = vi.fn();
    const phone = media(false);
    const stop = loadWhenWide(phone.query, load);
    expect(load).not.toHaveBeenCalled();
    phone.widen();
    expect(load).toHaveBeenCalledTimes(1);
    stop();
    expect(phone.listeners.size).toBe(0);
  });

  it('fetches at once at md and up', async () => {
    const { loadWhenWide } = await import('@/components/editor/spotlight-model');
    const load = vi.fn();
    loadWhenWide(media(true).query, load);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
