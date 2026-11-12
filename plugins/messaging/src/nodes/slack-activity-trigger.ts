import { ACTIVITY_ITEM_SCHEMA, defineNode, NodeOperationError, type JsonObject } from '@landflow/sdk';
import { METRICS } from '../shared';
import { HINT_OPTIONS } from '../slack-activity-ops';
import { channelPatterns, hintsOf, isActivityMessage, matchesAny, messageActivity, SlackLookup } from '../slack-activity';
import { slackCall } from './slack';
import { asObject, asString, credentialsOf, DEFAULT_TOLERANCE_SECONDS, isBotEvent, rejectUnsigned, storedLookups, type TriggerStatic } from './slack-trigger';

const NOTICE =
  'Slack has no API to register an Events subscription. Publish the workflow, copy this node\'s Request URL from the editor\'s Publish menu (App webhooks) into the Slack app\'s ' +
  'Event Subscriptions page, and subscribe to the bot event message.channels (add message.groups, message.mpim and message.im only with Include Private Channels and DMs). ' +
  'Invite the app to the channels to watch. The credential\'s Signing Secret is required: Landflow verifies every call with it.';

/** Channel types of message events that are not public channels. */
const PRIVATE_TYPES = new Set(['group', 'im', 'mpim']);

interface ActivityStatic extends TriggerStatic {
  workspaceUrl: string;
}

/**
 * Messages people post in matching channels, as activity items (docs/protocol.md §16), from Slack's Events API: the
 * same Request URL setup and signature check as the Slack Trigger, one item per message. Edits, joins and other
 * non-messages are skipped; Message → Get Many Since on the Slack node catches up on what a pause missed.
 */
