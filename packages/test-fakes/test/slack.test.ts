/** The Slack fake: messages land per channel and thread, history pages newest first, a bad token is Slack's 200 invalid_auth. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeSlack } from '../src/slack';

const slack = fakeSlack();
beforeAll(() => slack.start());
afterAll(() => slack.stop());
beforeEach(() => slack.reset());

const api = async (method: string, params: Record<string, unknown> = {}, token = slack.token) => {
  const response = await fetch(`${slack.url}/${method}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(params) });
  return (await response.json()) as Record<string, any>;
};
const read = async (method: string, query: Record<string, string>) => {
  const response = await fetch(`${slack.url}/${method}?${new URLSearchParams(query)}`, { headers: { authorization: `Bearer ${slack.token}` } });
  return (await response.json()) as Record<string, any>;
};

describe('chat.postMessage', () => {
  it('stores a message in #ops, addressed by name or by id, and answers in Slack\'s shape', async () => {
    const byName = await api('chat.postMessage', { channel: '#ops', text: 'deploy done' });
    expect(byName).toMatchObject({ ok: true, ts: expect.stringMatching(/^\d+\.\d{6}$/), message: { text: 'deploy done' } });
    const id = slack.state().channels['#ops'].id;
    await api('chat.postMessage', { channel: id, text: 'second' });
    expect(slack.state().channels['#ops'].messages.map((m) => m.text)).toEqual(['deploy done', 'second']);
    expect(slack.state().channels['#general'].messages).toEqual([]);
  });

  it('puts a reply with thread_ts in the thread, and refuses a thread that does not exist', async () => {
    const parent = await api('chat.postMessage', { channel: '#ops', text: 'incident' });
    const reply = await api('chat.postMessage', { channel: '#ops', text: 'on it', thread_ts: parent.ts });
    expect(reply.ok).toBe(true);
    expect(slack.state().channels['#ops'].messages[1]).toMatchObject({ text: 'on it', thread_ts: parent.ts });
    expect(await api('chat.postMessage', { channel: '#ops', text: 'x', thread_ts: '1.000001' })).toMatchObject({ ok: false, error: 'thread_not_found' });
    const replies = await read('conversations.replies', { channel: slack.state().channels['#ops'].id, ts: parent.ts });
    expect(replies.messages.map((m: { text: string }) => m.text)).toEqual(['incident', 'on it']);
  });

  it('keeps blocks, and chat.update changes the text in place', async () => {
    const sent = await api('chat.postMessage', { channel: '#ops', text: 'v1', blocks: [{ type: 'section' }] });
    expect(slack.state().channels['#ops'].messages[0].blocks).toEqual([{ type: 'section' }]);
    expect(await api('chat.update', { channel: sent.channel, ts: sent.ts, text: 'v2' })).toMatchObject({ ok: true });
    expect(slack.state().channels['#ops'].messages.map((m) => m.text)).toEqual(['v2']);
  });

  it('answers channel_not_found and missing text', async () => {
    expect(await api('chat.postMessage', { channel: '#nowhere', text: 'x' })).toEqual({ ok: false, error: 'channel_not_found' });
    expect(await api('chat.postMessage', { channel: '#ops' })).toEqual({ ok: false, error: 'no_text' });
    expect(slack.state().channels['#ops'].messages).toEqual([]);
  });
});

describe('blocks and scripts', () => {
  it('takes blocks without text', async () => {
    expect(await api('chat.postMessage', { channel: '#ops', blocks: [{ type: 'divider' }] })).toMatchObject({ ok: true });
    expect(slack.state().channels['#ops'].messages[0]).toMatchObject({ text: '', blocks: [{ type: 'divider' }] });
  });

  it('answers a scripted 429 as Slack does: ratelimited with Retry-After', async () => {
    slack.script({ status: 429, retryAfter: 2 });
    const response = await fetch(`${slack.url}/chat.postMessage`, { method: 'POST', headers: { authorization: `Bearer ${slack.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ channel: '#ops', text: 'x' }) });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('2');
    expect(await response.json()).toEqual({ ok: false, error: 'ratelimited' });
  });
});

describe('reads', () => {
  it('pages conversations.history newest first with a cursor, leaving thread replies out', async () => {
    const id = slack.state().channels['#ops'].id;
    const first = await api('chat.postMessage', { channel: id, text: 'm1' });
    for (const n of [2, 3, 4]) await api('chat.postMessage', { channel: id, text: `m${n}` });
    await api('chat.postMessage', { channel: id, text: 'reply', thread_ts: first.ts });
    const page1 = await read('conversations.history', { channel: id, limit: '2' });
    expect(page1.messages.map((m: { text: string }) => m.text)).toEqual(['m4', 'm3']);
    expect(page1.has_more).toBe(true);
    const page2 = await read('conversations.history', { channel: id, limit: '2', cursor: page1.response_metadata.next_cursor });
    expect(page2.messages.map((m: { text: string }) => m.text)).toEqual(['m2', 'm1']);
    expect(page2.has_more).toBe(false);
  });

  it('lists channels and users, and answers conversations.info', async () => {
    const list = await read('conversations.list', {});
    expect(list.channels.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(['general', 'ops']));
    expect((await read('users.list', {})).members.length).toBeGreaterThan(0);
    expect((await read('conversations.info', { channel: list.channels[0].id })).channel.name).toBe(list.channels[0].name);
  });
});

describe('auth and seed', () => {
  it('answers a bad token with 200 invalid_auth, as Slack does, and counts it refused', async () => {
    expect(await api('chat.postMessage', { channel: '#ops', text: 'x' }, 'xoxb-wrong')).toEqual({ ok: false, error: 'invalid_auth' });
    expect(slack.requests().at(-1)).toMatchObject({ status: 200, refused: true });
    expect(slack.state().channels['#ops'].messages).toEqual([]);
  });

  it('takes its own channels and token from the seed', async () => {
    const own = fakeSlack({ token: 'xoxb-mine', channels: ['alerts'] });
    await own.start();
    try {
      expect(Object.keys(own.state().channels)).toEqual(['#alerts']);
      expect(own.token).toBe('xoxb-mine');
    } finally {
      await own.stop();
    }
  });
});
