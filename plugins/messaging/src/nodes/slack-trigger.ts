import { defineNode, NodeOperationError, verifySlackSignature, type IWebhookContext, type IWebhookMethodContext, type JsonObject } from '@landflow/sdk';
import { METRICS } from '../shared';
import { channelPatterns, matchesAny, SlackLookup, type LookupCache } from '../slack-activity';
import { slackCall, slackCredentials, type SlackCredentials } from './slack';

/** Events API event types the trigger offers; `*` is every event Slack sends to the Request URL. */
const EVENTS: Array<{ name: string; value: string; description?: string }> = [
  { name: 'Any Event', value: '*', description: 'Every event the Slack app is subscribed to' },
  { name: 'App Home Opened', value: 'app_home_opened', description: 'A user opened the app\'s Home or Messages tab' },
  { name: 'App Mention', value: 'app_mention', description: 'The app was @mentioned in a channel it is in' },
  {
    name: 'Button Pressed',
    value: 'block_actions',
    description: 'Someone pressed a button in a message the app posted (Interactivity: point the app\'s Interactivity Request URL at this node; not part of Any Event)',
  },
  { name: 'Channel Created', value: 'channel_created' },
  { name: 'Channel Renamed', value: 'channel_rename' },
  { name: 'File Public', value: 'file_public' },
  { name: 'File Shared', value: 'file_shared' },
  { name: 'Link Shared', value: 'link_shared', description: 'A link of a domain the app unfurls was posted' },
  { name: 'Member Joined Channel', value: 'member_joined_channel' },
  { name: 'Message', value: 'message', description: 'A message in any channel, group or DM the app can see (subscribe to the message.* events)' },
  { name: 'Reaction Added', value: 'reaction_added' },
  { name: 'Reaction Removed', value: 'reaction_removed' },
  { name: 'Team Join', value: 'team_join', description: 'A new member joined the workspace' },
  { name: 'User Change', value: 'user_change', description: 'A member\'s profile changed' },
];

/** `message` subtypes for an edit or a deletion of an earlier message. */
export const EDIT_SUBTYPES = new Set(['message_changed', 'message_deleted']);
export const DEFAULT_TOLERANCE_SECONDS = 300;

export const NOTICE =
  'Slack has no API to register an Events subscription. Publish the workflow, copy this node\'s Request URL from the editor\'s Publish menu (App webhooks) into the Slack app\'s ' +
  'Event Subscriptions page (Enable Events), and subscribe to the bot events you picked below. The credential\'s Signing Secret ("Basic Information" page) is required: Landflow ' +
  'verifies every call with it and answers Slack\'s URL verification. For Button Pressed, paste the same URL as the app\'s Interactivity Request URL (a Slack app has one, so use an app of its own ' +
  'when Landflow\'s own approval buttons need /api/slack/interactions).';

export const asObject = (value: unknown): JsonObject | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined);
export const asString = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const idOf = (value: unknown): string | undefined => asString(value) ?? asString(asObject(value)?.id);

/** The channel an event is about: messages and mentions `channel`, reactions `item.channel`, channel_created `channel.id`, file_shared `channel_id`. */
export function channelOf(event: JsonObject): string | undefined {
  return idOf(event.channel) ?? idOf(asObject(event.item)?.channel) ?? asString(event.channel_id);
}

/** The person (or bot user) behind an event; team_join and user_change carry a user object. */
export function userOf(event: JsonObject): string | undefined {
  return idOf(event.user) ?? asString(event.user_id) ?? asString(asObject(event.message)?.user);
}

/** Written by a bot or integration: `bot_id`, subtype `bot_message`, or one of the app's own users (also inside an edited message). */
export function isBotEvent(event: JsonObject, own: Set<string>): boolean {
  const message = asObject(event.message);
  const user = userOf(event);
  return Boolean(event.bot_id) || event.subtype === 'bot_message' || Boolean(message?.bot_id) || message?.subtype === 'bot_message' || (user !== undefined && own.has(user));
}

const channelList = (value: unknown): string[] =>
  String(value ?? '')
    .split(/[,\s]+/)
    .map((id) => id.trim())
    .filter(Boolean);

export const credentialsOf = (ctx: IWebhookContext | IWebhookMethodContext) => slackCredentials(ctx, ctx.getNodeParameter('authentication', 'accessToken'));

