/**
 * Chat with agents, step 3 (docs/specs/16): browser-speech voice. The Chat trigger's Voice option reaches the public config,
 * the reading rules are a pure function, the buttons are hidden where the browser lacks the API, and a Voice-off page
 * builds exactly the same controls as before.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-chat-voice-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { publishDraft } = await import('@/lib/server/publish');
const { CHAT_CLIENT_JS, spokenText } = await import('@/lib/server/chat-client');
const chatRoute = await import('@/app/chat/[...path]/route');
registry.registerBuiltin(corePlugin);

const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });

async function chat(id: string, parameters: Record<string, unknown> = {}): Promise<void> {
  const workflow: Workflow = { id, name: id, nodes: [node('Chat', 'core.chatTrigger', { public: true, ...parameters }), node('Set', 'core.set')], connections: [{ id: 'a', type: 'main', source: 'Chat', target: 'Set', sourceIndex: 0, targetIndex: 0 }] };
  store.saveWorkflow(workflow);
  await publishDraft(id, 'tester', 'chat');
}
const config = async (id: string) => (await chatRoute.GET(new Request(`http://chat.test/chat/${id}/config`), { params: Promise.resolve({ path: [id, 'config'] }) })).json() as Promise<Record<string, unknown>>;

describe('Voice in the public config', () => {
  it('is off by default and carries no language or send flag', async () => {
    await chat('wf_voice_default');
    const c = await config('wf_voice_default');
    expect(c.voice).toBe('off');
    expect(c).not.toHaveProperty('voiceLang');
    expect(c).not.toHaveProperty('voiceSend');
  });
  it('carries the option, the language and the send flag', async () => {
    await chat('wf_voice_inout', { voice: 'inout', voiceLang: ' sv-SE ', voiceSend: false });
    expect(await config('wf_voice_inout')).toMatchObject({ voice: 'inout', voiceLang: 'sv-SE', voiceSend: false });
    await chat('wf_voice_in', { voice: 'in' });
    expect(await config('wf_voice_in')).toMatchObject({ voice: 'in', voiceSend: true });
    await chat('wf_voice_bad', { voice: 'loud' });
    expect((await config('wf_voice_bad')).voice).toBe('off');
  });
  it('the trigger says in one line what Chrome does with the audio', () => {
    const chatTrigger = registry.nodeTypes().find((n) => n.type === 'core.chatTrigger');
    const property = chatTrigger?.descriptor.properties.find((p) => p.name === 'voice');
    expect(property?.description).toMatch(/Chrome.*browser vendor.*never stores audio/);
  });
});

describe('what is spoken', () => {
  it('drops code blocks, inline code, addresses and Markdown marks', () => {
    const text = 'Here is **the answer**.\n\n```js\nconst x = 1;\n```\n\nUse `npm i` then see [the docs](https://example.com/docs) or https://example.com/x.\n- first\n- second';
    const out = spokenText(text);
    expect(out).toBe('Here is the answer.\nUse then see the docs or\nfirst\nsecond');
    expect(out).not.toMatch(/const|npm|http|\*|`/);
  });
  it('drops an unfinished code block and tilde fences', () => {
    expect(spokenText('Before\n```py\nprint(1)')).toBe('Before');
    expect(spokenText('A\n~~~\nx\n~~~\nB')).toBe('A\nB');
  });
  it('never reads "asked X" lines or the agent label', () => {
    expect(spokenText('asked Billing: check the invoice\nYour invoice is paid.')).toBe('Your invoice is paid.');
    expect(spokenText('**Billing:** Your invoice is paid.', 'Billing')).toBe('Your invoice is paid.');
    expect(spokenText('Billing (EU): fine', 'Billing (EU)')).toBe('fine');
  });
  it('is empty for nothing worth saying', () => {
    expect(spokenText('')).toBe('');
    expect(spokenText(undefined)).toBe('');
    expect(spokenText('```\ncode only\n```')).toBe('');
  });
});

// A just-enough DOM to evaluate the client script.
class El {
  children: El[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  textContent = '';
  innerHTML = '';
  value = '';
  hidden = false;
  className = '';
  scrollTop = 0;
  scrollHeight = 0;
  shadowRoot: El | null = null;
  constructor(public tagName: string) {}
  get classList() {
    const self = this;
    return { add(c: string) { self.className = `${self.className} ${c}`.trim(); }, remove(c: string) { self.className = self.className.split(' ').filter((x) => x !== c).join(' '); } };
  }
  setAttribute(k: string, v: string) { this.attrs[k] = v; if (k === 'class') this.className = v; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  appendChild(c: El) { this.children.push(c); return c; }
  addEventListener(t: string, f: (e: unknown) => void) { (this.listeners[t] ||= []).push(f); }
  fire(t: string, e: Record<string, unknown> = {}) { (this.listeners[t] || []).forEach((f) => f({ preventDefault() {}, pointerId: 1, ...e })); }
  attachShadow() { this.shadowRoot = new El('shadow'); return this.shadowRoot; }
  remove() {}
  focus() {}
  click() { this.fire('click'); }
  all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  classes(): string[] { return this.className.split(' ').filter(Boolean); }
}

interface Page { root: El; buttons: string[]; spoken: string[]; cancelled: number; sent: unknown[]; recs: Array<Record<string, unknown>>; input: El }

/** Run the script against `cfg`, with `win` as the browser's speech APIs. */
async function load(cfg: Record<string, unknown>, win: Record<string, unknown>, opts: { store?: Record<string, string>; stream?: string[]; heard?: number[] } = {}): Promise<Page> {
  const body = new El('body');
  const spoken: string[] = [];
  const sent: unknown[] = [];
  const recs: Array<Record<string, unknown>> = [];
  const state = { cancelled: 0 };
  const script = { getAttribute: (k: string) => ({ 'data-workflow': 'k', 'data-mode': 'fullscreen' } as Record<string, string>)[k] ?? null, src: 'http://chat.test/chat/widget.js' };
  const document = {
    currentScript: script,
    body,
    documentElement: { lang: '' },
    title: '',
    createElement: (t: string) => new El(t),
    getElementById: () => null,
  };
  class Recognition {
    start() { recs.push(this as unknown as Record<string, unknown>); }
    stop() { (this as unknown as { onend?: () => void }).onend?.(); }
  }
  const stubs: Record<string, unknown> = {
    window: {
      ...win,
      ...(win.SpeechRecognition === true && { SpeechRecognition: Recognition }),
      ...(win.webkitSpeechRecognition === true && { webkitSpeechRecognition: Recognition }),
      ...(win.speechSynthesis === true && { speechSynthesis: { speak: (u: { text: string }) => spoken.push(u.text), cancel: () => { state.cancelled++; } } }),
      ...(win.SpeechSynthesisUtterance === true && { SpeechSynthesisUtterance: class { constructor(public text: string) {} } }),
    },
    document,
    navigator: { language: 'en-GB' },
    location: { href: 'http://chat.test/chat/k' },
    localStorage: opts.store
      ? { getItem: (k: string) => opts.store![k] ?? null, setItem: (k: string, v: string) => { opts.store![k] = v; }, removeItem: (k: string) => { delete opts.store![k]; } }
      : { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    crypto: { randomUUID: () => 'abc' },
    fetch: (url: string, init?: { method?: string; body?: string }) => {
      if (String(url).endsWith('/config')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(cfg), headers: { get: () => 'application/json' } });
      sent.push(init?.body && JSON.parse(init.body));
      if (opts.stream) {
        const lines = [...opts.stream];
        const body = { getReader: () => ({ read: () => { opts.heard?.push(spoken.length); const next = lines.shift(); return Promise.resolve(next === undefined ? { done: true } : { done: false, value: new TextEncoder().encode(`data: ${next}\n`) }); } }) };
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body });
      }
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ output: 'Reply with `code`.\n```x\nno\n```\nDone.' }) });
    },
    URL,
    TextDecoder,
    FormData,
    btoa,
    unescape,
  };
  const names = Object.keys(stubs);
  new Function(...names, CHAT_CLIENT_JS)(...names.map((n) => stubs[n]));
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  const shadow = body.children[0].shadowRoot!;
  const all = shadow.all();
  const page: Page = { root: shadow, buttons: all.filter((e) => e.tagName === 'button').map((e) => e.classes().join('.')), spoken, cancelled: 0, sent, recs, input: all.find((e) => e.tagName === 'textarea')! };
  Object.defineProperty(page, 'cancelled', { get: () => state.cancelled });
  return page;
}

