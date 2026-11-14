/**
 * Ask the brain (docs/second-brain.md#the-brain-page): the streamed form in order (found, steps, words, text, done), the
 * JSON form as before, citations that point at nothing dropped, follow-ups that carry the last two turns, the Ask panel's
 * pure parts, and Ask counted in AI usage (surface `brain`). A fake model; no network.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModel, Workflow } from '@landflow/engine';
import type { AskEvent } from '@/lib/shared/brain-wiki';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-brain-ask-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { store } = await import('@/lib/server/store');
const { database } = await import('@/lib/server/db');
const { createUser } = await import('@/lib/server/auth/users');
const entities = await import('@/lib/server/brain/entities');
const { scopeForActor } = await import('@/lib/server/brain/scope');
const { saveKind } = await import('@/lib/server/usage/kinds');
const { recordUsage } = await import('@/lib/server/usage/ledger');
const { createTeamProject, setHomeProject, setMember } = await import('@/lib/server/projects/store');
const wiki = await import('@/lib/server/brain/wiki');
const { askBrainStream } = await import('@/lib/server/brain/ask-stream');
const { traceChat } = await import('@/lib/server/telemetry');
const { streamingPreview } = await import('@/lib/shared/brain-wiki');
const askRoute = await import('@/app/api/brain/ask/route');
const panel = await import('@/components/brain/wiki/ask-panel');

const owner = await createUser({ email: 'owner@ask.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
const alice = await createUser({ email: 'alice@ask.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
const alpha = createTeamProject({ name: 'Alpha', createdBy: owner.id });
const beta = createTeamProject({ name: 'Beta', createdBy: owner.id });
setMember(alpha.id, alice.id, 'editor');
const aliceActor = { id: alice.id, role: 'member' as const };

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const FIELDS = ['source', 'sourceId', 'url', 'actor', 'title', 'summary', 'team', 'initiative', 'customer', 'occurredAt'].map((name) => ({ name, type: 'string' as const, required: false }));
for (const kind of ['work.discussion', 'work.bug_reported']) saveKind({ kind, fields: FIELDS });

function flow(id: string, project: string) {
  const w = store.saveWorkflow({ id, name: `Ingest ${id}`, active: false, nodes: [], connections: [], createdBy: owner.id } as unknown as Workflow);
  setHomeProject('workflow', w.id, project);
}
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const work = (workflowId: string, kind: string, attrs: Record<string, string>, hoursAgo = 1) => recordUsage({ kind: kind as 'work.discussion', workflowId, at: ago(hoursAgo), attrs: { source: 'slack', sourceId: `${kind}:${Math.random()}`, occurredAt: ago(hoursAgo), ...attrs } })!;

function seed() {
  const db = database();
  for (const [table, column] of Object.entries({ brain_entities: 'created_at', brain_facts: 'last_seen', proposals: 'created_at', usage_events: 'at', brain_pages: 'generated_at' } as const)) db.deleteBefore(table as 'proposals', column, '9999');
  db.sqlite.exec('DELETE FROM ai_usage');
  flow('wf_alpha', alpha.id);
  flow('wf_beta', beta.id);
  const make = (input: Parameters<typeof entities.upsertEntity>[0]) => entities.upsertEntity(input).entity;
  make({ type: 'customer', id: 'acme', name: 'Acme', projectId: alpha.id, owner: 'Lee' });
  make({ type: 'initiative', id: 'atlas', name: 'Atlas', description: 'The new ingest service, first for Acme', projectId: alpha.id });
  make({ type: 'customer', id: 'globex', name: 'Globex', projectId: beta.id });
  work('wf_alpha', 'work.discussion', { title: '#customer-acme: renewal pricing', actor: 'lee@example.com', customer: 'acme' }, 2);
  work('wf_alpha', 'work.bug_reported', { title: 'ENG-42: Acme export times out', actor: 'dana@example.com', customer: 'Acme', initiative: 'Atlas', team: 'Engineering' }, 1);
  work('wf_beta', 'work.discussion', { title: 'Globex kickoff', actor: 'kim@example.com', customer: 'globex', team: 'CS' }, 3);
}

beforeEach(seed);

interface Fake extends LanguageModel {
  prompts: string[];
  formats: Array<string | undefined>;
}

/** A model that answers `reply`, streams it in words through `onToken`, and reports tokens the way the real adapters do. */
function fakeModel(reply: string | ((prompt: string) => string), provider = 'fake'): Fake {
  const prompts: string[] = [];
  const formats: Array<string | undefined> = [];
  return {
    provider,
    model: 'ask',
    prompts,
    formats,
    generate(input) {
      const prompt = String(input.messages[0].content);
      prompts.push(prompt);
      formats.push(input.responseFormat);
      const text = typeof reply === 'function' ? reply(prompt) : reply;
      return traceChat(
        { system: provider, model: 'ask' },
        async () => {
          if (input.onToken) for (const word of text.split(/(?<= )/)) input.onToken(word);
          return { text: input.responseFormat === 'json' ? JSON.stringify({ answer: text }) : text, toolCalls: [], stopReason: 'stop' as const, usage: { inputTokens: 120, outputTokens: 30 } };
        },
        () => ({ inputTokens: 120, outputTokens: 30 }),
      );
    },
  };
}