export interface TriggerStatic extends JsonObject {
  url: string;
  teamId: string;
  botUserId: string;
}

/** Channel names and user emails looked up for the name filter and activity items, kept in the static data as `lookups`. */
export const storedLookups = (data: JsonObject): LookupCache | undefined => (asObject(data.lookups) as LookupCache | undefined);

/**
 * Checks a call's Slack signature with the credential's Signing Secret: undefined when it is valid, else the 401 to
 * answer. Shared with the Slack Activity Trigger.
 */
export function rejectUnsigned(ctx: IWebhookContext, credentials: SlackCredentials): { response: { status: number; json: JsonObject } } | undefined {
  const options = (ctx.getNodeParameter<JsonObject>('options', {}) ?? {}) as JsonObject;
  const tolerance = Number(options.tolerance ?? DEFAULT_TOLERANCE_SECONDS);
  const secret = String(credentials.signingSecret ?? '').trim();
  const signed =
    secret !== '' &&
    verifySlackSignature(secret, ctx.getRawBody(), ctx.getHeader('x-slack-request-timestamp'), ctx.getHeader('x-slack-signature'), {
      toleranceSeconds: Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : DEFAULT_TOLERANCE_SECONDS,
    });
  if (signed) return undefined;
  ctx.logger.warn(secret ? 'rejected a call with a missing, invalid or stale Slack signature' : 'rejected a call: the Slack credential has no Signing Secret');
  return { response: { status: 401, json: { error: 'invalid signature' } } };
}

