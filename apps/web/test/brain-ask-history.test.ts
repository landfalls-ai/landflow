/**
 * Ask the brain, kept and tagged (docs/second-brain.md#the-brain-page): `@` tags read as checked context and as steps
 * (a page the caller may open gives its digest and a "Read" step; one they may not gives "Couldn't read" and nothing
 * else), `about` alone still works, a kept turn holds no resolved block, and on reopen a link the reader may no longer
 * see is dropped and counted ("1 link hidden"). A fake model; no network.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from '@landflow/engine';
import type { AskEvent } from '@/lib/shared/brain-wiki';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-brain-ask-history-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth, TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const entities = await import('@/lib/server/brain/entities');
const { scopeForActor } = await import('@/lib/server/brain/scope');
const { createTeamProject, setMember } = await import('@/lib/server/projects/store');
const { askBrainStream, askMentions, askJson } = await import('@/lib/server/brain/ask-stream');
const { sanitizeItems } = await import('@/lib/server/conversations/sanitize');
const { BLOCK_OPEN } = await import('@/lib/server/mentions/resolve');
const { traceChat } = await import('@/lib/server/telemetry');
const { singleton } = await import('@/lib/server/singleton');
const askRoute = await import('@/app/api/brain/ask/route');
const panel = await import('@/components/brain/wiki/ask-panel');

const owner = await createUser({ email: 'owner@hist.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
const alice = await createUser({ email: 'alice@hist.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
const alpha = createTeamProject({ name: 'Alpha', createdBy: owner.id });
const beta = createTeamProject({ name: 'Beta', createdBy: owner.id });
setMember(alpha.id, alice.id, 'editor');
const aliceActor = { id: alice.id, role: 'member' as const };

entities.upsertEntity({ type: 'customer', id: 'acme', name: 'Acme', description: 'Billing for the Acme account', projectId: alpha.id, owner: 'Lee' });
entities.upsertEntity({ type: 'customer', id: 'globex', name: 'Globex', description: 'Secret Globex renewal plan', projectId: beta.id });

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

function fakeModel(reply = 'Acme is fine.') {
  const prompts: string[] = [];
  const model: LanguageModel & { prompts: string[] } = {
    provider: 'fake',
    model: 'ask',
    prompts,
    generate(input) {
      prompts.push(String(input.messages[0].content));
      return traceChat(
        { system: 'fake', model: 'ask' },
        async () => {
          input.onToken?.(reply);
          return { text: reply, toolCalls: [], stopReason: 'stop' as const, usage: { inputTokens: 10, outputTokens: 5 } };
        },
        () => ({ inputTokens: 10, outputTokens: 5 }),
      );
    },
  };
  return model;
}

async function stream(question: string, extra: Record<string, unknown>, model?: LanguageModel) {
  const events: AskEvent[] = [];
  await askBrainStream(aliceActor, { question, scope: scopeForActor(aliceActor), ...(model && { model }), ...extra }, (e) => events.push(e));
  return events;
}
const tools = (events: AskEvent[]) => events.filter((e): e is Extract<AskEvent, { type: 'tool' }> => e.type === 'tool');

describe('tags in the ask route', () => {
  it('a page the caller can open: its digest is in the prompt and it is a read step', async () => {
    const model = fakeModel();
    const events = await stream('How is billing going?', { mentions: [{ type: 'brainPage', id: 'customer/acme', name: 'Acme' }] }, model);
    const read = tools(events).find((e) => e.label === 'Read @Acme');
    expect(read).toMatchObject({ ok: true, name: 'read_pages' });
    expect(model.prompts[0]).toContain(BLOCK_OPEN);
    expect(model.prompts[0]).toContain('Billing for the Acme account');
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('a page the caller cannot open: "Couldn\'t read" and nothing about it', async () => {
    const model = fakeModel();
    const events = await stream('How is billing going?', { mentions: [{ type: 'brainPage', id: 'customer/globex', name: 'Globex' }] }, model);
    const refused = tools(events).find((e) => e.label === "Couldn't read @Globex");
    expect(refused).toMatchObject({ ok: false });
    expect(refused?.detail).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain('Secret Globex');
    expect(model.prompts.join('\n')).not.toContain('Secret Globex');
    expect(model.prompts.join('\n')).not.toContain(BLOCK_OPEN);
  });

  it('a missing page says the same as a forbidden one', async () => {
    const a = tools(await stream('hello there', { mentions: [{ type: 'brainPage', id: 'customer/nowhere', name: 'Globex' }] })).map((e) => [e.label, e.ok]);
    const b = tools(await stream('hello there', { mentions: [{ type: 'brainPage', id: 'customer/globex', name: 'Globex' }] })).map((e) => [e.label, e.ok]);
    expect(a).toEqual(b);
  });

  it('about alone still works: it is one page tag', async () => {
    expect(askMentions(undefined, 'customer/acme')).toEqual([{ type: 'brainPage', id: 'customer/acme' }]);
    expect(askMentions([{ type: 'brainPage', id: 'customer/acme' }], 'customer/acme')).toHaveLength(1);
    const model = fakeModel();
    const events = await stream('How is billing going?', { about: 'customer/acme', mentions: askMentions(undefined, 'customer/acme') }, model);
    expect(tools(events).some((e) => e.label === 'Read @Acme')).toBe(true);
    // Without any tag the stream is as before: found, then three steps.
    const plain = await stream('What about Acme?', { about: 'customer/acme' }, fakeModel());
    expect(plain.map((e) => e.type).slice(0, 7)).toEqual(['found', 'step.start', 'tool', 'step.start', 'tool', 'step.start', 'tool']);
  });

  it('at most 8 tags', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ type: 'brainPage' as const, id: `customer/c${i}` }));
    expect(askMentions(many, 'customer/acme')).toHaveLength(8);
  });

  it('the route takes mentions, streams the steps and refuses more than 8', async () => {
    const post = (body: unknown) => askRoute.POST(new Request('http://localhost/api/brain/ask', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body) }));
    const response = await post({ question: 'How is billing going?', mentions: { refs: [{ type: 'brainPage', id: 'customer/acme', name: 'Acme' }, { type: 'brainPage', id: 'customer/nowhere', name: 'Nowhere' }] } });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('Read @Acme');
    // The route runs as the synthetic owner, who may open everything: a page that is not there reads as refused.
    expect(text).toContain("Couldn't read @Nowhere");
    const tooMany = await post({ question: 'x', mentions: { refs: Array.from({ length: 9 }, (_, i) => ({ type: 'brainPage', id: `customer/c${i}` })) } });
    expect(tooMany.status).toBe(400);
    const json = await askRoute.POST(new Request('http://localhost/api/brain/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'How is billing going?', mentions: { refs: [{ type: 'brainPage', id: 'customer/acme', name: 'Acme' }] } }) }));
    expect((await json.json()).tags).toEqual([{ ok: true, label: 'Read @Acme' }]);
  });

  it('{ question, about } without tags keeps the JSON contract: the fact list is returned', async () => {
    const res = await askRoute.POST(new Request('http://localhost/api/brain/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Billing for Acme', about: 'customer/acme' }) }));
    const body = await res.json();
    expect(body.about).toBe('customer/acme');
    expect(body.tags).toBeUndefined();
    expect(body.facts.length + body.pages.length).toBeGreaterThan(0);
    expect(Array.isArray(body.facts)).toBe(true);
  });

  it('a brain:read key cannot tag a workflow or a credential: refused, no digest, nothing in the prompt', async () => {
    const { store } = await import('@/lib/server/store');
    store.saveWorkflow({ id: 'wf_keyed', name: 'Keyed flow', nodes: [], connections: [] } as never);
    const state = singleton<{ principal?: unknown }>('auth-test-bypass', () => ({}));
    const before = state.principal;
    state.principal = { user: { ...owner, role: 'owner' }, via: 'api-key', apiKey: { id: 'key_1', scopes: ['brain:read'] } };
    try {
      const response = await askRoute.POST(
        new Request('http://localhost/api/brain/ask', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({ question: 'What is up?', mentions: { refs: [{ type: 'workflow', id: 'wf_keyed', name: 'Keyed flow' }, { type: 'credential', id: 'cred_x', name: 'Secret cred' }, { type: 'brainPage', id: 'customer/acme', name: 'Acme' }] } }),
        }),
      );
      const text = await response.text();
      expect(text).toContain("Couldn't read @Keyed flow");
      expect(text).toContain("Couldn't read @Secret cred");
      expect(text).toContain('Read @Acme');
      expect(text).not.toMatch(/"detail":"[^"]*(Keyed flow|nodes)/);
    } finally {
      state.principal = before;
    }
    const { splitByScopes } = await import('@/lib/server/mentions/key-scopes');
    const split = splitByScopes([{ type: 'workflow' as const }, { type: 'run' as const }, { type: 'brainPage' as const }, { type: 'credential' as const }], ['brain:read', 'executions:read']);
    expect(split.allowed.map((r) => r.type)).toEqual(['run', 'brainPage']);
    expect(split.denied.map((r) => r.type)).toEqual(['workflow', 'credential']);
  });

  it('the folded JSON form carries the answer', async () => {
    const out = await askJson(aliceActor, { question: 'How is billing going?', scope: scopeForActor(aliceActor), model: fakeModel('Fine [[customer/acme|Acme]].'), mentions: [{ type: 'brainPage', id: 'customer/acme' }] });
    expect(out.answer).toContain('Fine');
    expect(out.model).toBe('fake/ask');
  });
});

describe('a change of page', () => {
  it('keeps this visit\'s turns; resumes only when the panel holds none of this visit', () => {
    expect(panel.subjectChange([])).toBe('resume');
    expect(panel.subjectChange([{ earlier: true }, { earlier: true }])).toBe('resume');
    expect(panel.subjectChange([{ earlier: true }, {}])).toBe('keep');
    expect(panel.subjectChange([{}])).toBe('keep');
  });
});

describe('a kept turn', () => {
  const finished = (extra = {}) => ({ ...panel.applyAskEvent({ id: 'a', question: 'How is Acme?', steps: [], streamed: '', links: [], sources: [], cited: [], status: 'working' as const, ...extra }, { type: 'text', text: 'Acme is fine, see [[customer/acme|Acme]] and [[customer/globex|Globex]] [1].' }) });

  it('keeps words, tags (names only), links and sources, never the block', async () => {
    const model = fakeModel();
    const events = await stream('How is billing going?', { mentions: [{ type: 'brainPage', id: 'customer/acme', name: 'Acme' }] }, model);
    let item = { id: 'a', question: 'How is billing going?', mentions: [{ type: 'brainPage', id: 'customer/acme', name: 'Acme' }], steps: [], streamed: '', links: [], sources: [], cited: [], status: 'working' as const } as ReturnType<typeof finished>;
    for (const e of events) item = panel.applyAskEvent(item, e);
    const [user, assistant] = panel.turnItems(item);
    expect(user.parts).toEqual([{ type: 'text', text: 'How is billing going?' }, { type: 'mentions', refs: [{ type: 'brainPage', id: 'customer/acme', name: 'Acme' }] }]);
    expect(assistant.parts.map((p) => p.type)).toEqual(expect.arrayContaining(['answer', 'steps']));
    const stored = JSON.stringify([user, assistant]);
    expect(stored).not.toContain(BLOCK_OPEN);
    expect(stored).not.toContain('Billing for the Acme account');
  });

  it('on reopen a link the reader may no longer see is dropped and counted', async () => {
    const turn = panel.turnItems({ ...finished(), links: [{ ref: 'customer/acme', name: 'Acme' }, { ref: 'customer/globex', name: 'Globex' }], status: 'done', info: { model: 'fake/ask' } });
    const stamped = turn.map((item, i) => ({ ...item, seq: i + 1, at: new Date().toISOString() }));
    const checked = await sanitizeItems(aliceActor, { surface: 'brain' }, stamped);
    expect(checked[1].meta?.hidden).toBe(1);
    const turns = panel.restoreAsk(checked);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ earlier: true, hidden: 1, question: 'How is Acme?' });
    expect(turns[0].links.map((l) => l.ref)).toEqual(['customer/acme']);
    expect(turns[0].answer).toBe('Acme is fine, see [[customer/acme|Acme]] and Globex [1].');
    expect(panel.hiddenLine(1)).toBe('1 link hidden');
    const conversation = { items: turns, busy: false, ask: async () => undefined, stop: () => undefined, clear: () => undefined, retry: () => undefined, open: () => undefined, setSubject: () => undefined };
    const html = renderToStaticMarkup(createElement(panel.AskPanel, { about: { ref: 'customer/acme', name: 'Acme' }, onClose: () => undefined, conversation }));
    expect(html).toContain('Earlier');
    expect(html).toContain('1 link hidden');
    expect(html).toContain('How is Acme?');
    expect(html).toContain('Conversation history');
    expect(html).not.toContain('customer/globex');
  });

  it('restores a question with no answer yet as a turn of its own', () => {
    const at = new Date().toISOString();
    const turns = panel.restoreAsk([
      { seq: 1, role: 'user', parts: [{ type: 'text', text: 'First?' }], at },
      { seq: 2, role: 'user', parts: [{ type: 'text', text: 'Second?' }], at },
      { seq: 3, role: 'assistant', parts: [{ type: 'error', message: 'Stopped.' }], at },
    ]);
    expect(turns.map((t) => t.question)).toEqual(['First?', 'Second?']);
    expect(turns[1]).toMatchObject({ error: 'Stopped.', stopped: true });
    expect(panel.historyOf(turns)).toEqual([]);
    void TEST_OWNER;
  });
});