export const SlackActivityTrigger = defineNode({
  description: {
    name: 'slackActivityTrigger',
    displayName: 'Slack Activity Trigger',
    description: 'Starts the workflow when someone posts in a matching channel, with the message as an activity item (author email, permalink, customer and team hints)',
    version: 1,
    kind: 'trigger',
    triggerSource: 'appWebhook',
    categories: ['Communication'],
    icon: 'file:slack-trigger.svg',
    color: '#4A154B',
    subtitle: '{{channelNames}}',
    documentationUrl: 'https://docs.slack.dev/apis/events-api/',
    keywords: ['slack', 'trigger', 'activity', 'channel', 'message', 'customer', 'events api'],
    inputs: [],
    outputs: [{ type: 'main' }],
    outputSchema: ACTIVITY_ITEM_SCHEMA,
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
        name: 'channelNames',
        displayName: 'Channel Names',
        type: 'string',
        default: '*',
        required: true,
        placeholder: 'customer-*, proj-*',
        description: 'Messages in channels whose name matches one of these patterns (* any characters, ? one; comma-separated); * is every channel the app is in',
      },
      {
        name: 'includeReplies',
        displayName: 'Include Thread Replies',
        type: 'boolean',
        default: true,
        description: 'Whether replies in threads start a run too',
      },
      {
        name: 'includePrivate',
        displayName: 'Include Private Channels and DMs',
        type: 'boolean',
        default: false,
        description: 'Whether messages in private channels, group DMs and DMs the app is in start a run (subscribe to message.groups, message.mpim, message.im)',
      },
      {
        name: 'includeBots',
        displayName: 'Include Bot Messages',
        type: 'boolean',
        default: false,
        description: 'Whether messages from bots and integrations start a run (this app’s own never do)',
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          ...HINT_OPTIONS,
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
    ctx.logger.info('Slack sends events to the published workflow; a manual run has no event to output (Message → Get Many Since on the Slack node reads recent messages)');
    return [];
  },
  webhookMethods: {
    checkExists(ctx) {
      const data = ctx.getStaticData<ActivityStatic>();
      return Boolean(data.url) && data.url === ctx.getWebhookUrl();
    },
    async create(ctx) {
      const credentials = credentialsOf(ctx);
      if (!credentials.signingSecret?.trim()) {
        throw new NodeOperationError('The Slack credential has no Signing Secret', {
          description: 'Copy it from the Slack app\'s "Basic Information" page into the credential: Landflow verifies every Events API call with it.',
        });
      }
      if (channelPatterns(ctx.getNodeParameter('channelNames', '*')).length === 0) throw new NodeOperationError('Set Channel Names, e.g. customer-* (or * for every channel)');
      const auth = await ctx.span('slack.auth.test', {}, () =>
        slackCall<{ team_id?: string; user_id?: string; team?: string; url?: string }>({ http: ctx.http }, credentials, 'auth.test'),
      );
      ctx.setStaticData({ url: ctx.getWebhookUrl(), teamId: auth.team_id ?? '', botUserId: auth.user_id ?? '', workspaceUrl: auth.url ?? '' } satisfies ActivityStatic);
      ctx.logger.info(`Slack Activity Trigger ready for team ${auth.team ?? auth.team_id ?? 'unknown'}: paste the Request URL into the app's Event Subscriptions`, { url: ctx.getWebhookUrl() });
      return true;
    },
    delete(ctx) {
      ctx.setStaticData({});
      return true;
    },
  },
  async webhook(ctx) {
    const credentials = credentialsOf(ctx);
    const rejected = rejectUnsigned(ctx, credentials);
    if (rejected) return rejected;

    const body = ctx.getBody<JsonObject>();
    if (body?.type === 'url_verification') return { response: { status: 200, json: { challenge: String(body.challenge ?? '') } } };
    const event = asObject(body?.event);
    const ignored = (reason: string) => ({ response: { status: 200, json: { ignored: reason } } });
    if (body?.type !== 'event_callback' || !event) return ignored(String(body?.type ?? 'unknown'));
    if (event.type !== 'message') return ignored(String(event.type ?? 'unknown'));

    const includeBots = ctx.getNodeParameter<boolean>('includeBots', false) === true;
    if (!isActivityMessage(event, includeBots)) return ignored(String(event.subtype ?? (event.bot_id ? 'bot' : 'not a message')));
    const stored = ctx.getStaticData<ActivityStatic>();
    const own = new Set<string>([stored.botUserId].filter(Boolean));
    for (const entry of Array.isArray(body.authorizations) ? body.authorizations : []) {
      const authorization = asObject(entry);
      if (authorization?.is_bot === true && typeof authorization.user_id === 'string') own.add(authorization.user_id);
    }
    if (isBotEvent(event, own) && (!includeBots || own.has(String(event.user ?? '')))) return ignored('bot');

    const ts = asString(event.ts);
    const channelId = asString(event.channel);
    if (!ts || !channelId) return ignored('no channel');
    const threadTs = asString(event.thread_ts);
    if (threadTs && threadTs !== ts && ctx.getNodeParameter<boolean>('includeReplies', true) === false) return ignored('reply');
    const includePrivate = ctx.getNodeParameter<boolean>('includePrivate', false) === true;
    if (!includePrivate && PRIVATE_TYPES.has(String(event.channel_type ?? ''))) return ignored('private');

    const lookup = new SlackLookup({ http: ctx.http, metrics: ctx.metrics }, credentials, (m) => ctx.logger.warn(m), storedLookups(stored));
    const channel = await lookup.channel(channelId);
    if (!channel) return ignored('channel lookup failed');
    if (channel.private && !includePrivate) return ignored('private');
    const save = () => {
      if (lookup.changed) ctx.setStaticData({ ...ctx.getStaticData<ActivityStatic>(), lookups: lookup.cache });
    };
    if (!matchesAny(channel.name, channelPatterns(ctx.getNodeParameter('channelNames', '*')))) {
      save();
      return ignored('channel');
    }
    const email = await lookup.email(asString(event.user));
    save();
    const options = ctx.getNodeParameter<JsonObject>('options', {}) ?? {};
    const item = messageActivity({
      teamId: String(body.team_id ?? stored.teamId ?? ''),
      workspaceUrl: stored.workspaceUrl ?? '',
      channel,
      message: event,
      email,
      hints: hintsOf(options),
    });
    ctx.metrics.counter(METRICS.pollUpdates, { description: 'New updates found by polling triggers', unit: '{update}' }).add(1, { service: 'slack' });
    // Slack redelivers when it saw no answer within 3 s; the event id (and the item's stable sourceId) keep it to one run.
    return { items: [item], ...(typeof body.event_id === 'string' && { idempotencyKey: body.event_id }) };
  },
});
