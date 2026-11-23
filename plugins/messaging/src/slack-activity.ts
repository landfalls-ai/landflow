/**
 * Slack messages as activity items (docs/protocol.md §16): channel name patterns (`customer-*`), hints from the
 * channel's name, cached channel and user lookups, and history reads across channels since a point in time. Used by
 * the Slack node's Message → Get Many Since and Get, and by the Slack Activity Trigger.
 */
import { activityItem, NodeOperationError, type ActivityItem, type JsonObject } from '@landflow/sdk';
import { sleep, type ApiContext } from './shared';
import { slackCall, type SlackCredentials } from './nodes/slack';

/** Message subtypes that are not something a person wrote (joins, topic changes, pins…) or that edit an earlier message. */
const SKIPPED_SUBTYPES = new Set([
  'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose', 'channel_name', 'channel_archive', 'channel_unarchive',
  'group_join', 'group_leave', 'group_topic', 'group_purpose', 'group_name', 'group_archive', 'group_unarchive',
  'pinned_item', 'unpinned_item', 'message_changed', 'message_deleted', 'message_replied', 'channel_convert_to_private',
  'channel_convert_to_public', 'reminder_add', 'ekm_access_denied', 'assistant_app_thread', 'huddle_thread',
]);

/** Channel name patterns, comma, space or newline separated: `*` any run of characters, `?` one; a leading `#` is ignored; case-insensitive. */
export function channelPatterns(value: unknown): RegExp[] {
  return String(value ?? '')
    .split(/[,\s]+/)
    .map((p) => p.trim().replace(/^#/, ''))
    .filter(Boolean)
    .map((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i'));
}

export const matchesAny = (name: string, patterns: RegExp[]) => patterns.some((p) => p.test(name));

export interface ActivityHints {
  customerPrefix: string;
  initiativePrefix: string;
  teams: Array<{ pattern: RegExp; team: string }>;
}

/** The node's hint options: `customer-` names a customer channel unless changed; Team Map lines are `<pattern>=<team>`. */
export function hintsOf(options: JsonObject | undefined): ActivityHints {
  const teams: ActivityHints['teams'] = [];
  for (const line of String(options?.teamMap ?? '').split(/[\n,]+/)) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const [pattern] = channelPatterns(line.slice(0, at));
    const team = line.slice(at + 1).trim();
    if (pattern && team) teams.push({ pattern, team });
  }
  return {
    customerPrefix: options?.customerPrefix === undefined ? 'customer-' : String(options.customerPrefix).trim().toLowerCase(),
    initiativePrefix: String(options?.initiativePrefix ?? '').trim().toLowerCase(),
    teams,
  };
}

const after = (name: string, prefix: string) => (prefix && name.toLowerCase().startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : null);

export function hintsFor(channelName: string, hints: ActivityHints): { customerHint: string | null; initiativeHint: string | null; teamHint: string | null } {
  return {
    customerHint: after(channelName, hints.customerPrefix),
    initiativeHint: after(channelName, hints.initiativePrefix),
    teamHint: hints.teams.find((t) => t.pattern.test(channelName))?.team ?? null,
  };
}

/** Slack's `1762941600.000100` as epoch milliseconds. */
export const tsToMs = (ts: string) => Math.floor(Number(ts) * 1000);

/** A Since value as a Slack ts: a ts as is, an ISO time converted; empty is 24 hours ago. */
export function sinceTs(value: unknown, now = Date.now()): string {
  const text = String(value ?? '').trim();
  if (!text) return ((now - 86_400_000) / 1000).toFixed(6);
  if (/^\d{9,11}(\.\d{1,6})?$/.test(text)) return text.includes('.') ? text : `${text}.000000`;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(text) ? `${text}Z` : text);
  if (!Number.isFinite(ms)) throw new NodeOperationError(`Since must be an ISO time or a Slack timestamp (got "${text}")`);
  return (ms / 1000).toFixed(6);
}

/** Slack's permalink: https://<workspace>.slack.com/archives/<channel>/p<ts without the dot>, a reply with its thread. */
export function permalink(workspaceUrl: string, channel: string, ts: string, threadTs?: string | null): string | null {
  if (!workspaceUrl) return null;
  const base = `${workspaceUrl.replace(/\/+$/, '')}/archives/${channel}/p${ts.replace('.', '')}`;
  return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channel}` : base;
}

/** Slack markup made readable: <@U1> → @U1, <#C1|name> → #name, <url|label> → label, <!here> → @here, entities decoded. */
export function plainSlackText(text: string): string {
  return text
    .replace(/<@([A-Z0-9]+)(\|[^>]*)?>/g, (_, id: string, label?: string) => `@${label ? label.slice(1) : id}`)
    .replace(/<#([A-Z0-9]+)\|([^>]*)>/g, (_, _id: string, name: string) => `#${name}`)
    .replace(/<#([A-Z0-9]+)>/g, (_, id: string) => `#${id}`)
    .replace(/<!(here|channel|everyone)(\|[^>]*)?>/g, (_, who: string) => `@${who}`)
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]*)>/g, (_, name: string) => name)
    .replace(/<([^|>]+)\|([^>]+)>/g, (_, _url: string, label: string) => label)
    .replace(/<([^>]+)>/g, (_, url: string) => url)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Whether a history message is something a person (or, with `includeBots`, a bot) wrote. */
