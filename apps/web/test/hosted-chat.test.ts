/**
 * The hosted chat page and embeddable widget of a public Chat Message trigger (app/chat/[...path], lib/server/chat.ts):
 * the widget script, the page and its config, unpublished and private chats, Allowed Origins (CORS), Basic Auth,
 * streamed and JSON replies, "Load Previous Session" transcripts and file uploads that reach the model.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import { readSse, startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-hosted-chat-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://chat.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { publishDraft } = await import('@/lib/server/publish');
const { mimeAllowed, originAllowed } = await import('@/lib/server/chat');
const chatRoute = await import('@/app/chat/[...path]/route');

registry.registerBuiltin(corePlugin);
const fake = await startFakeModels();
const openAi = credentials.create({ name: 'Fake OpenAI', type: 'core.openAiApi', data: { apiKey: 'sk-test', baseUrl: fake.url } });

afterAll(async () => {
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
const edge = (source: string, target: string, type: 'main' | 'ai_languageModel' = 'main') => ({ id: `${source}-${target}`, type, source, target, sourceIndex: 0, targetIndex: 0 });

/** A public chat: Chat trigger (with `chat` parameters) → AI Agent on the fake OpenAI model. */
async function publicChat(id: string, chat: Record<string, unknown> = {}, options: { publish?: boolean; agent?: Record<string, unknown> } = {}): Promise<Workflow> {
  const workflow: Workflow = {
    id,
    name: `Chat ${id}`,
    nodes: [
      node('Chat', 'core.chatTrigger', { public: true, ...chat }),
      node('Agent', 'core.aiAgent', { prompt: '{{ $json.chatInput }}', ...options.agent }),
      node('Model', 'core.openAiChatModel', { model: 'gpt-test' }, { credentials: { openAiApi: { id: openAi.id, name: openAi.name } } }),
    ],
    connections: [edge('Chat', 'Agent'), edge('Model', 'Agent', 'ai_languageModel')],
  };
  store.saveWorkflow(workflow);
  if (options.publish !== false) await publishDraft(id, 'tester', 'chat');
  return workflow;
}

