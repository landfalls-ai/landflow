/**
 * A fake Slack workspace behind the Web API methods the activity operations call: auth.test, conversations.list /
 * info / history / replies and users.list / info, with Slack's paging (limit, cursor, has_more), `oldest` exclusive,
 * `latest` + `inclusive`, and newest-first history. Fake tokens and data only.
 */
import type { JsonObject } from '@landflow/sdk';
import { startFakeApi, type FakeApi, type FakeRequest } from './helpers';

export const TOKEN = 'xoxb-fake-activity-token';

export interface FakeChannel {
  id: string;
  name: string;
  is_private?: boolean;
  is_im?: boolean;
  is_member: boolean;
  messages: JsonObject[];
  /** Thread replies by parent ts. */
  replies?: Record<string, JsonObject[]>;
}

export interface FakeWorkspace {
  channels: FakeChannel[];
  users: JsonObject[];
}

const page = <T>(list: T[], request: FakeRequest, max = 1000) => {
  const limit = Math.min(Number(request.query.get('limit') ?? 100) || 100, max);
  const start = Number(request.query.get('cursor')?.replace('next-', '') ?? 0) || 0;
  const slice = list.slice(start, start + limit);
  const more = start + limit < list.length;
  return { slice, more, meta: { next_cursor: more ? `next-${start + limit}` : '' } };
};

const ok = (body: JsonObject) => ({ body: { ok: true, ...body } });
const fail = (error: string) => ({ body: { ok: false, error } });

export function slackHandler(workspace: () => FakeWorkspace) {
  return (request: FakeRequest) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return fail('invalid_auth');
    const ws = workspace();
    const q = request.query;
    const channel = ws.channels.find((c) => c.id === q.get('channel'));
    switch (request.path) {
      case '/auth.test':
        return ok({ url: 'https://acme.slack.com/', team: 'Acme', user: 'landflow-bot', team_id: 'T1', user_id: 'UBOT' });
      case '/conversations.list': {
        const types = (q.get('types') ?? 'public_channel').split(',');
        const wanted = ws.channels.filter((c) =>
          c.is_im ? types.includes('im') : c.is_private ? types.includes('private_channel') : types.includes('public_channel'),
        );
        const { slice, meta } = page(wanted, request);
        return ok({
          channels: slice.map((c): JsonObject => (c.is_im ? { id: c.id, is_im: true, user: 'U2' } : { id: c.id, name: c.name, is_private: c.is_private === true, is_member: c.is_member })),
          response_metadata: meta,
        });
      }
      case '/conversations.info':
        if (!channel) return fail('channel_not_found');
        return ok({ channel: channel.is_im ? { id: channel.id, is_im: true } : { id: channel.id, name: channel.name, is_private: channel.is_private === true } });
      case '/conversations.history': {
        if (!channel) return fail('channel_not_found');
        if (!channel.is_member && !channel.is_im) return fail('not_in_channel');
        const oldest = Number(q.get('oldest') ?? 0);
        const latest = q.get('latest') ? Number(q.get('latest')) : Infinity;
        const inclusive = q.get('inclusive') === 'true';
        const within = channel.messages
          .filter((m) => {
            const ts = Number(m.ts);
            return (inclusive ? ts >= oldest : ts > oldest) && (inclusive ? ts <= latest : ts < latest);
          })
          .sort((a, b) => Number(b.ts) - Number(a.ts));
        const { slice, more, meta } = page(within, request, 999);
        return ok({ messages: slice, has_more: more, response_metadata: meta });
      }
      case '/conversations.replies': {
        if (!channel) return fail('channel_not_found');
        const ts = q.get('ts') ?? '';
        const parentTs = Object.keys(channel.replies ?? {}).find((p) => p === ts || channel.replies![p].some((r) => r.ts === ts)) ?? ts;
        const parent = channel.messages.find((m) => m.ts === parentTs);
        if (!parent) return fail('thread_not_found');
        const oldest = Number(q.get('oldest') ?? 0);
        const thread = [parent, ...(channel.replies?.[parentTs] ?? []).filter((r) => Number(r.ts) > oldest)];
        const { slice, more, meta } = page(thread, request);
        return ok({ messages: slice, has_more: more, response_metadata: meta });
      }
      case '/users.info': {
        const user = ws.users.find((u) => u.id === q.get('user'));
        return user ? ok({ user }) : fail('user_not_found');
      }
      case '/users.list': {
        const { slice, meta } = page(ws.users, request);
        return ok({ members: slice, response_metadata: meta });
      }
      default:
        return fail('unknown_method');
    }
  };
}

export const user = (id: string, email: string, extra: JsonObject = {}): JsonObject => ({ id, name: id.toLowerCase(), real_name: `User ${id}`, profile: { email, title: 'Engineer' }, ...extra });

/** A message `seconds` after 1794477600 (2026-11-12T10:00:00Z). */
export const msg = (seconds: number, text: string, extra: JsonObject = {}): JsonObject => ({ type: 'message', user: 'U1', text, ts: `${1_794_477_600 + seconds}.000100`, ...extra });

export async function startFakeSlack(workspace: () => FakeWorkspace): Promise<FakeApi> {
  return startFakeApi(slackHandler(workspace));
}