export function isActivityMessage(message: JsonObject, includeBots: boolean): boolean {
  const subtype = typeof message.subtype === 'string' ? message.subtype : '';
  if (SKIPPED_SUBTYPES.has(subtype)) return false;
  if (!includeBots && (message.bot_id || subtype === 'bot_message')) return false;
  return typeof message.ts === 'string';
}

export interface ChannelInfo extends JsonObject {
  id: string;
  name: string;
  private: boolean;
}

/** One message as an activity item. `kind` is work.discussion; the flow can change it. */
export function messageActivity(input: {
  teamId: string;
  workspaceUrl: string;
  channel: ChannelInfo;
  message: JsonObject;
  email: string | null;
  hints: ActivityHints;
  cursor?: string;
  withText?: boolean;
}): ActivityItem & { text?: string } {
  const { channel, message } = input;
  const ts = String(message.ts);
  const threadTs = typeof message.thread_ts === 'string' ? message.thread_ts : null;
  const text = plainSlackText(String(message.text ?? ''));
  const where = channel.name ? `#${channel.name}` : channel.id;
  const firstLine = text.split('\n').find((l) => l.trim()) ?? '';
  const item = activityItem({
    source: 'slack',
    sourceId: `slack:${input.teamId || 'team'}:${channel.id}:${ts}`,
    url: permalink(input.workspaceUrl, channel.id, ts, threadTs),
    actorEmail: input.email,
    occurredAt: tsToMs(ts),
    kind: 'work.discussion',
    title: `${where}: ${firstLine}`.slice(0, 400),
    summary: text,
    ...hintsFor(channel.name, input.hints),
    raw: {
      channel: channel.id,
      channelName: channel.name,
      ts,
      thread_ts: threadTs,
      user: message.user ?? null,
      subtype: message.subtype ?? null,
      text: message.text ?? '',
      reply_count: message.reply_count ?? null,
      reactions: Array.isArray(message.reactions) ? message.reactions.map((r) => ({ name: (r as JsonObject).name, count: (r as JsonObject).count })) : null,
      files: Array.isArray(message.files) ? message.files.map((f) => ({ id: (f as JsonObject).id, name: (f as JsonObject).name })) : null,
    },
    ...(input.cursor !== undefined && { cursor: input.cursor }),
  });
  return input.withText ? { ...item, text } : item;
}

/** Slack reads with a few retries on 429 (Retry-After, at most 30 s each), as history reads across channels hit Tier limits. */
export async function slackRead<T>(api: ApiContext, credentials: SlackCredentials, method: string, params: JsonObject, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await slackCall<T>(api, credentials, method, params, 'GET');
    } catch (error) {
      const description = String((error as { description?: unknown }).description ?? '');
      const match = /retry after (\d+) s/.exec(description);
      if (!/ratelimited/i.test((error as Error).message) || attempt >= retries) throw error;
      await sleep(Math.min(30, Number(match?.[1] ?? 1)) * 1000);
    }
  }
}

/** A lookup entry: channel `[name, private]` or user email, with when it was fetched (epoch seconds). */
export interface LookupCache extends JsonObject {
  channels: Record<string, { n: string; p: boolean; t: number }>;
  users: Record<string, { e: string; t: number }>;
}

const CACHE_TTL_SECONDS = 6 * 3600;
const CACHE_MAX = 1000;

const prune = <T extends { t: number }>(map: Record<string, T>) => {
  const keys = Object.keys(map);
  if (keys.length <= CACHE_MAX) return;
  keys.sort((a, b) => map[a].t - map[b].t).slice(0, keys.length - CACHE_MAX).forEach((k) => delete map[k]);
};

