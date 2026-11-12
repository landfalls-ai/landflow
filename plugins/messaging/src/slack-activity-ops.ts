/**
 * The Slack node's activity operations: Message → Get Many Since (history across matching channels since a time, the
 * catch-up path for missed events) and Message → Get (one message with its full text). Both output activity items
 * (docs/protocol.md §16). This module's top level holds only literals: it and nodes/slack.ts import each other.
 */
import { NodeOperationError, type IExecuteContext, type JsonObject, type PropertyDescriptor } from '@landflow/sdk';
import type { ApiContext } from './shared';
import { listChannels, type SlackCredentials } from './nodes/slack';
import {
  channelMessagesSince,
  channelPatterns,
  hintsOf,
  isActivityMessage,
  matchesAny,
  messageActivity,
  sinceTs,
  slackRead,
  SlackLookup,
  workspaceOf,
  type ChannelInfo,
} from './slack-activity';

const sinceOps = { show: { resource: ['message'], operation: ['getManySince'] } };

/** The hint options, shared by the node and the Slack Activity Trigger. */
export const HINT_OPTIONS: PropertyDescriptor[] = [
  {
    name: 'customerPrefix',
    displayName: 'Customer Channel Prefix',
    type: 'string',
    default: 'customer-',
    description: 'A channel named <prefix><name> is about the customer <name> (customerHint). Empty: no customer hints.',
  },
  {
    name: 'initiativePrefix',
    displayName: 'Initiative Channel Prefix',
    type: 'string',
    default: '',
    placeholder: 'proj-',
    description: 'A channel named <prefix><name> belongs to the initiative <name> (initiativeHint)',
  },
  {
    name: 'teamMap',
    displayName: 'Team Map',
    type: 'string',
    default: '',
    typeOptions: { rows: 3 },
    placeholder: 'eng-*=R&D\ncs-*=CS\nsales-*=Sales',
    description: 'One <channel pattern>=<team> per line; the first match is the teamHint',
  },
];

export const ACTIVITY_OPTIONS: PropertyDescriptor[] = [
  {
    name: 'channelNames',
    displayName: 'Channel Names',
    type: 'string',
    default: '*',
    required: true,
    placeholder: 'customer-*, proj-*',
    displayOptions: sinceOps,
    description: 'Channels whose name matches one of these patterns (* any characters, ? one; comma-separated). * is every channel the app is in. The app reads only channels it was invited to.',
  },
  {
    name: 'since',
    displayName: 'Since',
    type: 'string',
    default: '',
    placeholder: '2026-11-12T08:00:00Z or 1762934400.000100',
    displayOptions: sinceOps,
    description: 'Messages posted after this ISO time or Slack timestamp (a cursor from an earlier item). Empty: the last 24 hours.',
  },
  {
    name: 'activityOptions',
    displayName: 'Options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    displayOptions: { show: { resource: ['message'], operation: ['getManySince', 'get'] } },
    values: [
      {
        name: 'channelIds',
        displayName: 'Channel IDs Instead',
        type: 'string',
        default: '',
        placeholder: 'C0123456789, C0987654321',
        description: 'Get Many Since: read these channels instead of matching names',
      },
      {
        name: 'includeReplies',
        displayName: 'Include Thread Replies',
        type: 'boolean',
        default: false,
        description: 'Get Many Since: also read the replies of threads with new replies (one more call per thread; mind Slack’s rate limits)',
      },
      {
        name: 'includePrivate',
        displayName: 'Include Private Channels and DMs',
        type: 'boolean',
        default: false,
        description: 'Whether private channels, group DMs and DMs the app is in are read too (needs groups:history, mpim:history, im:history)',
      },
      { name: 'includeBots', displayName: 'Include Bot Messages', type: 'boolean', default: false },
      ...HINT_OPTIONS,
    ],
  },
];

/** A Name Patterns filter, or undefined when none is set. */
export function namesFilter(value: unknown): ((name: string) => boolean) | undefined {
  const patterns = channelPatterns(value);
  return patterns.length ? (name) => matchesAny(name, patterns) : undefined;
}

const MAX_PER_CHANNEL = 10_000;

