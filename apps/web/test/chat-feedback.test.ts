/**
 * Hosted chat extras: Basic Auth from the widget (sign-in form, Authorization header over CORS), thumbs up/down feedback
 * (hosted route, execution and agent session APIs, online evaluations) and the trigger's sanitized Custom CSS.
 * The widget script runs in a node:vm context with a tiny DOM and a fetch that goes through the real route handlers
 * (with a CORS check on cross-origin calls).
 */
import { mkdtempSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import { startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-chat-feedback-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://chat.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { publishDraft } = await import('@/lib/server/publish');
const { sanitizeCustomCss, MAX_CUSTOM_CSS } = await import('@/lib/server/chat');
const { executionFeedback, listWorkflowFeedback, setFeedback } = await import('@/lib/server/chat-feedback');
const online = await import('@/lib/server/evaluations/online');
const evalStore = await import('@/lib/server/evaluations/store');
const { agentStore } = await import('@/lib/server/agents/store');
const chatRoute = await import('@/app/chat/[...path]/route');
const executionRoute = await import('@/app/api/executions/[id]/route');
const feedbackRoute = await import('@/app/api/executions/[id]/feedback/route');
const workflowFeedbackRoute = await import('@/app/api/workflows/[id]/chat-feedback/route');
const agentFeedbackRoute = await import('@/app/api/agents/[id]/sessions/[sid]/feedback/route');
const agentSessionRoute = await import('@/app/api/agents/[id]/sessions/[sid]/route');

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

async function publicChat(id: string, chat: Record<string, unknown> = {}): Promise<Workflow> {
  const workflow: Workflow = {
    id,
    name: `Chat ${id}`,
    nodes: [
      node('Chat', 'core.chatTrigger', { public: true, responseMode: 'lastNode', ...chat }),
      node('Agent', 'core.aiAgent', { prompt: '{{ $json.chatInput }}' }),
      node('Model', 'core.openAiChatModel', { model: 'gpt-test' }, { credentials: { openAiApi: { id: openAi.id, name: openAi.name } } }),
    ],
    connections: [edge('Chat', 'Agent'), edge('Model', 'Agent', 'ai_languageModel')],
  };
  store.saveWorkflow(workflow);
  await publishDraft(id, 'tester', 'chat');
  return workflow;
}

const ctx = (path: string) => ({ params: Promise.resolve({ path: path.split('?')[0].split('/').filter(Boolean) }) });
const get = (path: string, headers: Record<string, string> = {}) => chatRoute.GET(new Request(`http://chat.test/chat/${path}`, { headers }), ctx(path));
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  chatRoute.POST(new Request(`http://chat.test/chat/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), ctx(path));
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const rate = (key: string, body: unknown, headers: Record<string, string> = {}) => post(`${key}/feedback`, body, headers);
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

/** One answered message: its execution id. */
async function ask(key: string, sessionId: string, message: string, headers: Record<string, string> = {}): Promise<string> {
  const response = await post(key, { sessionId, message }, headers);
  expect(response.status).toBe(200);
  return ((await response.json()) as { executionId: string }).executionId;
}

describe('Custom CSS', () => {
  it('keeps ordinary rules and inline images', () => {
    const css = '.lf { --accent: #0ea5e9; }\n.msg.bot { border-radius: 4px; background-image: url("data:image/png;base64,iVBORw0KGgo="); }';
    expect(sanitizeCustomCss(css)).toBe(css);
  });

  it('removes @import, external url(), image-set, script hooks and comments', () => {
    const out = sanitizeCustomCss(
      [
        '@import url("https://evil.example/x.css");',
        "@import 'https://evil.example/y.css';",
        '.a { background: url(https://evil.example/pixel.gif); }',
        ".b { background: url('//evil.example/p.png') }",
        '.c { background-image: image-set("https://evil.example/p.png" 1x); }',
        '.d { width: expression(alert(1)); behavior: url(x.htc); -moz-binding: url(x.xml#y); }',
        '.e { background: url(javascript:alert(1)); }',
        '.f { background: url(data:image/svg+xml;base64,PHN2Zz4=); }',
        '/* @import "x"; */ .g { color: red; }',
        '</style><script>alert(1)</script>',
      ].join('\n'),
    );
    expect(out).not.toMatch(/@import|evil\.example|image-set|expression|behavior|moz-binding|javascript:|[<>]|\/\*/i);
    expect(out).not.toMatch(/url\((?!"data:image\/(png|jpe?g|gif|webp|avif);base64)/i);
    expect(out).toContain('.g { color: red; }');
  });

  it('sees through CSS escapes and comment tricks', () => {
    const out = sanitizeCustomCss('.a { background: u\\72 l(https://evil.example/x); }\n@\\69mport "https://evil.example/a.css";\n.b { background: ur/**/l(https://evil.example/y) }\n.c { background: \\75rl(//evil.example/z); }');
    expect(out).not.toMatch(/@import/i);
    // `ur/**/l(` is not url( (a comment splits the tokens), and nothing else is left to fetch.
    expect(out).not.toMatch(/\burl\(/i);
    expect(out.match(/evil\.example/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it('caps the size', () => {
    expect(sanitizeCustomCss('a{color:red}'.repeat(5_000)).length).toBeLessThanOrEqual(MAX_CUSTOM_CSS);
  });

  it('is served sanitized in the config, and the hosted page has a CSP', async () => {
    await publicChat('wf_css', { customCss: '@import url(https://evil.example/x.css); .lf { --accent: #123456; }' });
    const config = await (await get('wf_css/config')).json();
    expect(config.customCss).toBe('.lf { --accent: #123456; }');
    const page = await get('wf_css');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
  });
});

describe('Basic Auth over CORS', () => {
  it('answers a sign-in-able 401 (JSON, CORS headers, no browser prompt) and accepts the Authorization header', async () => {
    await publicChat('wf_auth_cors', { authentication: 'basicAuth', basicAuthUser: 'team', basicAuthPassword: 's3cret', allowedOrigins: 'https://shop.example', title: 'Members', customCss: '.lf { --accent: red; }' });
    const origin = { origin: 'https://shop.example' };
    const denied = await get('wf_auth_cors/config', origin);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toBeNull();
    expect(denied.headers.get('access-control-allow-origin')).toBe('https://shop.example');
    expect(await denied.json()).toMatchObject({ authRequired: true, title: 'Members', customCss: '.lf { --accent: red; }' });

    const preflight = await chatRoute.OPTIONS(new Request('http://chat.test/chat/wf_auth_cors', { method: 'OPTIONS', headers: { ...origin, 'access-control-request-headers': 'authorization' } }), ctx('wf_auth_cors'));
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization');

    const ok = await get('wf_auth_cors/config', { ...origin, authorization: basic('team', 's3cret') });
    expect(ok.status).toBe(200);
    expect((await get('wf_auth_cors/config', { ...origin, authorization: basic('team', 'nope') })).status).toBe(401);
    expect((await post('wf_auth_cors', { sessionId: 's', message: 'hi' }, origin)).status).toBe(401);
    expect((await rate('wf_auth_cors', { sessionId: 's', executionId: 'x', rating: 'up' }, origin)).status).toBe(401);
  });
});

describe('feedback on the hosted route', () => {
  it('rates, changes, comments on and takes back an answer, and shows it in the transcript and the execution', async () => {
    await publicChat('wf_fb');
    const executionId = await ask('wf_fb', 'visitor', 'hello');

    const up = await rate('wf_fb', { sessionId: 'visitor', executionId, rating: 'up' });
    expect(up.status).toBe(200);
    expect(executionFeedback(executionId)).toMatchObject({ rating: 'up', workflowId: 'wf_fb', sessionId: 'visitor', source: 'chat' });

    const down = await rate('wf_fb', { sessionId: 'visitor', executionId, rating: 'down', comment: '  Missed the point  ' });
    expect(((await down.json()) as { feedback: { rating: string; comment: string } }).feedback).toMatchObject({ rating: 'down', comment: 'Missed the point' });
    expect(listWorkflowFeedback('wf_fb')).toHaveLength(1);

    const history = await (await get('wf_fb/session?sessionId=visitor')).json();
    expect(history.messages.at(-1)).toMatchObject({ role: 'assistant', executionId, feedback: { rating: 'down', comment: 'Missed the point' } });

    const detail = await (await executionRoute.GET(new Request(`http://chat.test/api/executions/${executionId}`), idCtx(executionId))).json();
    expect(detail.execution.chatFeedback).toMatchObject({ rating: 'down', comment: 'Missed the point' });

    const list = await (await workflowFeedbackRoute.GET(new Request('http://chat.test/api/workflows/wf_fb/chat-feedback?rating=down'), idCtx('wf_fb'))).json();
    expect(list).toMatchObject({ up: 0, down: 1 });
    expect(list.feedback).toHaveLength(1);

    await rate('wf_fb', { sessionId: 'visitor', executionId, rating: null });
    expect(executionFeedback(executionId)).toBeUndefined();
    const after = await (await get('wf_fb/session?sessionId=visitor')).json();
    expect(after.messages.at(-1).feedback).toBeUndefined();
  });

  it('refuses ratings for other sessions, other chats, unknown answers and bad bodies', async () => {
    await publicChat('wf_fb_a');
    await publicChat('wf_fb_b');
    const executionId = await ask('wf_fb_a', 'mine', 'hi');
    expect((await rate('wf_fb_a', { sessionId: 'someone-else', executionId, rating: 'up' })).status).toBe(403);
    expect((await rate('wf_fb_b', { sessionId: 'mine', executionId, rating: 'up' })).status).toBe(404);
    expect((await rate('wf_fb_a', { sessionId: 'mine', executionId: 'ex_nope', rating: 'up' })).status).toBe(404);
    expect((await rate('wf_fb_a', { sessionId: 'mine', executionId, rating: 'meh' })).status).toBe(400);
    expect((await rate('wf_fb_a', { sessionId: 'bad id', executionId, rating: 'up' })).status).toBe(400);
    expect((await rate('wf_fb_a', { sessionId: 'mine', executionId: '../x', rating: 'up' })).status).toBe(400);
    expect(executionFeedback(executionId)).toBeUndefined();
    // A long comment is cut.
    await rate('wf_fb_a', { sessionId: 'mine', executionId, rating: 'down', comment: 'x'.repeat(5_000) });
    expect(executionFeedback(executionId)?.comment?.length).toBe(2_000);
  });

  it('can be set and read through the execution API', async () => {
    await publicChat('wf_fb_api');
    const executionId = await ask('wf_fb_api', 's1', 'hi');
    const put = (body: unknown) => feedbackRoute.PUT(new Request('http://chat.test/api/executions/x/feedback', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), idCtx(executionId));
    expect((await put({ rating: 'down', comment: 'wrong' })).status).toBe(200);
    expect(((await (await feedbackRoute.GET(new Request('http://chat.test/x'), idCtx(executionId))).json()) as { feedback: { rating: string; source: string } }).feedback).toMatchObject({ rating: 'down', source: 'api' });
    expect((await put({ rating: 'sideways' })).status).toBe(400);
    expect((await put({ rating: null })).status).toBe(200);
    expect(executionFeedback(executionId)).toBeUndefined();
    expect((await feedbackRoute.GET(new Request('http://chat.test/x'), idCtx('ex_missing'))).status).toBe(404);
  });

  it('is deleted with its execution', async () => {
    await publicChat('wf_fb_del');
    const executionId = await ask('wf_fb_del', 's1', 'bye');
    await rate('wf_fb_del', { sessionId: 's1', executionId, rating: 'up' });
    store.deleteExecution(executionId);
    expect(executionFeedback(executionId)).toBeUndefined();
  });
});

describe('feedback on agent sessions', () => {
  it('rates replies of a session through the API and goes with the session', async () => {
    const agent = agentStore.create({ name: 'Rated', model: { provider: 'ollama', model: 'm' } });
    const now = new Date().toISOString();
    const session = agentStore.saveSession({
      id: 'sess_rated',
      agentId: agent.id,
      agentName: agent.name,
      source: 'test',
      userId: 'you',
      title: 't',
      status: 'idle',
      version: 'draft',
      messages: [],
      timeline: [
        { id: 'u1', type: 'user', text: 'hi', at: now },
        { id: 'a1', type: 'assistant', text: 'hello', at: now },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      traceIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const ctxOf = { params: Promise.resolve({ id: agent.id, sid: session.id }) };
    const put = (body: unknown) => agentFeedbackRoute.PUT(new Request('http://chat.test/x', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), ctxOf);
    expect((await put({ entryId: 'u1', rating: 'up' })).status).toBe(404);
    expect((await put({ entryId: 'a1', rating: 'down', comment: 'too short' })).status).toBe(200);
    const read = await (await agentSessionRoute.GET(new Request('http://chat.test/x'), ctxOf)).json();
    expect(read.feedback).toEqual([expect.objectContaining({ kind: 'agent', entryId: 'a1', rating: 'down', comment: 'too short' })]);
    expect((await put({ entryId: 'a1', rating: null })).status).toBe(200);
    expect(((await (await agentFeedbackRoute.GET(new Request('http://chat.test/x'), ctxOf)).json()) as { feedback: unknown[] }).feedback).toEqual([]);
  });
});

describe('online evaluations', () => {
  const judgeModel = (prompts: string[]) => ({
    provider: 'test',
    model: 'judge',
    async generate(input: { messages: Array<{ content: unknown }> }) {
      prompts.push(String(input.messages[0].content));
      return { text: JSON.stringify({ reasoning: 'fine', score: 4 }), toolCalls: [], stopReason: 'stop' as const };
    },
  });

  it('shows the person’s rating to the judge and keeps it with the score', async () => {
    await publicChat('wf_fb_eval');
    const executionId = await ask('wf_fb_eval', 's1', 'grade me');
    await rate('wf_fb_eval', { sessionId: 's1', executionId, rating: 'down', comment: 'not helpful' });
    const prompts: string[] = [];
    const score = await online.gradeNodeExecution(store.getExecution(executionId)!, 'Agent', { model: judgeModel(prompts) as never });
    expect(score?.userFeedback).toEqual({ rating: 'down', comment: 'not helpful' });
    expect(prompts[0]).toContain('thumbs down: "not helpful"');
    expect(evalStore.listScores(online.nodeTarget('wf_fb_eval', 'Agent'))[0].userFeedback?.rating).toBe('down');

    const quiet = await ask('wf_fb_eval', 's2', 'no rating');
    const unrated = await online.gradeNodeExecution(store.getExecution(quiet)!, 'Agent', { model: judgeModel([]) as never });
    expect(unrated?.userFeedback).toBeUndefined();
  });

  it('grades a reply rated down when grading is on for its node, once', async () => {
    await publicChat('wf_fb_bad');
    const target = online.nodeTarget('wf_fb_bad', 'Agent');
    const disabled = await ask('wf_fb_bad', 's1', 'one');
    expect(online.onBadFeedback(setFeedback({ kind: 'execution', workflowId: 'wf_fb_bad', executionId: disabled, sessionId: 's1' }, 'down')!)).toBeUndefined();
    evalStore.saveOnlineConfig(target, { enabled: true, sampleRate: 0, rubric: 'Be helpful', lowScore: 2, model: { provider: 'ollama', model: 'unreachable', baseUrl: 'http://127.0.0.1:9' } });
    const next = await ask('wf_fb_bad', 's1', 'two');
    const job = online.onBadFeedback(setFeedback({ kind: 'execution', workflowId: 'wf_fb_bad', executionId: next, sessionId: 's1' }, 'down')!);
    expect(job).toBeDefined();
    await online.gradingIdle();
    // A thumbs up is never graded.
    expect(online.onBadFeedback(setFeedback({ kind: 'execution', workflowId: 'wf_fb_bad', executionId: next, sessionId: 's1' }, 'up')!)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The widget script, in a tiny DOM
// ---------------------------------------------------------------------------

class Node_ {
  children: Node_[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(event: unknown) => void>> = {};
  parent?: Node_;
  shadow?: Node_;
  hidden = false;
  value = '';
  files: unknown[] = [];
  private text = '';
  private html = '';
  constructor(public tag: string) {}
  get className() { return this.attrs.class ?? ''; }
  set className(value: string) { this.attrs.class = value; }
  get textContent(): string { return this.text + this.html + this.children.map((c) => c.textContent).join(' '); }
  set textContent(value: string) { this.text = String(value); this.html = ''; this.children = []; }
  get innerHTML() { return this.html; }
  set innerHTML(value: string) { this.html = String(value); this.text = ''; this.children = []; }
  get style() { return {}; }
  setAttribute(name: string, value: string) { this.attrs[name] = String(value); }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  appendChild(child: Node_) { child.parent = this; this.children.push(child); return child; }
  addEventListener(type: string, fn: (event: unknown) => void) { (this.listeners[type] ??= []).push(fn); }
  attachShadow() { return (this.shadow = new Node_('#shadow')); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  focus() {}
  fire(type: string) { for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {}, key: '' }); }
  all(): Node_[] { return [this, ...(this.shadow?.all() ?? []), ...this.children.flatMap((c) => c.all())]; }
  find(predicate: (n: Node_) => boolean) { return this.all().find(predicate); }
  findAll(predicate: (n: Node_) => boolean) { return this.all().filter(predicate); }
}

const settle = async (condition: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out: ${label}`);
};

/** Run /chat/widget.js for a chat on another origin; fetches go through the route handlers with a CORS check. */
async function runWidget(key: string, siteOrigin = 'https://shop.example') {
  const body = new Node_('body');
  const documentStub = {
    body,
    title: '',
    currentScript: { src: 'http://chat.test/chat/widget.js', getAttribute: (name: string) => (name === 'data-workflow' ? key : name === 'data-open' ? 'true' : null) },
    createElement: (tag: string) => new Node_(tag),
    getElementById: () => null,
  };
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  const storage = (map: Map<string, string>) => ({ getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) });
  const calls: Array<{ method: string; url: string; authorization?: string }> = [];
  const fetchStub = async (url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const method = options.method ?? 'GET';
    const headers = { ...(options.headers ?? {}), origin: siteOrigin };
    calls.push({ method, url, authorization: headers.authorization });
    const path = new URL(url).pathname.replace(/^\/chat\//, '');
    // A browser preflights cross-origin calls that carry Authorization or a JSON content type.
    const unsafe = Object.keys(options.headers ?? {}).filter((h) => ['authorization', 'content-type'].includes(h.toLowerCase()) && !(h.toLowerCase() === 'content-type' && options.headers![h] === 'text/plain'));
    if (unsafe.length) {
      const pre = await chatRoute.OPTIONS(new Request(url, { method: 'OPTIONS', headers: { origin: siteOrigin, 'access-control-request-method': method, 'access-control-request-headers': unsafe.join(',') } }), ctx(path));
      const allowed = (pre.headers.get('access-control-allow-headers') ?? '').toLowerCase();
      if (pre.status !== 204 || unsafe.some((h) => !allowed.includes(h.toLowerCase()))) throw new TypeError('CORS preflight failed');
    }
    const response = await (method === 'POST'
      ? chatRoute.POST(new Request(url, { method, headers, body: options.body }), ctx(path))
      : chatRoute.GET(new Request(url, { method, headers }), ctx(path)));
    if (!response.headers.get('access-control-allow-origin')) throw new TypeError('CORS: no allow-origin');
    return response;
  };
  const sandbox = { document: documentStub, location: { href: 'https://shop.example/page' }, localStorage: storage(local), sessionStorage: storage(session), crypto: webcrypto, fetch: fetchStub, URL, FormData, TextDecoder, btoa, unescape, encodeURIComponent, setTimeout, console };
  const source = await (await get('widget.js')).text();
  vm.runInNewContext(source, sandbox);
  const host = body.children[0];
  return { host, root: host.shadow!, calls, local, session, body };
}

describe('the widget script', () => {
  it('signs in to a chat with Basic Auth, sends the header over CORS and keeps it for the page session only', async () => {
    await publicChat('wf_w_auth', { authentication: 'basicAuth', basicAuthUser: 'tea', basicAuthPassword: 'pw: with colon', allowedOrigins: 'https://shop.example', customCss: '.toggle { background: rgb(1, 2, 3); } @import url(https://evil.example/x.css);' });
    const widget = await runWidget('wf_w_auth');
    await settle(() => !!widget.root.find((n) => n.className === 'signin'), 'sign-in form');
    // The theme CSS of a chat that asks for a sign-in is already applied.
    const style = () => widget.root.findAll((n) => n.tag === 'style').map((n) => n.textContent).join('\n');
    expect(style()).toContain('rgb(1, 2, 3)');
    expect(style()).not.toContain('evil.example');
    expect(widget.calls.every((c) => !c.authorization)).toBe(true);

    const form = widget.root.find((n) => n.className === 'signin')!;
    const [user, pass] = form.findAll((n) => n.tag === 'input');
    user.value = 'tea';
    pass.value = 'wrong';
    form.fire('submit');
    await settle(() => form.find((n) => n.className === 'err')!.textContent.includes('Wrong user or password'), 'wrong password message');
    expect(widget.session.size).toBe(0);

    pass.value = 'pw: with colon';
    form.fire('submit');
    await settle(() => !!widget.root.find((n) => n.tag === 'textarea'), 'chat after sign-in');
    const sent = widget.calls.filter((c) => c.authorization).at(-1)!;
    expect(sent.authorization).toBe(basic('tea', 'pw: with colon'));
    // Page session only: sessionStorage, never localStorage.
    expect([...widget.session.values()]).toEqual([basic('tea', 'pw: with colon')]);
    expect([...widget.local.values()].some((v) => v.startsWith('Basic'))).toBe(false);

    // A message goes out with the header, and the answer gets thumbs.
    const input = widget.root.find((n) => n.tag === 'textarea')!;
    input.value = 'hello widget';
    widget.root.find((n) => n.tag === 'form' && n.className !== 'signin')!.fire('submit');
    await settle(() => widget.root.textContent.includes('Echo: hello widget'), 'the answer');
    const post = widget.calls.find((c) => c.method === 'POST' && !c.url.endsWith('/feedback'))!;
    expect(post.authorization).toBe(basic('tea', 'pw: with colon'));
    await settle(() => widget.root.findAll((n) => n.className === 'fb').length > 0, 'feedback buttons');
  });

  it('rates an answer from the widget: thumbs up, then a thumbs down with a comment, then takes it back', async () => {
    await publicChat('wf_w_fb', { allowedOrigins: '*' });
    const widget = await runWidget('wf_w_fb');
    await settle(() => !!widget.root.find((n) => n.tag === 'textarea'), 'the chat');
    widget.root.find((n) => n.tag === 'textarea')!.value = 'rate me';
    widget.root.find((n) => n.tag === 'form')!.fire('submit');
    await settle(() => widget.root.findAll((n) => n.className === 'fb').length === 1, 'feedback row');
    const row = widget.root.find((n) => n.className === 'fb')!;
    const [up, down] = row.findAll((n) => n.tag === 'button' && n.className.startsWith('thumb')).slice(0, 2);
    const ratingOf = () => listWorkflowFeedback('wf_w_fb')[0]?.rating;

    up.fire('click');
    await settle(() => ratingOf() === 'up', 'thumbs up stored');
    down.fire('click');
    await settle(() => ratingOf() === 'down', 'thumbs down stored');
    const field = row.find((n) => n.tag === 'input')!;
    field.value = 'Not what I asked';
    row.findAll((n) => n.tag === 'button').find((n) => n.textContent === 'Send')!.fire('click');
    await settle(() => listWorkflowFeedback('wf_w_fb')[0]?.comment === 'Not what I asked', 'comment stored');
    expect(listWorkflowFeedback('wf_w_fb')[0]).toMatchObject({ source: 'chat', sessionId: expect.any(String) });

    down.fire('click');
    await settle(() => listWorkflowFeedback('wf_w_fb').length === 0, 'rating taken back');
  });

  it('shows earlier answers with their rating after a reload', async () => {
    await publicChat('wf_w_hist', { allowedOrigins: '*' });
    const first = await runWidget('wf_w_hist');
    await settle(() => !!first.root.find((n) => n.tag === 'textarea'), 'the chat');
    first.root.find((n) => n.tag === 'textarea')!.value = 'remember me';
    first.root.find((n) => n.tag === 'form')!.fire('submit');
    await settle(() => first.root.findAll((n) => n.className === 'fb').length === 1, 'feedback row');
    first.root.find((n) => n.className === 'fb')!.findAll((n) => n.tag === 'button')[0].fire('click');
    await settle(() => listWorkflowFeedback('wf_w_hist')[0]?.rating === 'up', 'stored');
    // A reload keeps the session id (localStorage) and loads the transcript, with the thumb pressed.
    const sessionId = [...first.local.values()][0];
    const history = await (await get(`wf_w_hist/session?sessionId=${sessionId}`)).json();
    expect(history.messages.find((m: { role: string }) => m.role === 'assistant')).toMatchObject({ feedback: { rating: 'up' } });
  });
});