/**
 * Channel names and user emails, looked up once and cached: in memory for one run, or in a trigger's static data
 * across events (six hours). A lookup that fails (missing scope, unknown id) gives null and a warning, not an error.
 */
export class SlackLookup {
  readonly cache: LookupCache;
  changed = false;
  private warned = new Set<string>();

  constructor(
    private readonly api: ApiContext,
    private readonly credentials: SlackCredentials,
    private readonly warn: (message: string) => void,
    cache?: LookupCache,
  ) {
    this.cache = { channels: { ...(cache?.channels ?? {}) }, users: { ...(cache?.users ?? {}) } };
  }

  private fresh = (t: number) => Date.now() / 1000 - t < CACHE_TTL_SECONDS;

  remember(channel: { id: string; name: string; private: boolean }) {
    this.cache.channels[channel.id] = { n: channel.name, p: channel.private, t: Math.floor(Date.now() / 1000) };
    this.changed = true;
  }

  async channel(id: string): Promise<ChannelInfo | null> {
    const hit = this.cache.channels[id];
    if (hit && this.fresh(hit.t)) return { id, name: hit.n, private: hit.p };
    try {
      const { channel } = await slackRead<{ channel: JsonObject }>(this.api, this.credentials, 'conversations.info', { channel: id });
      const info = { id, name: String(channel.name ?? (channel.is_im ? 'dm' : '')), private: channel.is_private === true || channel.is_im === true || channel.is_mpim === true };
      this.remember(info);
      prune(this.cache.channels);
      return info;
    } catch (error) {
      this.warnOnce('channel', `could not look up channel ${id}: ${(error as Error).message}`);
      return null;
    }
  }

  async email(userId: string | null | undefined): Promise<string | null> {
    if (!userId) return null;
    const hit = this.cache.users[userId];
    if (hit && this.fresh(hit.t)) return hit.e || null;
    try {
      const { user } = await slackRead<{ user: JsonObject }>(this.api, this.credentials, 'users.info', { user: userId });
      const email = String((user.profile as JsonObject | undefined)?.email ?? '');
      this.cache.users[userId] = { e: email, t: Math.floor(Date.now() / 1000) };
      this.changed = true;
      prune(this.cache.users);
      return email || null;
    } catch (error) {
      this.warnOnce('user', `could not look up user ${userId} (actorEmail stays empty; the token needs users:read and users:read.email): ${(error as Error).message}`);
      return null;
    }
  }

  private warnOnce(key: string, message: string) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(message);
  }
}

/** The workspace's team id and URL (for permalinks), from auth.test. */
export async function workspaceOf(api: ApiContext, credentials: SlackCredentials): Promise<{ teamId: string; url: string }> {
  const auth = await slackCall<{ team_id?: string; url?: string }>(api, credentials, 'auth.test');
  return { teamId: auth.team_id ?? '', url: auth.url ?? '' };
}

/** All messages after `oldest` in one channel (history pages, then thread replies when asked), oldest first. */
export async function channelMessagesSince(
  api: ApiContext,
  credentials: SlackCredentials,
  channel: string,
  oldest: string,
  options: { includeReplies: boolean; max: number },
): Promise<JsonObject[]> {
  const messages: JsonObject[] = [];
  let cursor: string | undefined;
  do {
    const page = await slackRead<{ messages?: JsonObject[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }>(api, credentials, 'conversations.history', {
      channel,
      oldest,
      limit: 200,
      ...(cursor && { cursor }),
    });
    messages.push(...(page.messages ?? []));
    cursor = page.has_more !== false ? page.response_metadata?.next_cursor || undefined : undefined;
  } while (cursor && messages.length < options.max);
  if (options.includeReplies) {
    for (const parent of [...messages]) {
      if (!(Number(parent.reply_count) > 0) || Number(parent.latest_reply ?? Infinity) <= Number(oldest)) continue;
      let replyCursor: string | undefined;
      do {
        const page = await slackRead<{ messages?: JsonObject[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }>(api, credentials, 'conversations.replies', {
          channel,
          ts: String(parent.ts),
          oldest,
          limit: 200,
          ...(replyCursor && { cursor: replyCursor }),
        });
        messages.push(...(page.messages ?? []).filter((m) => m.ts !== parent.ts && Number(m.ts) > Number(oldest)));
        replyCursor = page.has_more ? page.response_metadata?.next_cursor || undefined : undefined;
      } while (replyCursor);
    }
  }
  return messages.filter((m) => Number(m.ts) > Number(oldest)).sort((a, b) => Number(a.ts) - Number(b.ts));
}
