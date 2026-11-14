/**
 * An agent's sessions by audience (docs/agents.md#sessions): People is test, telegram, slack and teams, Automations the
 * rest; the same on the files store and the database store, paged with a cursor. Then the pure pieces the chats on the
 * kit use: the timeline's step mapping and reply footer, and the architect's resume body.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SessionSource, SessionSummary, TimelineEntry } from '@/lib/shared/agents';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-sessions-filter-'));
const previous = { dir: process.env.LANDFLOW_DATA_DIR, store: process.env.LANDFLOW_CONFIG_STORE };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_DB: 'sqlite', LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
delete process.env.LANDFLOW_CONFIG_STORE;
afterAll(() => {
  if (previous.dir === undefined) delete process.env.LANDFLOW_DATA_DIR;
  else process.env.LANDFLOW_DATA_DIR = previous.dir;
  if (previous.store !== undefined) process.env.LANDFLOW_CONFIG_STORE = previous.store;
});

const { agentStore, createAgentStore, audienceSources, PEOPLE_SOURCES, AUTOMATION_SOURCES } = await import('@/lib/server/agents/store');
const { newSession } = await import('@/lib/server/agents/runtime');
const { GET } = await import('@/app/api/agents/[id]/sessions/route');

const SOURCES: SessionSource[] = ['test', 'telegram', 'slack', 'teams', 'schedule', 'workflow', 'agent', 'api'];
const idsOf = (list: SessionSummary[]) => list.map((s) => s.source);

function seed(store: ReturnType<typeof createAgentStore>, name: string) {
  const agent = store.create({ name });
  SOURCES.forEach((source) => {
    const session = newSession(agent, { source, userId: source === 'test' ? 'you' : `u-${source}`, version: 'draft' });
    store.saveSession({ ...session, id: `as_${source}` });
  });
  // An evaluation run is a test session too, but not the person's.
  store.saveSession({ ...newSession(agent, { source: 'test', userId: 'evaluation', version: 'draft' }), id: 'as_eval' });
  return agent;
}

describe('listSessions by audience', () => {
  for (const kind of ['files', 'database'] as const) {
    it(`filters and pages on the ${kind} store`, () => {
      const store = createAgentStore(kind);
      const agent = seed(store, `Agent ${kind}`);
      expect(idsOf(store.listSessions(agent.id, 50, { sources: PEOPLE_SOURCES })).sort()).toEqual(['slack', 'teams', 'telegram', 'test', 'test']);
      expect(idsOf(store.listSessions(agent.id, 50, { sources: AUTOMATION_SOURCES })).sort()).toEqual(['agent', 'api', 'schedule', 'workflow']);
      expect(store.listSessions(agent.id, 50).length).toBe(9);
      expect(store.listSessions(agent.id, 50, { sources: ['test'], userId: 'you' }).map((s) => s.id)).toEqual(['as_test']);

      // Newest first, paged by the last row: no row twice, none missed.
      const seen: string[] = [];
      let cursor: { s: string; i: string } | undefined;
      for (let page = 0; page < 5; page++) {
        const rows = store.listSessions(agent.id, 2, { sources: PEOPLE_SOURCES, ...(cursor && { cursor }) });
        if (!rows.length) break;
        seen.push(...rows.map((r) => r.id));
        cursor = { s: rows.at(-1)!.updatedAt, i: rows.at(-1)!.id };
      }
      expect([...seen].sort()).toEqual(['as_eval', 'as_slack', 'as_teams', 'as_telegram', 'as_test']);
      expect(new Set(seen).size).toBe(seen.length);
      // The same order as one big page: newest first.
      expect(seen).toEqual(store.listSessions(agent.id, 50, { sources: PEOPLE_SOURCES }).map((s) => s.id));
    });
  }

  it('names the sources of each audience', () => {
    expect(audienceSources('people')).toEqual(['test', 'telegram', 'slack', 'teams']);
    expect(audienceSources('automations')).toEqual(['schedule', 'workflow', 'agent', 'api']);
    expect(audienceSources(undefined)).toBeUndefined();
  });
});

describe('GET /api/agents/:id/sessions', () => {
  const agent = seed(agentStore, 'Route agent');
  const get = async (query: string) => {
    const response = await GET(new Request(`http://localhost/api/agents/${agent.id}/sessions${query}`), { params: Promise.resolve({ id: agent.id }) });
    return { status: response.status, body: (await response.json()) as { sessions: SessionSummary[]; nextCursor: string | null } };
  };

  it('answers people with test, telegram, slack and teams only, and automations with the rest', async () => {
    const people = await get('?audience=people');
    expect(new Set(idsOf(people.body.sessions))).toEqual(new Set(['test', 'telegram', 'slack', 'teams']));
    const automations = await get('?audience=automations');
    expect(new Set(idsOf(automations.body.sessions))).toEqual(new Set(['schedule', 'workflow', 'agent', 'api']));
    expect((await get('')).body.sessions.length).toBe(9);
  });

  it('pages with a cursor and says when there is no more', async () => {
    const whole = (await get('?audience=people')).body.sessions.map((s) => s.id);
    const first = await get('?audience=people&limit=2');
    expect(first.body.sessions.map((s) => s.id)).toEqual(whole.slice(0, 2));
    expect(first.body.nextCursor).toBeTruthy();
    const second = await get(`?audience=people&limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.sessions.map((s) => s.id)).toEqual(whole.slice(2, 4));
    const third = await get(`?audience=people&limit=2&cursor=${second.body.nextCursor}`);
    expect(third.body.sessions.map((s) => s.id)).toEqual(whole.slice(4));
    expect(third.body.nextCursor).toBeNull();
  });

  it('lists the test chat’s own sessions for source=test, and refuses a bad query', async () => {
    expect((await get('?source=test')).body.sessions.map((s) => s.id)).toEqual(['as_test']);
    expect((await get('?audience=everyone')).status).toBe(400);
    expect((await get('?cursor=nope')).status).toBe(400);
  });
});

describe('the timeline on the kit', () => {
  const T0 = Date.parse('2026-11-14T10:00:00.000Z');
  const at = (s: number) => new Date(T0 + s * 1000).toISOString();
  const tool = (id: string, over: Partial<Extract<TimelineEntry, { type: 'tool' }>> = {}): Extract<TimelineEntry, { type: 'tool' }> => ({
    id,
    type: 'tool',
    callId: id,
    tool: 'search_docs',
    label: 'Search docs',
    kind: 'node',
    input: {},
    status: 'success',
    durationMs: 800,
    at: at(1),
    ...over,
  });

  it('maps a tool row to a step: label, kind, how it ended, how long, one line of what came back', async () => {
    const { toolStep, traceOf } = await import('@/components/agents/timeline');
    expect(toolStep(tool('t1', { output: { hits: 3 } }))).toEqual({ id: 't1', label: 'Search docs', kind: 'tool', status: 'ok', durationMs: 800, detail: '{"hits":3}' });
    expect(toolStep(tool('t2', { kind: 'workflow', status: 'error', error: 'Timed out' }))).toMatchObject({ kind: 'run', status: 'failed', detail: 'Timed out' });
    expect(toolStep(tool('t3', { status: 'denied' }))).toMatchObject({ status: 'failed', detail: 'Denied' });
    expect(toolStep(tool('t4', { status: 'running', durationMs: undefined }))).toMatchObject({ status: 'running' });
    expect(toolStep(tool('t5', { status: 'awaiting_approval' })).status).toBe('running');
    expect(toolStep(tool('t6', { kind: 'memory' })).kind).toBe('think');
    // The run of calls is one trace; its time is the sum when every call knows its own.
    expect(traceOf([tool('a'), tool('b', { durationMs: 1200 })])).toMatchObject({ durationMs: 2000, steps: [{ id: 'a' }, { id: 'b' }] });
    expect(traceOf([tool('a'), tool('b', { durationMs: undefined })]).durationMs).toBeUndefined();
  });

  it('says what answered and how in the footer: model, time since the question, steps, tokens, cost', async () => {
    const { replyInfo } = await import('@/components/agents/timeline');
    const entries: TimelineEntry[] = [
      { id: 'u1', type: 'user', text: 'Hi', at: at(0) },
      tool('t1'),
      tool('t2'),
      { id: 'a1', type: 'assistant', text: 'Done', at: at(14.5), model: 'claude-test', usage: { inputTokens: 1200, outputTokens: 400, costUsd: 0.004 } },
      { id: 'u2', type: 'user', text: 'Again', at: at(20) },
      { id: 'a2', type: 'assistant', text: 'Sure', at: at(22) },
    ];
    expect(replyInfo(entries, 3)).toEqual({ model: 'claude-test', durationMs: 14500, steps: 2, inputTokens: 1200, outputTokens: 400, costUsd: 0.004 });
    // The second turn counts from its own question and none of the first turn's calls.
    expect(replyInfo(entries, 5)).toEqual({ durationMs: 2000 });
    expect(replyInfo(entries, 0)).toEqual({});
  });

  it('draws one activity line for a run of calls, a full row for one waiting for approval, and the footer under the reply', async () => {
    const { TimelineView } = await import('@/components/agents/timeline');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { createElement } = await import('react');
    const entries: TimelineEntry[] = [
      { id: 'u1', type: 'user', text: 'Hi', at: at(0) },
      tool('t1'),
      tool('t2'),
      { id: 'a1', type: 'assistant', text: 'Done', at: at(3), model: 'claude-test', usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.002 } },
    ];
    const html = renderToStaticMarkup(createElement(TimelineView, { entries, trace: { running: false } }));
    expect(html).toContain('2 steps');
    expect(html).not.toContain('Search docs');
    expect(html).toContain('claude-test');
    expect(html).toContain('3.0 s');
    expect(html).toContain('150 tokens');
    expect(html).toContain('$0.002');
    const waiting = renderToStaticMarkup(createElement(TimelineView, { entries: [entries[0], tool('t3', { status: 'awaiting_approval' })], onDecide: () => {}, trace: { running: true } }));
    expect(waiting).toContain('Approve');
    expect(waiting).toContain('It waits until someone approves');
  });
});

describe('the Agent architect keeps its conversation', () => {
  const draft = { id: 'd1', summary: 'A support agent', config: { name: 'Support' }, needs: [], dropped: [], missing: [] };

  it('posts the conversation and the draft, and the checkpoint to continue a failed design', async () => {
    const { architectBody } = await import('@/components/agents/architect');
    const messages = [
      { role: 'user' as const, text: 'Answer from our docs', steps: [] },
      { role: 'assistant' as const, text: 'Looking.', steps: [], proposed: 'A support agent' },
      { role: 'user' as const, text: 'Add Slack', steps: [] },
    ];
    expect(architectBody(messages, { name: 'Support' })).toEqual({
      messages: [
        { role: 'user', content: 'Answer from our docs' },
        { role: 'assistant', content: 'Looking.\n[Proposed draft “A support agent”]' },
        { role: 'user', content: 'Add Slack' },
      ],
      draft: { name: 'Support' },
    });
    expect(architectBody(messages.slice(0, 1), undefined, { checkpoint: 'ck_abc' })).toEqual({ messages: [{ role: 'user', content: 'Answer from our docs' }], resume: { checkpoint: 'ck_abc' } });
  });

  it('keeps a reply as steps, the draft and what it cost, and brings it back under Earlier with its draft', async () => {
    const { replyItem, restore } = await import('@/components/agents/architect');
    const item = replyItem(
      { role: 'assistant', text: 'Here is a draft.', steps: [{ id: 's1', label: 'Searched nodes', kind: 'tool', status: 'ok', durationMs: 400 }], proposed: draft.summary, info: { model: 'claude-test', durationMs: 5000, steps: 3, inputTokens: 10, outputTokens: 5, costUsd: 0.001 } },
      draft,
    );
    expect(item.parts.map((p) => p.type)).toEqual(['text', 'steps', 'proposal']);
    expect(item.meta).toEqual({ model: 'claude-test', durationMs: 5000, steps: 3, inputTokens: 10, outputTokens: 5, costUsd: 0.001 });
    const back = restore([
      { seq: 1, role: 'user', parts: [{ type: 'text', text: 'Answer from our docs' }], at: at0 },
      { seq: 2, role: 'assistant', parts: item.parts, meta: item.meta, at: at0 },
      { seq: 3, role: 'assistant', parts: [{ type: 'error', message: 'Ollama error 500', kind: 'model' }], at: at0 },
    ]);
    expect(back.messages.map((m) => [m.role, m.earlier])).toEqual([['user', true], ['assistant', true], ['assistant', true]]);
    expect(back.messages[1]).toMatchObject({ text: 'Here is a draft.', proposed: draft.summary, steps: [{ id: 's1', status: 'ok' }], info: { model: 'claude-test', costUsd: 0.001 } });
    expect(back.draft).toEqual(draft);
    // A kept failure has lost its checkpoint: Try again only.
    expect(back.messages[2].error).toEqual({ message: 'Ollama error 500', kind: 'model' });
    expect(back.messages[2].error?.checkpoint).toBeUndefined();
  });
});

const at0 = '2026-11-14T10:00:00.000Z';