async function stream(question: string, model: LanguageModel | undefined, extra: Record<string, unknown> = {}, actor = aliceActor) {
  const events: AskEvent[] = [];
  await askBrainStream(actor, { question, scope: scopeForActor(actor), ...(model && { model }), ...extra }, (e) => events.push(e));
  return events;
}

const usageRows = () => database().all<{ surface: string | null; user_id: string | null }>('SELECT surface, user_id FROM ai_usage');

describe('the stream', () => {
  it('tells what it found first, then the steps, the words, the checked text and done', async () => {
    const events = await stream('What is happening with Acme exports?', fakeModel('Engineering is fixing the Acme export timeout [2] and Sales is on pricing [1].'));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('found');
    expect(types.slice(1, 7)).toEqual(['step.start', 'tool', 'step.start', 'tool', 'step.start', 'tool']);
    expect(types.indexOf('text.delta')).toBeGreaterThan(types.lastIndexOf('tool', 6));
    expect(types.at(-2)).toBe('text');
    expect(types.at(-1)).toBe('done');
    expect(types.indexOf('text')).toBeGreaterThan(types.lastIndexOf('text.delta'));

    const found = events[0] as Extract<AskEvent, { type: 'found' }>;
    expect(found.pages.map((p) => p.id)).toContain('customer/acme');
    expect(found.work).toBe(2);
    expect(found.pages.map((p) => p.id)).not.toContain('customer/globex');
    const names = events.filter((e): e is Extract<AskEvent, { type: 'tool' }> => e.type === 'tool').map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['read_pages', 'search_facts', 'read_work']));

    const done = events.at(-1) as Extract<AskEvent, { type: 'done' }>;
    expect(done).toMatchObject({ model: 'fake/ask', local: false, inputTokens: 120, outputTokens: 30 });
    expect(done.cited).toEqual([2, 1]);
    expect(done.sources).toHaveLength(2);
    expect(done.steps).toBeGreaterThanOrEqual(4);
    expect(typeof done.durationMs).toBe('number');
  });

  it('asks the model for plain words, not JSON, and reads a model that answers in JSON anyway', async () => {
    const model = fakeModel('{"answer": "Acme is on track."}');
    const events = await stream('Is Acme on track?', model);
    expect(model.formats).toEqual(['text']);
    expect((events.find((e) => e.type === 'text') as Extract<AskEvent, { type: 'text' }>).text).toBe('[[customer/acme|Acme]] is on track.');
  });

  it('counts the ask in AI usage as the brain, under the asker', async () => {
    await stream('Acme exports', fakeModel('It is slow.'));
    expect(usageRows()).toEqual([{ surface: 'brain', user_id: alice.id }]);
  });

  it('counts the JSON form too', async () => {
    await wiki.askBrain('Acme exports', scopeForActor(aliceActor), aliceActor, { model: fakeModel('It is slow.') });
    expect(usageRows()).toEqual([{ surface: 'brain', user_id: alice.id }]);
  });

  it('says a local model is local, and ends with an error event when the model fails', async () => {
    expect(((await stream('Acme exports', fakeModel('Fine.', 'ollama'))).at(-1) as Extract<AskEvent, { type: 'done' }>).local).toBe(true);
    const broken: LanguageModel = { provider: 'fake', model: 'broken', generate: () => Promise.reject(new Error('connection refused')) };
    const events = await stream('Acme exports', broken);
    expect(events.at(-1)).toEqual({ type: 'error', kind: 'model', message: 'The model failed: connection refused' });
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('without a model (brain off) ends with what it found and a note; an empty question is an error event', async () => {
    const events = await stream('Acme exports', undefined);
    expect(events.map((e) => e.type)).toEqual(['found', 'step.start', 'tool', 'step.start', 'tool', 'step.start', 'tool', 'done']);
    expect((events.at(-1) as Extract<AskEvent, { type: 'done' }>).note).toContain('LANDFLOW_BRAIN_MODEL');
    expect(await stream('   ', undefined)).toEqual([{ type: 'error', kind: 'invalid', message: 'Ask a question' }]);
  });

  it('shows a member only what their projects hold', async () => {
    const model = fakeModel('Only Alpha work.');
    const events = await stream('Globex kickoff and Acme exports', model);
    expect((events[0] as Extract<AskEvent, { type: 'found' }>).pages.map((p) => p.id)).not.toContain('customer/globex');
    expect(model.prompts[0]).not.toContain('customer/globex');
    const ownerEvents = await stream('Globex kickoff', fakeModel('Kickoff.'), {}, { id: owner.id, role: 'owner' as never });
    expect((ownerEvents[0] as Extract<AskEvent, { type: 'found' }>).pages.map((p) => p.id)).toContain('customer/globex');
  });
});