export const SlackTrigger = defineNode({
  description: {
    name: 'slackTrigger',
    displayName: 'Slack Trigger',
    description: 'Starts the workflow on Slack events: messages, mentions, reactions, new channels and members, shared files, …',
    version: 1,
    kind: 'trigger',
    triggerSource: 'appWebhook',
    categories: ['Communication'],
    icon: 'file:slack-trigger.svg',
    color: '#4A154B',
    subtitle: '{{events}}',
    documentationUrl: 'https://api.slack.com/apis/events-api',
    keywords: ['slack', 'trigger', 'webhook', 'events api', 'message', 'mention', 'reaction', 'channel'],
    inputs: [],
    outputs: [{ type: 'main' }],
    credentials: [
      { name: 'slackApi', required: true, displayOptions: { show: { authentication: ['accessToken'] } } },
      { name: 'slackOAuth2Api', required: true, displayOptions: { show: { authentication: ['oAuth2'] } } },
    ],
    properties: [
      {
        name: 'authentication',
        displayName: 'Authentication',
        type: 'options',
        noDataExpression: true,
        default: 'accessToken',
        options: [
          { name: 'Access Token', value: 'accessToken', description: 'A bot token pasted from the Slack app' },
          { name: 'OAuth2', value: 'oAuth2', description: 'Connect with Slack; the token is renewed for you' },
        ],
      },
      { name: 'notice', displayName: NOTICE, type: 'notice', default: '' },
      {
        name: 'events',
        displayName: 'Events',
        type: 'multiOptions',
        default: ['app_mention'],
        required: true,
        noDataExpression: true,
        options: EVENTS,
        description: 'The event types that start a run. Choosing Message and App Mention starts two runs for a mention in a channel.',
      },
      {
        name: 'watchWorkspace',
        displayName: 'Watch Whole Workspace',
        type: 'boolean',
        default: true,
        description: 'Whether events of every channel the app can see start a run; turn it off to limit them to the channels below',
      },
      {
        name: 'channelIds',
        displayName: 'Channel(s)',
        type: 'string',
        default: '',
        placeholder: 'C0123456789, C0987654321',
        description: 'Channel IDs, comma-separated (the channel\'s "Copy channel ID"). Events without a channel (new members, profile changes) do not match.',
        displayOptions: { show: { watchWorkspace: [false] } },
      },
      {
        name: 'channelNames',
        displayName: 'Channel Name Filter',
        type: 'string',
        default: '',
        placeholder: 'customer-*, proj-*',
        description: 'Only events in channels whose name matches one of these patterns (* any characters, ? one; comma-separated). The names are looked up (conversations.info, cached) and need channels:read. Empty: no name filter.',
      },
      {
        name: 'ignoreBots',
        displayName: 'Ignore Bot Messages',
        type: 'boolean',
        default: true,
        description: 'Whether to skip events written by bots or integrations (bot_id, subtype bot_message) and by this app itself, so a workflow that replies cannot trigger itself',
      },
      {
        name: 'ignoreEdits',
        displayName: 'Ignore Message Edits and Deletes',
        type: 'boolean',
        default: true,
        description: 'Whether to skip message events of subtype message_changed and message_deleted',
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          {
            name: 'tolerance',
            displayName: 'Signature Tolerance (s)',
            type: 'number',
            default: DEFAULT_TOLERANCE_SECONDS,
            typeOptions: { minValue: 0 },
            description: 'How far the signed request timestamp may be from now before the call is rejected as a replay',
          },
        ],
      },
    ],
  },
  execute(ctx) {
    // A manual run has no event: the trigger outputs nothing (pin data from a past execution to test downstream nodes).
    ctx.logger.info('Slack sends events to the published workflow; a manual run has no event to output');
    return [];
  },
  webhookMethods: {
    /** Slack keeps the subscription in the app's settings, so "exists" means this node registered itself for the current URL. */
    checkExists(ctx) {
      const data = ctx.getStaticData<TriggerStatic>();
      return Boolean(data.url) && data.url === ctx.getWebhookUrl();
    },
    async create(ctx) {
      const credentials = credentialsOf(ctx);
      if (!credentials.signingSecret?.trim()) {
        throw new NodeOperationError('The Slack credential has no Signing Secret', {
          description: 'Copy it from the Slack app\'s "Basic Information" page into the credential: Landflow verifies every Events API call with it.',
        });
      }
      if (ctx.getNodeParameter<boolean>('watchWorkspace', true) === false && channelList(ctx.getNodeParameter('channelIds', '')).length === 0) {
        throw new NodeOperationError('Add the channel IDs to watch, or turn on Watch Whole Workspace');
      }
      const selected = ctx.getNodeParameter<string[]>('events', []);
      if (!Array.isArray(selected) || selected.length === 0) throw new NodeOperationError('Select at least one event');
      // The token, base URL and team are checked now (a bad token fails at publish, not at the first event).
      const auth = await ctx.span('slack.auth.test', {}, () => slackCall<{ team_id?: string; user_id?: string; team?: string }>({ http: ctx.http }, credentials, 'auth.test'));
      ctx.setStaticData({ url: ctx.getWebhookUrl(), teamId: auth.team_id ?? '', botUserId: auth.user_id ?? '', team: auth.team ?? '' } satisfies TriggerStatic);
      ctx.logger.info(`Slack Trigger ready for team ${auth.team ?? auth.team_id ?? 'unknown'}: paste the Request URL into the app's Event Subscriptions`, { url: ctx.getWebhookUrl() });
      return true;
    },
    delete(ctx) {
      ctx.setStaticData({});
      return true;
    },
  },
  async webhook(ctx) {
    const credentials: SlackCredentials = credentialsOf(ctx);
    const rejected = rejectUnsigned(ctx, credentials);
    if (rejected) return rejected;

    const body = ctx.getBody<JsonObject>();
    if (body?.type === 'url_verification') return { response: { status: 200, json: { challenge: String(body.challenge ?? '') } } };
    const selected = ctx.getNodeParameter<string[]>('events', ['app_mention']) ?? [];
    const ignored = (reason: string) => ({ response: { status: 200, json: { ignored: reason } } });
    // Interactivity: a button press arrives as a form field `payload` (getBody unwraps it), signed like events.
    if (body?.type === 'block_actions') {
      if (!selected.includes('block_actions')) return ignored('block_actions');
      const item = buttonPress(body);
      if (!(await channelAllowed(ctx, credentials, (item.channel as string | null) ?? undefined))) return ignored('channel');
      // trigger_id is unique per press: a repeated delivery of the same press starts one run.
      return { items: [item], ...(typeof body.trigger_id === 'string' && { idempotencyKey: `block_actions:${body.trigger_id}` }) };
    }
    const event = asObject(body?.event);
    if (body?.type !== 'event_callback' || !event) return { response: { status: 200, json: { ignored: String(body?.type ?? 'unknown') } } };

    const type = String(event.type ?? '');
    if (!selected.includes('*') && !selected.includes(type)) return ignored(type);
    if (ctx.getNodeParameter<boolean>('ignoreEdits', true) !== false && type === 'message' && EDIT_SUBTYPES.has(String(event.subtype ?? ''))) return ignored(String(event.subtype));

    if (ctx.getNodeParameter<boolean>('ignoreBots', true) !== false) {
      const own = new Set<string>();
      const botUserId = ctx.getStaticData<TriggerStatic>().botUserId;
      if (botUserId) own.add(botUserId);
      for (const entry of Array.isArray(body.authorizations) ? body.authorizations : []) {
        const authorization = asObject(entry);
        if (authorization?.is_bot === true && typeof authorization.user_id === 'string') own.add(authorization.user_id);
      }
      if (isBotEvent(event, own)) return ignored('bot');
    }

    const channel = channelOf(event);
    if (!(await channelAllowed(ctx, credentials, channel))) return ignored('channel');

    const message = asObject(event.message);
    const item = {
      eventId: body.event_id ?? null,
      eventTime: body.event_time ?? event.event_ts ?? null,
      teamId: body.team_id ?? null,
      apiAppId: body.api_app_id ?? null,
      type,
      event,
      authorizations: body.authorizations ?? [],
      channel: channel ?? null,
      user: userOf(event) ?? null,
      text: asString(event.text) ?? asString(message?.text) ?? '',
      ts: asString(event.ts) ?? asString(asObject(event.item)?.ts) ?? asString(event.event_ts) ?? null,
      threadTs: asString(event.thread_ts) ?? asString(message?.thread_ts) ?? null,
      raw: body,
    } as JsonObject;
    ctx.metrics.counter(METRICS.pollUpdates, { description: 'New updates found by polling triggers', unit: '{update}' }).add(1, { service: 'slack' });
    // Slack redelivers an event (X-Slack-Retry-Num) when it saw no answer within 3 s: the event id keeps it to one run.
    return { items: [item], ...(typeof body.event_id === 'string' && { idempotencyKey: body.event_id }) };
  },
});