const ctx = (path: string) => ({ params: Promise.resolve({ path: path.split('?')[0].split('/').filter(Boolean) }) });
const get = (path: string, headers: Record<string, string> = {}) => chatRoute.GET(new Request(`http://chat.test/chat/${path}`, { headers }), ctx(path));
const options = (path: string, origin: string) => chatRoute.OPTIONS(new Request(`http://chat.test/chat/${path}`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } }), ctx(path));
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  chatRoute.POST(new Request(`http://chat.test/chat/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), ctx(path));
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

describe('widget and page', () => {
  it('serves the widget script to any site', async () => {
    const response = await get('widget.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/javascript');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    const script = await response.text();
    expect(script).toContain('data-workflow');
    expect(script).toContain('attachShadow');
    // It is valid JavaScript.
    expect(() => new Function(script)).not.toThrow();
  });

  it('serves the hosted page and config of a published public chat by workflow id', async () => {
    await publicChat('wf_chat_page', { title: 'Support <desk>', initialMessages: 'Hello!\nAsk me anything.', allowFileUploads: true });
    const page = await get('wf_chat_page');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<title>Support &lt;desk&gt;</title>');
    expect(html).toContain('<script src="/chat/widget.js" data-workflow="wf_chat_page" data-mode="fullscreen">');

    const config = await (await get('wf_chat_page/config')).json();
    expect(config).toMatchObject({ key: 'wf_chat_page', title: 'Support <desk>', initialMessages: ['Hello!', 'Ask me anything.'], responseMode: 'streaming', allowFileUploads: true, loadPreviousSession: true });
    expect(config).not.toHaveProperty('basicAuth');
  });

  it('answers at the trigger’s Path instead of the id when one is set', async () => {
    await publicChat('wf_chat_path', { path: '/help-desk/' });
    expect((await get('help-desk')).status).toBe(200);
    expect((await get('wf_chat_path/config')).status).toBe(404);
  });

  it('is 404 while unpublished, and for a chat trigger that is not public', async () => {
    await publicChat('wf_chat_draft', {}, { publish: false });
    expect((await get('wf_chat_draft')).status).toBe(404);
    expect((await post('wf_chat_draft', { sessionId: 's', message: 'hi' })).status).toBe(404);

    await publicChat('wf_chat_private', { public: false });
    expect((await get('wf_chat_private/config')).status).toBe(404);
  });
});

describe('Allowed Origins (CORS)', () => {
  it('lets listed sites embed the widget and turns others away', async () => {
    await publicChat('wf_chat_cors', { allowedOrigins: 'https://shop.example, https://docs.example/' });
    const preflight = await options('wf_chat_cors', 'https://shop.example');
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://shop.example');
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
    expect(preflight.headers.get('vary')).toBe('Origin');

    const denied = await options('wf_chat_cors', 'https://evil.example');
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    expect((await post('wf_chat_cors', { sessionId: 's1', message: 'hi' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await get('wf_chat_cors/config', { origin: 'https://evil.example' })).status).toBe(403);

    const allowed = await post('wf_chat_cors', { sessionId: 's1', message: 'hi' }, { origin: 'https://docs.example', accept: 'application/x-ndjson' });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://docs.example');
    await allowed.text();

    // The hosted page itself (same origin) needs no listing.
    const same = await get('wf_chat_cors/config', { origin: 'http://chat.test' });
    expect(same.status).toBe(200);
  });

  it('allows every site with *', async () => {
    await publicChat('wf_chat_star', { allowedOrigins: '*' });
    const preflight = await options('wf_chat_star', 'https://anywhere.example');
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('matches origins exactly, without trailing slashes or case', () => {
    expect(originAllowed({ allowedOrigins: ['https://a.example'] }, 'https://A.example/')).toBe(true);
    expect(originAllowed({ allowedOrigins: ['https://a.example'] }, 'https://a.example.evil.com')).toBe(false);
    expect(originAllowed({ allowedOrigins: ['https://a.example'] }, 'http://a.example')).toBe(false);
    expect(originAllowed({ allowedOrigins: ['https://a.example'] }, null)).toBe(true);
  });
});

describe('Basic Auth', () => {
  it('asks for the trigger’s user and password on the page and the API', async () => {
    await publicChat('wf_chat_auth', { authentication: 'basicAuth', basicAuthUser: 'team', basicAuthPassword: 's3cret' });
    const challenge = await get('wf_chat_auth');
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('www-authenticate')).toContain('Basic');
    expect((await get('wf_chat_auth', { authorization: basic('team', 'wrong') })).status).toBe(401);
    expect((await get('wf_chat_auth', { authorization: basic('team', 's3cret') })).status).toBe(200);
    expect((await post('wf_chat_auth', { sessionId: 's', message: 'hi' })).status).toBe(401);
    const ok = await post('wf_chat_auth', { sessionId: 's', message: 'hi' }, { authorization: basic('team', 's3cret'), accept: 'text/event-stream' });
    expect(ok.status).toBe(200);
    await ok.text();
  });
});

describe('messages', () => {
  it('streams the reply as SSE and ends with done (output, sessionId, executionId)', async () => {
    await publicChat('wf_chat_sse');
    const response = await post('wf_chat_sse', { sessionId: 'visitor-1', message: 'Hello from the page' }, { accept: 'text/event-stream' });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const events = (await readSse(response)).map((e) => e.data);
    const text = events.filter((e) => e.type === 'item').map((e) => e.content).join('');
    expect(text).toBe('Echo: Hello from the page');
    const done = events.at(-1);
    expect(done).toMatchObject({ type: 'done', status: 'success', sessionId: 'visitor-1', output: 'Echo: Hello from the page' });
    // A production run: counted like a webhook.
    expect(store.getExecution(done.executionId)?.mode).toBe('webhook');
  });

  it('answers JSON with the last node’s output in “When Last Node Finishes” mode', async () => {
    await publicChat('wf_chat_json', { responseMode: 'lastNode' });
    const response = await post('wf_chat_json', { sessionId: 'v2', message: 'plain please' });
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({ output: 'Echo: plain please', sessionId: 'v2', status: 'success' });
  });

  it('keeps the transcript for “Load Previous Session”', async () => {
    await publicChat('wf_chat_history', { responseMode: 'lastNode' });
    await post('wf_chat_history', { sessionId: 'return-visitor', message: 'first' });
    await post('wf_chat_history', { sessionId: 'return-visitor', message: 'second' });
    const history = await (await get('wf_chat_history/session?sessionId=return-visitor')).json();
    expect(history.messages.map((m: { role: string; text: string }) => [m.role, m.text])).toEqual([
      ['user', 'first'],
      ['assistant', 'Echo: first'],
      ['user', 'second'],
      ['assistant', 'Echo: second'],
    ]);
    // Another session sees nothing; a bad id is refused quietly.
    expect((await (await get('wf_chat_history/session?sessionId=someone-else')).json()).messages).toEqual([]);
    expect((await (await get('wf_chat_history/session?sessionId=../../etc')).json()).messages).toEqual([]);

    await publicChat('wf_chat_nohistory', { responseMode: 'lastNode', loadPreviousSession: false });
    await post('wf_chat_nohistory', { sessionId: 'v', message: 'not kept' });
    expect((await (await get('wf_chat_nohistory/session?sessionId=v')).json()).messages).toEqual([]);
  });

  it('refuses bad requests', async () => {
    await publicChat('wf_chat_bad', { responseMode: 'lastNode' });
    expect((await post('wf_chat_bad', { sessionId: 'has spaces', message: 'x' })).status).toBe(400);
    expect((await post('wf_chat_bad', { sessionId: 'ok', message: '   ' })).status).toBe(400);
    expect((await post('wf_chat_bad', { sessionId: 'ok', message: 'x'.repeat(32_001) })).status).toBe(413);
  });
});

describe('file uploads', () => {
  // A 1×1 PNG.
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const upload = (path: string, files: File[], message = 'What is in this picture?') => {
    const form = new FormData();
    form.set('sessionId', 'uploader');
    form.set('message', message);
    for (const file of files) form.append('files', file);
    return chatRoute.POST(new Request(`http://chat.test/chat/${path}`, { method: 'POST', body: form }), ctx(path));
  };

  it('sends uploaded images to the model when the Agent includes binary input', async () => {
    await publicChat('wf_chat_files', { responseMode: 'lastNode', allowFileUploads: true, allowedFilesMimeTypes: 'image/*' }, { agent: { options: { passthroughBinaryImages: true } } });
    const response = await upload('wf_chat_files', [new File([PNG], 'pixel.png', { type: 'image/png' })]);
    expect(response.status).toBe(200);
    const sent = fake.last('/v1/chat/completions')!.body;
    const userMessage = sent.messages.findLast((m: { role: string }) => m.role === 'user');
    // Files first, then the question.
    expect(userMessage.content).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } },
      { type: 'text', text: 'What is in this picture?' },
    ]);
    const history = await (await get('wf_chat_files/session?sessionId=uploader')).json();
    expect(history.messages[0]).toMatchObject({ role: 'user', files: [{ fileName: 'pixel.png', mimeType: 'image/png' }] });
  });

  it('refuses files when uploads are off, and types the trigger doesn’t allow', async () => {
    await publicChat('wf_chat_nofiles', { responseMode: 'lastNode' });
    expect((await upload('wf_chat_nofiles', [new File([PNG], 'pixel.png', { type: 'image/png' })])).status).toBe(400);
    await publicChat('wf_chat_types', { responseMode: 'lastNode', allowFileUploads: true, allowedFilesMimeTypes: 'image/*' });
    expect((await upload('wf_chat_types', [new File(['hello'], 'notes.txt', { type: 'text/plain' })])).status).toBe(415);
  });

  it('matches MIME types with wildcards', () => {
    expect(mimeAllowed('image/*,application/pdf', 'image/webp')).toBe(true);
    expect(mimeAllowed('image/*,application/pdf', 'application/pdf')).toBe(true);
    expect(mimeAllowed('image/*,application/pdf', 'text/html')).toBe(false);
    expect(mimeAllowed('*', 'text/html')).toBe(true);
  });
});