describe('the routes', () => {
  const post = (body: unknown, accept?: string) => askRoute.POST(new Request('http://localhost/api/brain/ask', { method: 'POST', headers: { 'content-type': 'application/json', ...(accept && { accept }) }, body: JSON.stringify(body) }));

  it('answer JSON without Accept: text/event-stream', async () => {
    const response = await post({ question: 'Acme exports' });
    expect(response.headers.get('content-type')).toContain('application/json');
    expect((await response.json()).pages[0]).toMatchObject({ id: 'acme' });
  });

  it('answer SSE with it, found first and done last', async () => {
    const response = await post({ question: 'Acme exports' }, 'text/event-stream');
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const text = await response.text();
    const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(events[0]).toBe('found');
    expect(events.at(-1)).toBe('done');
  });

  it('take at most two turns of history, each at most 1,500 characters', async () => {
    const turn = { question: 'q', answer: 'a' };
    expect((await post({ question: 'Acme', history: [turn, turn, turn] })).status).toBe(400);
    expect((await post({ question: 'Acme', history: [{ question: 'q', answer: 'a'.repeat(1_501) }] })).status).toBe(400);
    expect((await post({ question: 'Acme', history: [turn, turn] })).status).toBe(200);
  });
});

describe('citations', () => {
  it('drops a marker that points at no source', () => {
    expect(wiki.cleanCitations('Fixed [1], and also [3].', 2)).toBe('Fixed [1], and also.');
    expect(wiki.cleanCitations('Sources [0] and [2].', 2)).toBe('Sources and [2].');
  });

  it('drops every marker when there are no sources, and leaves page links alone', () => {
    expect(wiki.cleanCitations('Acme [1] is on track [2]. See [[customer/acme|Acme]].', 0)).toBe('Acme is on track. See [[customer/acme|Acme]].');
    expect(wiki.cleanCitations('Acme [1].', [])).toBe('Acme.');
    expect(wiki.cleanCitations('Open [1](https://example.com) and [[customer/acme]].', 0)).toBe('Open [1](https://example.com) and [[customer/acme]].');
  });

  it('numbers a source only when the answer cites it', async () => {
    const cited = await wiki.askBrain('Acme exports', undefined, undefined, { model: fakeModel('Slow exports [2]. Nothing at [9].') });
    expect(cited.cited).toEqual([2]);
    expect(cited.answer).not.toContain('[9]');
    const plain = await wiki.askBrain('Acme exports', undefined, undefined, { model: fakeModel('Slow exports [4].') });
    expect(plain.cited).toEqual([]);
    expect(plain.answer).toBe('Slow exports.');
  });

  it('tells the model to cite nothing when no work was found', async () => {
    const model = fakeModel('Nothing.');
    await wiki.askBrain('Atlas ingest', undefined, undefined, { model, about: 'initiative/atlas' });
    const bare = fakeModel('Nothing.');
    entities.upsertEntity({ type: 'system', id: 'lonely', name: 'Lonely', projectId: alpha.id });
    await wiki.askBrain('Lonely', undefined, undefined, { model: bare });
    expect(bare.prompts[0]).toContain('write no [n] markers');
  });
});

