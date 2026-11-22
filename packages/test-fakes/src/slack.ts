/**
 * A stateful Slack Web API: channels that hold the messages sent to them (with threads), so a test of a node that posts
 * asserts on `slack.state().channels['#ops'].messages` instead of the request shape.
 *
 * Methods: auth.test, chat.postMessage (channel by id, `#name` or name; `thread_ts` for a reply), chat.update, chat.delete,
 * conversations.list / info / history (newest first, paged by `cursor`, thread replies left out) / replies, users.list.
 * Slack answers HTTP 200 with `{ ok: false, error }` for nearly everything; so does this, including a bad token
 * (`invalid_auth`, logged as refused). A script (`status: 429`, `retryAfter`) answers as the rate limiter does.
 * Point the credential's base URL at `slack.url` and its token at `slack.token`.
 */
import { defineFake, type Fake, type FakeReply, type FakeRequest } from './harness';

export const SLACK_TOKEN = 'xoxb-fake-test-token-000000';

export interface SlackMessage {
  ts: string;
  text: string;
  user: string;
  thread_ts?: string;
  blocks?: unknown[];
  edited?: boolean;
}

export interface SlackChannel {
  id: string;
  messages: SlackMessage[];
}

export interface SlackState {
  /** By `#name`. */
  channels: Record<string, SlackChannel>;
  users: Array<{ id: string; name: string; real_name: string; is_bot: boolean }>;
  /** The last timestamp handed out (the next message is one microsecond later). */
  clock: number;
}

export interface SlackSeed {
  token: string;
  /** Channel names without the `#` (default: general, ops, random). */
  channels: string[];
}

const BASE_TS = 1_700_000_000_000_000; // microseconds
const tsOf = (clock: number) => `${Math.floor(clock / 1_000_000)}.${String(clock % 1_000_000).padStart(6, '0')}`;

const ok = (body: Record<string, unknown> = {}): FakeReply => ({ body: { ok: true, ...body } });
const fail = (error: string, extra: Record<string, unknown> = {}): FakeReply => ({ body: { ok: false, error, ...extra } });

function find(state: SlackState, ref: unknown): [string, SlackChannel] | undefined {
  const key = String(ref ?? '');
  if (!key) return undefined;
  const byName = state.channels[key.startsWith('#') ? key : `#${key}`];
  if (byName) return [key.startsWith('#') ? key : `#${key}`, byName];
  return Object.entries(state.channels).find(([, channel]) => channel.id === key);
}

const channelJson = (name: string, channel: SlackChannel) => ({ id: channel.id, name: name.slice(1), is_channel: true, is_private: false, is_archived: false, is_member: true, num_members: 2 });
const messageJson = (message: SlackMessage) => ({ type: 'message', ...message });

function params(request: FakeRequest): Record<string, unknown> {
  const fromQuery = Object.fromEntries(request.query);
  return { ...fromQuery, ...((request.body as Record<string, unknown> | undefined) ?? {}) };
}

function route(state: SlackState, request: FakeRequest): FakeReply {
  const method = request.path.replace(/^\//, '');
  const p = params(request);
  switch (method) {
    case 'auth.test':
      return ok({ url: 'https://fake.slack.test/', team: 'Fake', user: 'landflow-bot', team_id: 'T000', user_id: 'U000BOT' });
    case 'chat.postMessage': {
      const found = find(state, p.channel);
      if (!found) return fail('channel_not_found');
      if (typeof p.text !== 'string' || !p.text) return fail('no_text');
      const [, channel] = found;
      if (p.thread_ts && !channel.messages.some((m) => m.ts === p.thread_ts)) return fail('thread_not_found');
      state.clock += 1;
      const message: SlackMessage = { ts: tsOf(state.clock), text: p.text, user: 'U000BOT', ...(p.thread_ts ? { thread_ts: String(p.thread_ts) } : {}), ...(Array.isArray(p.blocks) ? { blocks: p.blocks } : {}) };
      channel.messages.push(message);
      return ok({ channel: channel.id, ts: message.ts, message: messageJson(message) });
    }
    case 'chat.update': {
      const found = find(state, p.channel);
      if (!found) return fail('channel_not_found');
      const message = found[1].messages.find((m) => m.ts === p.ts);
      if (!message) return fail('message_not_found');
      if (typeof p.text === 'string') message.text = p.text;
      message.edited = true;
      return ok({ channel: found[1].id, ts: message.ts, text: message.text, message: messageJson(message) });
    }
    case 'chat.delete': {
      const found = find(state, p.channel);
      if (!found) return fail('channel_not_found');
      const index = found[1].messages.findIndex((m) => m.ts === p.ts);
      if (index < 0) return fail('message_not_found');
      found[1].messages.splice(index, 1);
      return ok({ channel: found[1].id, ts: p.ts });
    }
    case 'conversations.list':
      return ok({ channels: Object.entries(state.channels).map(([name, channel]) => channelJson(name, channel)), response_metadata: { next_cursor: '' } });
    case 'conversations.info': {
      const found = find(state, p.channel);
      return found ? ok({ channel: channelJson(...found) }) : fail('channel_not_found');
    }
    case 'conversations.history': {
      const found = find(state, p.channel);
      if (!found) return fail('channel_not_found');
      const top = found[1].messages.filter((m) => !m.thread_ts || m.thread_ts === m.ts).reverse();
      const start = Number(p.cursor ?? 0) || 0;
      const limit = Math.max(1, Math.min(Number(p.limit ?? 100) || 100, 999));
      const page = top.slice(start, start + limit);
      const more = start + page.length < top.length;
      return ok({ messages: page.map(messageJson), has_more: more, response_metadata: { next_cursor: more ? String(start + page.length) : '' } });
    }
    case 'conversations.replies': {
      const found = find(state, p.channel);
      if (!found) return fail('channel_not_found');
      const parent = found[1].messages.find((m) => m.ts === p.ts);
      if (!parent) return fail('thread_not_found');
      const replies = found[1].messages.filter((m) => m.thread_ts === parent.ts);
      return ok({ messages: [parent, ...replies].map(messageJson), has_more: false });
    }
    case 'users.list':
      return ok({ members: state.users, response_metadata: { next_cursor: '' } });
    default:
      return fail('unknown_method');
  }
}

/** A Slack fake. `seed.channels` names the channels it starts with; `seed.token` replaces the default token. */
export function fakeSlack(seed: Partial<SlackSeed> = {}): Fake<SlackState> {
  const names = seed.channels ?? ['general', 'ops', 'random'];
  return defineFake<SlackState>({
    name: 'slack',
    token: seed.token ?? SLACK_TOKEN,
    // Slack answers 200 {ok:false} even for a bad token.
    refusal: () => fail('invalid_auth'),
    initial: () => ({
      channels: Object.fromEntries(names.map((name, i) => [`#${name}`, { id: `C0${String(i + 1).padStart(2, '0')}FAKE`, messages: [] }])),
      users: [
        { id: 'U000BOT', name: 'landflow-bot', real_name: 'Landflow Bot', is_bot: true },
        { id: 'U001ADA', name: 'ada', real_name: 'Ada Lovelace', is_bot: false },
      ],
      clock: BASE_TS,
    }),
    routes: route,
  });
}