const FULL = { SpeechRecognition: true, speechSynthesis: true, SpeechSynthesisUtterance: true };
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const find = (page: Page, cls: string) => page.root.all().find((e) => e.classes().includes(cls))!;

describe('the voice buttons in the client', () => {
  it('shows a microphone and a speaker for Speech in and out when the browser has both', async () => {
    const page = await load({ voice: 'inout', responseMode: 'lastNode' }, FULL);
    expect(page.buttons).toEqual(expect.arrayContaining(['mic', 'speak']));
  });
  it('shows only the microphone for Speech in', async () => {
    const page = await load({ voice: 'in' }, FULL);
    expect(page.buttons).toContain('mic');
    expect(page.buttons).not.toContain('speak');
  });
  it('accepts webkitSpeechRecognition', async () => {
    const page = await load({ voice: 'in' }, { webkitSpeechRecognition: true });
    expect(page.buttons).toContain('mic');
  });
  it('hides what the browser cannot do (iOS Safari: speech out, no speech in)', async () => {
    const page = await load({ voice: 'inout' }, { speechSynthesis: true, SpeechSynthesisUtterance: true });
    expect(page.buttons).not.toContain('mic');
    expect(page.buttons).toContain('speak');
    const none = await load({ voice: 'inout' }, {});
    expect(none.buttons).not.toContain('mic');
    expect(none.buttons).not.toContain('speak');
  });
  it('Voice off builds the same controls as a config without the field, even in a browser with speech', async () => {
    const off = await load({ voice: 'off' }, FULL);
    const before = await load({}, FULL);
    expect(off.buttons).toEqual(before.buttons);
    expect(off.buttons).not.toContain('mic');
    expect(off.buttons).not.toContain('speak');
  });

  it('fills the input while the visitor speaks and sends on release', async () => {
    const page = await load({ voice: 'in', responseMode: 'lastNode' }, FULL);
    const mic = find(page, 'mic');
    mic.fire('pointerdown');
    expect(page.recs).toHaveLength(1);
    const rec = page.recs[0] as { lang: string; onresult: (e: unknown) => void; interimResults: boolean };
    expect(rec).toMatchObject({ interimResults: true, lang: 'en-GB' });
    rec.onresult({ results: [[{ transcript: 'hello ' }], [{ transcript: 'there' }]] });
    expect(page.input.value).toBe('hello there');
    mic.fire('pointerup');
    await settle();
    expect(page.sent).toEqual([{ sessionId: 'abc', message: 'hello there' }]);
  });
  it('leaves the words in the input when Send When the Visitor Stops is off', async () => {
    const page = await load({ voice: 'in', voiceSend: false, voiceLang: 'sv-SE' }, FULL);
    const mic = find(page, 'mic');
    mic.fire('pointerdown');
    const rec = page.recs[0] as { lang: string; onresult: (e: unknown) => void };
    expect(rec.lang).toBe('sv-SE');
    rec.onresult({ results: [[{ transcript: 'tack' }]] });
    mic.fire('pointerup');
    await settle();
    expect(page.input.value).toBe('tack');
    expect(page.sent).toEqual([]);
  });
  it('reads a finished reply without its code, only once the speaker is on, and stops on speaking and sending', async () => {
    const page = await load({ voice: 'inout', responseMode: 'lastNode' }, FULL);
    const send = async (text: string) => { page.input.value = text; page.root.all().find((e) => e.tagName === 'form')!.fire('submit'); await settle(); };
    await send('one');
    expect(page.spoken).toEqual([]);
    find(page, 'speak').click();
    const before = page.cancelled;
    await send('two');
    expect(page.cancelled).toBeGreaterThan(before);
    expect(page.spoken).toEqual(['Reply with.', 'Done.']);
    const beforeMic = page.cancelled;
    find(page, 'mic').fire('pointerdown');
    expect(page.cancelled).toBeGreaterThan(beforeMic);
  });
  it('has large tap targets on a phone', () => {
    expect(CHAT_CLIENT_JS).toMatch(/@media \(max-width: 600px\) \{ \.mic, \.speak, \.send \{ height: 48px/);
    expect(CHAT_CLIENT_JS).toContain('touch-action: none');
  });
});

describe('the speaker toggle is remembered', () => {
  it('starts on when it was left on, and saves each change', async () => {
    const store: Record<string, string> = { 'landflow-chat-speak:k': '1' };
    const page = await load({ voice: 'inout', responseMode: 'lastNode' }, FULL, { store });
    const speak = find(page, 'speak');
    expect(speak.getAttribute('aria-pressed')).toBe('true');
    speak.click();
    expect(speak.getAttribute('aria-pressed')).toBe('false');
    expect(store['landflow-chat-speak:k']).toBeUndefined();
    speak.click();
    expect(store['landflow-chat-speak:k']).toBe('1');
  });
  it('starts off by default and reads once a remembered toggle is on', async () => {
    const off = await load({ voice: 'inout' }, FULL, { store: {} });
    expect(find(off, 'speak').getAttribute('aria-pressed')).toBe('false');
    const store = { 'landflow-chat-speak:k': '1' };
    const page = await load({ voice: 'inout', responseMode: 'lastNode' }, FULL, { store });
    page.input.value = 'hi';
    page.root.all().find((e) => e.tagName === 'form')!.fire('submit');
    await settle();
    expect(page.spoken).toEqual(['Reply with.', 'Done.']);
  });
  it('works when the browser refuses storage, and the microphone still stops speech', async () => {
    const store = new Proxy({}, { get() { throw new Error('denied'); }, set() { throw new Error('denied'); } }) as Record<string, string>;
    const page = await load({ voice: 'inout' }, FULL, { store });
    const speak = find(page, 'speak');
    expect(speak.getAttribute('aria-pressed')).toBe('false');
    speak.click();
    expect(speak.getAttribute('aria-pressed')).toBe('true');
    const before = page.cancelled;
    find(page, 'mic').fire('pointerdown');
    expect(page.cancelled).toBeGreaterThan(before);
  });
});

describe('reading a reply while it streams', () => {
  const item = (content: string, agent?: { id: string; name: string }) => JSON.stringify({ type: 'item', content, ...(agent && { agent }) });
  it('reads each completed sentence as it arrives, never code, and the rest at the end', async () => {
    const heard: number[] = [];
    const lines = [item('Hello the'), item('re. Use `rm'), item(' -rf` now. Look:\n```sh\nls\n'), item('```\nBilling is'), item(' fine. Bye'), JSON.stringify({ type: 'done', status: 'success', executionId: 'e1' })];
    const page = await load({ voice: 'inout', responseMode: 'streaming' }, FULL, { store: { 'landflow-chat-speak:k': '1' }, stream: lines, heard });
    page.input.value = 'go';
    page.root.all().find((e) => e.tagName === 'form')!.fire('submit');
    await settle();
    expect(page.spoken).toEqual(['Hello there.', 'Use now.', 'Look:', 'Billing is fine.', 'Bye']);
    // Spoken before the stream ended: after the second chunk the first sentence was out already.
    expect(heard[2]).toBe(1);
    expect(heard[heard.length - 1]).toBeLessThan(page.spoken.length);
    expect(page.spoken.join(' ')).not.toMatch(/rm|ls|`/);
  });
  it('reads nothing while the speaker is off', async () => {
    const lines = [item('One. Two. '), JSON.stringify({ type: 'done', status: 'success' })];
    const page = await load({ voice: 'inout', responseMode: 'streaming' }, FULL, { store: {}, stream: lines });
    page.input.value = 'go';
    page.root.all().find((e) => e.tagName === 'form')!.fire('submit');
    await settle();
    expect(page.spoken).toEqual([]);
  });
});