describe('follow-ups', () => {
  const history = [
    { question: 'Who works on Acme?', answer: 'Dana and Lee.' },
    { question: 'And on Atlas?', answer: 'Dana.' },
    { question: 'Anything blocked on Acme?', answer: 'The export timeout.' },
  ];

  it('reach the prompt as earlier turns, at most the last two', async () => {
    const model = fakeModel('Since March.');
    await wiki.askBrain('and since when?', undefined, undefined, { model, history });
    const prompt = model.prompts[0];
    expect(prompt).toContain('The conversation so far');
    expect(prompt).toContain('And on Atlas?');
    expect(prompt).toContain('The export timeout.');
    expect(prompt).not.toContain('Who works on Acme?');
    expect(prompt).toContain('New question: and since when?');
  });

  it('cut each part to 1,500 characters and drop empty turns', () => {
    const long = 'x'.repeat(2_000);
    const out = wiki.clampHistory([{ question: long, answer: long }, { question: ' ', answer: 'a' }]);
    expect(out).toHaveLength(1);
    expect(out[0].question).toHaveLength(1_500);
    expect(out[0].answer).toHaveLength(1_500);
  });

  it('borrow the last question’s words to find what a short follow-up is about', async () => {
    const found = (await wiki.askBrain('and since when?', undefined, undefined, { history: [{ question: 'What is happening with Acme exports?', answer: 'Slow.' }] })).pages;
    expect(found.map((p) => p.id)).toContain('acme');
    expect((await wiki.askBrain('and since when?', undefined, undefined)).pages).toEqual([]);
  });

  it('are sent through the stream too', async () => {
    const model = fakeModel('Yes.');
    await stream('and since when?', model, { history });
    expect(model.prompts[0]).toContain('And on Atlas?');
  });
});

describe('the panel', () => {
  const base = { id: 'a', question: 'Q', steps: [], streamed: '', links: [], sources: [], cited: [], status: 'working' as const };

  it('builds a turn from the events in order', () => {
    let item: ReturnType<typeof panel.applyAskEvent> = base;
    const apply = (e: AskEvent) => (item = panel.applyAskEvent(item, e));
    apply({ type: 'found', pages: [{ id: 'customer/acme', name: 'Acme' }], facts: 2, work: 1 });
    apply({ type: 'step.start', step: 1, label: 'Read 1 page' });
    apply({ type: 'tool', name: 'read_pages', label: 'Read 1 page', ok: true, id: 't1', step: 1, durationMs: 4 });
    apply({ type: 'text.delta', step: 4, text: 'Acme ' });
    apply({ type: 'text.delta', step: 4, text: 'is fine.' });
    expect(item.streamed).toBe('Acme is fine.');
    expect(item.steps).toEqual([{ id: 's1', label: 'Read 1 page', kind: 'read', status: 'ok', durationMs: 4 }]);
    apply({ type: 'text', text: 'Acme is fine [1].' });
    apply({ type: 'done', links: [], sources: [], cited: [1], model: 'fake/ask', local: false, durationMs: 900, steps: 4, inputTokens: 1, outputTokens: 2 });
    expect(item).toMatchObject({ status: 'done', answer: 'Acme is fine [1].', cited: [1], info: { model: 'fake/ask', steps: 4 } });
  });

  it('keeps the last two answered turns for history, cut to 1,500', () => {
    const done = (n: number, extra = {}) => ({ ...base, id: `i${n}`, question: `Q${n}`, answer: `A${n}`, status: 'done' as const, ...extra });
    const out = panel.historyOf([done(1), done(2), done(3, { error: 'x' }), done(4, { answer: 'y'.repeat(2_000) })]);
    expect(out.map((t) => t.question)).toEqual(['Q2', 'Q4']);
    expect(out[1].answer).toHaveLength(1_500);
  });

  it('shows a link as its name while it streams, and none half written', () => {
    expect(streamingPreview('Dana works on [[initiative/atlas|Atlas]] and [[customer/acme]] [1]')).toBe('Dana works on Atlas and acme [1]');
    expect(streamingPreview('Dana works on [[initiative/at')).toBe('Dana works on ');
    expect(streamingPreview('Slow [')).toBe('Slow ');
  });

  it('renders its empty state with starters and the model', () => {
    const html = renderToStaticMarkup(createElement(panel.AskPanel, { about: { ref: 'customer/acme', name: 'Acme' }, onClose: () => undefined, model: 'anthropic/claude-test', starters: ['What is the latest on Acme?'] }));
    expect(html).toContain('Ask the brain');
    expect(html).toContain('What is the latest on Acme?');
    expect(html).toContain('@Acme');
    expect(html).toContain('claude-test');
  });
});