/** Message → Get Many Since: activity items, oldest first, each with `cursor` = its ts (pass the last one back as Since). */
export async function messagesSince(ctx: IExecuteContext, api: ApiContext, credentials: SlackCredentials, i: number): Promise<JsonObject[]> {
  const options = ctx.getNodeParameter<JsonObject>('activityOptions', i, {}) ?? {};
  const ids = String(options.channelIds ?? '').split(/[,\s]+/).filter(Boolean);
  const patterns = channelPatterns(ctx.getNodeParameter('channelNames', i, '*'));
  if (!ids.length && !patterns.length) throw new NodeOperationError('Set Channel Names (e.g. customer-*) or Channel IDs Instead', { itemIndex: i });
  const includePrivate = options.includePrivate === true;
  const oldest = sinceTs(ctx.getNodeParameter('since', i, ''));
  const returnAll = ctx.getNodeParameter<boolean>('returnAll', i, false);
  const limit = returnAll ? Infinity : Math.max(1, Number(ctx.getNodeParameter('limit', i, 50)) || 50);
  const lookup = new SlackLookup(api, credentials, (m) => ctx.logger.warn(m));
  const workspace = await workspaceOf(api, credentials);

  let channels: ChannelInfo[];
  if (ids.length) {
    channels = (await Promise.all(ids.map((id) => lookup.channel(id)))).filter((c): c is ChannelInfo => c !== null);
  } else {
    const listed = await listChannels(api, credentials, { types: includePrivate ? 'public_channel,private_channel,mpim,im' : 'public_channel', exclude_archived: true });
    const matching = listed.filter((c) => matchesAny(String(c.name ?? (c.is_im ? 'dm' : '')), patterns));
    const outside = matching.filter((c) => c.is_member !== true && c.is_im !== true);
    if (outside.length) {
      ctx.logger.info(`${outside.length} matching channel(s) skipped because the app is not in them: invite it with /invite`, { channels: outside.slice(0, 20).map((c) => `#${c.name}`).join(', ') });
    }
    channels = matching
      .filter((c) => c.is_member === true || c.is_im === true)
      .map((c) => ({ id: String(c.id), name: String(c.name ?? (c.is_im ? 'dm' : '')), private: c.is_private === true || c.is_im === true || c.is_mpim === true }));
    channels.forEach((c) => lookup.remember(c));
  }
  const hidden = channels.filter((c) => c.private && !includePrivate);
  if (hidden.length) ctx.logger.info(`${hidden.length} private channel(s) or DM(s) left out: turn on Include Private Channels and DMs to read them`);
  channels = channels.filter((c) => includePrivate || !c.private);

  const found: Array<{ channel: ChannelInfo; message: JsonObject }> = [];
  for (const channel of channels) {
    try {
      const messages = await ctx.span('slack.history', { 'slack.channel': channel.id }, () =>
        channelMessagesSince(api, credentials, channel.id, oldest, { includeReplies: options.includeReplies === true, max: MAX_PER_CHANNEL }),
      );
      for (const message of messages) if (isActivityMessage(message, options.includeBots === true)) found.push({ channel, message });
    } catch (error) {
      ctx.logger.warn(`could not read #${channel.name || channel.id}: ${(error as Error).message}`);
    }
  }
  found.sort((a, b) => Number(a.message.ts) - Number(b.message.ts));
  const hints = hintsOf(options);
  const items: JsonObject[] = [];
  for (const { channel, message } of found.slice(0, limit)) {
    const email = await lookup.email(typeof message.user === 'string' ? message.user : null);
    items.push(messageActivity({ teamId: workspace.teamId, workspaceUrl: workspace.url, channel, message, email, hints, cursor: String(message.ts) }));
  }
  return items;
}

/** Message → Get: the message with this ts (a thread reply too) as an activity item, plus its full `text`. */
export async function getMessageActivity(ctx: IExecuteContext, api: ApiContext, credentials: SlackCredentials, i: number, channelId: string, ts: string): Promise<JsonObject> {
  const options = ctx.getNodeParameter<JsonObject>('activityOptions', i, {}) ?? {};
  const lookup = new SlackLookup(api, credentials, (m) => ctx.logger.warn(m));
  const channel = (await lookup.channel(channelId)) ?? { id: channelId, name: '', private: false };
  if (channel.private && options.includePrivate !== true) {
    throw new NodeOperationError(`#${channel.name || channelId} is a private channel or a DM`, { itemIndex: i, description: 'Turn on Include Private Channels and DMs to read it.' });
  }
  const history = await slackRead<{ messages?: JsonObject[] }>(api, credentials, 'conversations.history', { channel: channelId, latest: ts, oldest: ts, inclusive: true, limit: 1 });
  let message = history.messages?.find((m) => m.ts === ts);
  if (!message) {
    const thread = await slackRead<{ messages?: JsonObject[] }>(api, credentials, 'conversations.replies', { channel: channelId, ts, inclusive: true, limit: 200 });
    message = thread.messages?.find((m) => m.ts === ts);
  }
  if (!message) throw new NodeOperationError(`No message ${ts} in ${channel.name ? `#${channel.name}` : channelId}`, { itemIndex: i });
  const workspace = await workspaceOf(api, credentials);
  const email = await lookup.email(typeof message.user === 'string' ? message.user : null);
  return messageActivity({ teamId: workspace.teamId, workspaceUrl: workspace.url, channel, message, email, hints: hintsOf(options), withText: true });
}