/** Whether the trigger's channel filters (Watch Whole Workspace off, Channel Name Filter) let a call about `channel` through. */
async function channelAllowed(ctx: IWebhookContext, credentials: SlackCredentials, channel: string | undefined): Promise<boolean> {
  if (ctx.getNodeParameter<boolean>('watchWorkspace', true) === false) {
    const wanted = channelList(ctx.getNodeParameter('channelIds', ''));
    if (!channel || !wanted.includes(channel)) return false;
  }
  const names = channelPatterns(ctx.getNodeParameter('channelNames', ''));
  if (names.length) {
    if (!channel) return false;
    const stored = ctx.getStaticData<TriggerStatic>();
    const lookup = new SlackLookup({ http: ctx.http, metrics: ctx.metrics }, credentials, (m) => ctx.logger.warn(m), storedLookups(stored));
    const info = await lookup.channel(channel);
    if (lookup.changed) ctx.setStaticData({ ...stored, lookups: lookup.cache });
    if (!info || !matchesAny(info.name, names)) return false;
  }
  return true;
}

/**
 * A `block_actions` payload as one item: who pressed (`user`, the member ID; `userName`), the first action's
 * `actionId` and `value` (the button's value, as the app set it), every action, where the message is (`channel`,
 * `messageTs`) and the `responseUrl` to answer through, with the whole payload in `raw`.
 */
export function buttonPress(body: JsonObject): JsonObject {
  const user = asObject(body.user);
  const container = asObject(body.container);
  const message = asObject(body.message);
  const actions = Array.isArray(body.actions) ? body.actions.map(asObject).filter((a): a is JsonObject => Boolean(a)) : [];
  const first = actions[0];
  return {
    type: 'block_actions',
    teamId: idOf(body.team) ?? null,
    apiAppId: asString(body.api_app_id) ?? null,
    user: idOf(user) ?? null,
    userName: asString(user?.username) ?? asString(user?.name) ?? null,
    channel: asString(container?.channel_id) ?? idOf(body.channel) ?? null,
    messageTs: asString(container?.message_ts) ?? asString(message?.ts) ?? null,
    actionId: asString(first?.action_id) ?? null,
    blockId: asString(first?.block_id) ?? null,
    value: asString(first?.value) ?? asString(asObject(first?.selected_option)?.value) ?? null,
    actions,
    responseUrl: asString(body.response_url) ?? null,
    triggerId: asString(body.trigger_id) ?? null,
    text: asString(message?.text) ?? '',
    raw: body,
  };
}
