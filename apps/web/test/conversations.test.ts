/** Conversations: the store's routes, owner-only answers, keeping off, brain link checks and retention. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { enableTestAuth, TEST_OWNER } from '@/lib/server/auth/test-bypass';

const previousDir = process.env.LANDFLOW_DATA_DIR;
process.env.LANDFLOW_DATA_DIR = mkdtempSync(join(tmpdir(), 'landflow-conversations-'));

const list = await import('@/app/api/conversations/route');
const one = await import('@/app/api/conversations/[id]/route');
const items = await import('@/app/api/conversations/[id]/items/route');
const prefs = await import('@/app/api/me/preferences/route');
const { routePolicy } = await import('@/lib/server/auth/policy');
const { database } = await import('@/lib/server/db');
const { personalProjectId } = await import('@/lib/shared/projects');
const { upsertEntity } = await import('@/lib/server/brain/entities');
const { pruneConversations } = await import('@/lib/server/conversations/retention');
const { conversationRetention } = await import('@/lib/server/conversations/retention');

const MEMBER = { ...TEST_OWNER, id: 'usr_test_member', email: 'member@landflow.test', name: 'Member', role: 'member' as const };

afterAll(() => {
  enableTestAuth();
  process.env.LANDFLOW_DATA_DIR = previousDir;
});

const req = (path: string, method = 'GET', body?: unknown) =>
  new Request(`http://localhost${path}`, { method, ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const create = async (body: Record<string, unknown>) => (await (await list.POST(req('/api/conversations', 'POST', body))).json()).conversation as { id: string; title: string };
const say = (id: string, text: string, role = 'user') => items.POST(req(`/api/conversations/${id}/items`, 'POST', { items: [{ role, parts: [{ type: 'text', text }] }] }), ctx(id));
const asMember = async <T>(fn: () => Promise<T>): Promise<T> => {
  enableTestAuth(MEMBER);
  try {
    return await fn();
  } finally {
    enableTestAuth();
  }
};

describe('conversations', () => {
  it('creates, appends and gets, titling from the first user text', async () => {
    const conversation = await create({ surface: 'spotlight', subjectType: 'workflow', subjectId: 'wf_1' });
    expect(conversation.title).toBe('New conversation');
    expect(await (await say(conversation.id, 'Add a Slack message after the webhook')).json()).toEqual({ seq: 1 });
    expect(await (await say(conversation.id, 'Done', 'assistant')).json()).toEqual({ seq: 2 });
    const got = await (await one.GET(req(`/api/conversations/${conversation.id}`), ctx(conversation.id))).json();
    expect(got.conversation.title).toBe('Add a Slack message after the webhook');
    expect(got.items.map((item: { seq: number; role: string }) => [item.seq, item.role])).toEqual([[1, 'user'], [2, 'assistant']]);
  });

  it('refuses an item that is too large or a bad part', async () => {
    const conversation = await create({ surface: 'spotlight' });
    expect((await say(conversation.id, 'x'.repeat(40_000))).status).toBe(400);
    const bad = await items.POST(req(`/api/conversations/${conversation.id}/items`, 'POST', { items: [{ role: 'user', parts: [{ type: 'nope' }] }] }), ctx(conversation.id));
    expect(bad.status).toBe(400);
  });

  it('lists by surface, subject and text, and pages with a cursor', async () => {
    const a = await create({ surface: 'brain', title: 'Churn question' });
    await say(a.id, 'which accounts are at risk of churning');
    const b = await create({ surface: 'architect', subjectType: 'workflow', subjectId: 'wf_9', title: 'Nightly report' });
    const read = async (query: string) => (await (await list.GET(req(`/api/conversations${query}`))).json()) as { conversations: Array<{ id: string }>; nextCursor: string | null };
    expect((await read('?surface=brain')).conversations.map((c) => c.id)).toEqual([a.id]);
    expect((await read('?subjectType=workflow&subjectId=wf_9')).conversations.map((c) => c.id)).toEqual([b.id]);
    expect((await read('?q=nightly')).conversations.map((c) => c.id)).toEqual([b.id]);
    expect((await read('?q=churning')).conversations.map((c) => c.id)).toEqual([a.id]);
    expect((await read('?q=100%25')).conversations).toEqual([]);
    expect((await read('?q=NIGHTLY')).conversations.map((c) => c.id)).toEqual([b.id]);
    const umlaut = await create({ surface: 'brain', title: 'Ärger mit dem Webhook' });
    expect((await read(`?q=${encodeURIComponent('Ärger')}`)).conversations.map((c) => c.id)).toEqual([umlaut.id]);
    const first = await read('?limit=2');
    expect(first.conversations).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await read(`?limit=2&cursor=${first.nextCursor}`);
    expect(second.conversations.length).toBeGreaterThan(0);
    expect(second.conversations.some((c) => first.conversations.some((f) => f.id === c.id))).toBe(false);
    expect((await list.GET(req('/api/conversations?cursor=junk'))).status).toBe(400);
    expect((await list.GET(req('/api/conversations?limit=101'))).status).toBe(400);
  });

  it('answers another person 404 on every route, and lists none of it', async () => {
    const mine = await create({ surface: 'spotlight', title: 'Mine' });
    await say(mine.id, 'private words');
    await asMember(async () => {
      expect((await one.GET(req(`/api/conversations/${mine.id}`), ctx(mine.id))).status).toBe(404);
      expect((await one.PATCH(req(`/api/conversations/${mine.id}`, 'PATCH', { title: 'Taken' }), ctx(mine.id))).status).toBe(404);
      expect((await one.DELETE(req(`/api/conversations/${mine.id}`, 'DELETE'), ctx(mine.id))).status).toBe(404);
      expect((await say(mine.id, 'hello')).status).toBe(404);
      expect((await (await list.GET(req('/api/conversations'))).json()).conversations).toEqual([]);
    });
    const still = await (await one.GET(req(`/api/conversations/${mine.id}`), ctx(mine.id))).json();
    expect(still.conversation.title).toBe('Mine');
    expect(still.items).toHaveLength(1);
  });

  it('renames, pins and deletes with the items', async () => {
    const conversation = await create({ surface: 'spotlight' });
    await say(conversation.id, 'hello');
    const patched = await (await one.PATCH(req(`/api/conversations/${conversation.id}`, 'PATCH', { title: 'Renamed', pinned: true }), ctx(conversation.id))).json();
    expect(patched.conversation).toMatchObject({ title: 'Renamed', pinned: true });
    expect((await one.DELETE(req(`/api/conversations/${conversation.id}`, 'DELETE'), ctx(conversation.id))).status).toBe(204);
    expect((await one.GET(req(`/api/conversations/${conversation.id}`), ctx(conversation.id))).status).toBe(404);
    expect(database().get<{ n: number }>('SELECT COUNT(*) AS n FROM conversation_items WHERE conversation_id = ?', conversation.id)?.n).toBe(0);
  });

  it('stores nothing while keeping is off', async () => {
    const existing = await create({ surface: 'spotlight' });
    await prefs.PATCH(req('/api/me/preferences', 'PATCH', { keepConversations: false }));
    try {
      const created = await list.POST(req('/api/conversations', 'POST', { surface: 'spotlight' }));
      expect(created.status).toBe(200);
      expect(await created.json()).toEqual({ conversation: null, kept: false });
      expect((await say(existing.id, 'not kept')).status).toBe(204);
      expect(database().get<{ n: number }>('SELECT COUNT(*) AS n FROM conversation_items WHERE conversation_id = ?', existing.id)?.n).toBe(0);
    } finally {
      await prefs.PATCH(req('/api/me/preferences', 'PATCH', { keepConversations: true }));
    }
  });

  it('drops a brain link the reader can no longer open and counts it', async () => {
    upsertEntity({ type: 'customer', id: 'open', name: 'Open Co', projectId: personalProjectId(TEST_OWNER.id), source: 'test' } as Parameters<typeof upsertEntity>[0]);
    upsertEntity({ type: 'customer', id: 'walled', name: 'Walled Co', projectId: 'prj_nobody_is_in', source: 'test' } as Parameters<typeof upsertEntity>[0]);
    const conversation = await create({ surface: 'brain', title: 'Brain' });
    await items.POST(
      req(`/api/conversations/${conversation.id}/items`, 'POST', {
        items: [{ role: 'assistant', parts: [{ type: 'answer', text: 'See [[customer/walled]]', links: [{ type: 'customer', id: 'open', name: 'Open Co' }, { type: 'customer', id: 'walled', name: 'Walled Co' }] }] }],
      }),
      ctx(conversation.id),
    );
    const read = async () => (await (await one.GET(req(`/api/conversations/${conversation.id}`), ctx(conversation.id))).json()).items[0];
    const asOwner = await read();
    // The owner can open both: the link to the page in their project is kept, nothing is counted as hidden.
    expect(asOwner.parts[0].links.map((l: { id: string }) => l.id)).toEqual(['open', 'walled']);
    expect(asOwner.meta?.hidden).toBeUndefined();
    // The stored row keeps the link: only a read drops it.
    const stored = database().get<{ parts: string }>('SELECT parts FROM conversation_items WHERE conversation_id = ?', conversation.id)!;
    expect(JSON.parse(stored.parts)[0].links).toHaveLength(2);
    // The member opened the owner's conversation? No: they own a copy of their own.
    await asMember(async () => {
      const copy = await create({ surface: 'brain', title: 'Mine' });
      await items.POST(req(`/api/conversations/${copy.id}/items`, 'POST', { items: [{ role: 'assistant', parts: [{ type: 'answer', text: 'x', links: [{ type: 'customer', id: 'walled', name: 'Walled Co' }] }] }] }), ctx(copy.id));
      const item = (await (await one.GET(req(`/api/conversations/${copy.id}`), ctx(copy.id))).json()).items[0];
      expect(item.parts[0].links).toEqual([]);
      expect(item.meta.hidden).toBe(1);
    });
  });

  it('keeps the tags a person may still open: brain pages, people, node types; drops the rest', async () => {
    upsertEntity({ type: 'customer', id: 'tagged', name: 'Tagged Co', projectId: personalProjectId(MEMBER.id), source: 'test' } as Parameters<typeof upsertEntity>[0]);
    upsertEntity({ type: 'customer', id: 'walled-tag', name: 'Walled Tag Co', projectId: 'prj_nobody_is_in', source: 'test' } as Parameters<typeof upsertEntity>[0]);
    const { createUser } = await import('@/lib/server/auth/users');
    const colleague = await createUser({ email: 'colleague@conversations.test', name: 'Colleague', role: 'member', password: 'colleague-password-1' });
    const refs = [
      { type: 'brainPage', id: 'customer/tagged', name: 'Tagged Co' },
      { type: 'brainPage', id: 'customer/walled-tag', name: 'Walled Tag Co' },
      { type: 'person', id: colleague.id, name: 'Colleague' },
      { type: 'person', id: 'usr_nobody', name: 'Gone' },
      { type: 'nodeType', id: 'core.set', name: 'Set' },
      { type: 'team', id: 'team_missing', name: 'Missing team' },
      { type: 'run', id: 'exec_missing', name: 'Missing run' },
    ];
    await asMember(async () => {
      const conversation = await create({ surface: 'brain', title: 'Tags' });
      await items.POST(req(`/api/conversations/${conversation.id}/items`, 'POST', { items: [{ role: 'user', parts: [{ type: 'text', text: 'about these' }, { type: 'mentions', refs }] }] }), ctx(conversation.id));
      const item = (await (await one.GET(req(`/api/conversations/${conversation.id}`), ctx(conversation.id))).json()).items[0];
      expect(item.parts[1].refs.map((r: { type: string; id: string }) => `${r.type}:${r.id}`)).toEqual(['brainPage:customer/tagged', `person:${colleague.id}`, 'nodeType:core.set']);
      expect(item.meta.hidden).toBe(4);
    });
  });

  it('retention deletes only old conversations, with their items', async () => {
    const old = await create({ surface: 'spotlight', title: 'Old' });
    await say(old.id, 'ancient');
    const fresh = await create({ surface: 'spotlight', title: 'Fresh' });
    await say(fresh.id, 'recent');
    const longAgo = new Date(Date.now() - 100 * 86_400_000).toISOString();
    database().upsert('conversations', { ...database().get<Record<string, string | number>>('SELECT * FROM conversations WHERE id = ?', old.id)!, updated_at: longAgo });
    expect(pruneConversations()).toBe(1);
    expect((await one.GET(req(`/api/conversations/${old.id}`), ctx(old.id))).status).toBe(404);
    expect((await one.GET(req(`/api/conversations/${fresh.id}`), ctx(fresh.id))).status).toBe(200);
    expect(database().get<{ n: number }>('SELECT COUNT(*) AS n FROM conversation_items WHERE conversation_id = ?', old.id)?.n).toBe(0);
  });

  it('the retention service prunes a minute after it starts, daily after that, and not once stopped', async () => {
    const old = await create({ surface: 'spotlight' });
    await say(old.id, 'old enough to go');
    const age = (id: string) => database().upsert('conversations', { ...database().get<Record<string, string | number>>('SELECT * FROM conversations WHERE id = ?', id)!, updated_at: new Date(Date.now() - 100 * 86_400_000).toISOString() });
    const exists = (id: string) => Boolean(database().get('SELECT id FROM conversations WHERE id = ?', id));
    age(old.id);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // The host's boot in this process may have started it already (with real timers): start it afresh.
      conversationRetention.stop();
      conversationRetention.start();
      vi.advanceTimersByTime(59_000);
      expect(exists(old.id)).toBe(true);
      vi.advanceTimersByTime(1_000);
      expect(exists(old.id)).toBe(false);
      const next = await create({ surface: 'spotlight' });
      await say(next.id, 'old by tomorrow');
      age(next.id);
      vi.advanceTimersByTime(86_400_000);
      expect(exists(next.id)).toBe(false);
      conversationRetention.stop();
      const last = await create({ surface: 'spotlight' });
      await say(last.id, 'kept: the service is stopped');
      age(last.id);
      vi.advanceTimersByTime(2 * 86_400_000);
      expect(exists(last.id)).toBe(true);
    } finally {
      conversationRetention.stop();
      vi.useRealTimers();
    }
  });

  it('is session only (an API key is refused)', () => {
    for (const [method, path] of [['GET', '/api/conversations'], ['POST', '/api/conversations'], ['GET', '/api/conversations/x'], ['DELETE', '/api/conversations/x'], ['POST', '/api/conversations/x/items']]) {
      expect(routePolicy(method, path).sessionOnly, `${method} ${path}`).toBe(true);
    }
  });

  it('the history button renders and groups by subject', async () => {
    const { ConversationHistory, historyParams, leaveOut } = await import('@/components/ui/conversation-history');
    const html = renderToStaticMarkup(createElement(ConversationHistory, { surface: 'spotlight', subjectType: 'workflow', subjectId: 'wf_1', onOpen: () => {}, onNew: () => {} }));
    expect(html).toContain('aria-label="Conversation history"');
    const record = (id: string) => ({ id, surface: 'spotlight' as const, projectId: null, subjectType: null, subjectId: null, title: id, pinned: false, createdAt: '', updatedAt: '' });
    expect(leaveOut([record('a'), record('b'), record('c')], [record('b')]).map((c) => c.id)).toEqual(['a', 'c']);
    // The subject group asks for its own subject (a per-subject request), "Everywhere" for none.
    expect(historyParams(' plan ', { subjectType: 'workflow', subjectId: 'wf_1' }, 'cur').toString()).toBe('limit=50&subjectType=workflow&subjectId=wf_1&q=plan&cursor=cur');
    expect(historyParams('').toString()).toBe('limit=50');
    // A chat that can only show its own surface (the Agent architect) asks for it in both groups.
    expect(historyParams('', undefined, null, 'architect').toString()).toBe('limit=50&surface=architect');
  });

  it('names a conversation from a first message over 200 characters, clipped to 80', async () => {
    const { createBody } = await import('@/lib/shared/conversations');
    const long = `Please ${'draft a very long flow '.repeat(20)}`;
    const body = createBody({ surface: 'spotlight' }, long);
    expect(body.title!.length).toBe(80);
    const conversation = await create(body);
    await say(conversation.id, long);
    const got = await (await one.GET(req(`/api/conversations/${conversation.id}`), ctx(conversation.id))).json();
    expect(got.conversation.title).toHaveLength(80);
    expect(createBody({ surface: 'brain' }).title).toBeUndefined();
  });

  it('never cuts an emoji in half when it clips a title', async () => {
    const { titleFrom } = await import('@/lib/shared/conversations');
    const title = titleFrom(`${'a'.repeat(78)}😀😀 and more`);
    expect(Array.from(title)).toHaveLength(80);
    expect(title).toBe(`${'a'.repeat(78)}😀…`);
    expect(title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
