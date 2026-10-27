import { defineCredentialType, defineNode, NodeOperationError, registerSecrets, type IExecuteContext, type JsonObject, type JsonValue, type PropertyOption } from '@landflow/sdk';
import {
  apiError,
  baseUrl,
  countApiError,
  countSent,
  fetchJson,
  jsonParameter,
  mapItems,
  oauth2Hidden,
  pickCredentials,
  requireString,
  sleep,
  unsupported,
  type ApiContext,
  type ApiResponse,
} from '../shared';

export interface DiscordBotCredentials extends JsonObject {
  /** Bot API credential: always set. OAuth2 credential: empty unless entered, for the calls only a bot can make. */
  botToken: string;
  /** OAuth2 credential: the user's access token from Connect (fresh on every call); absent on the bot credential. */
  accessToken: string;
  baseUrl: string;
}

export interface DiscordWebhookCredentials extends JsonObject {
  webhookUrl: string;
}

const DEFAULT_BASE_URL = 'https://discord.com/api/v10';
/** A 429 asking to wait longer than this fails right away instead of holding the execution. */
const MAX_RETRY_WAIT_S = 10;

/**
 * One call with Discord's rate-limit rule: a 429 carries `retry_after` (seconds);
 * wait that long and retry once.
 */
async function discordFetch(api: ApiContext, url: string, init: RequestInit): Promise<ApiResponse> {
  const response = await fetchJson(api, 'discord', 'Discord', url, init);
  if (response.status !== 429) return response;
  const retryAfter = Number(response.body?.retry_after ?? response.headers.get('retry-after') ?? 1);
  if (!(retryAfter >= 0 && retryAfter <= MAX_RETRY_WAIT_S)) return response;
  countApiError(api, 'discord', '4xx');
  await sleep(Math.ceil(retryAfter * 1000));
  return fetchJson(api, 'discord', 'Discord', url, init);
}

/** Discord's error body: `{ message, code, errors? }`; `errors` details invalid form fields. */
function discordError(api: ApiContext, response: ApiResponse) {
  const body = response.body as { message?: string; code?: number; errors?: JsonValue; retry_after?: number } | undefined;
  const detail = body?.message ? `${body.message}${body.code ? ` (code ${body.code})` : ''}` : response.text.slice(0, 200) || `HTTP ${response.status}`;
  let description: string | undefined;
  if (response.status === 401) description = 'Discord rejected the token. Copy the bot token again from the Developer Portal (Bot → Reset Token).';
  else if (response.status === 403)
    description =
      'The bot lacks access: invite it to the server and give it View Channel, Send Messages (and Add Reactions / Manage Messages) in this channel.';
  else if (response.status === 429) description = `Discord rate limit still active${body?.retry_after ? `: retry after ${body.retry_after} s` : ''}.`;
  else if (body?.errors) description = JSON.stringify(body.errors).slice(0, 500);
  return apiError(api, 'discord', 'Discord', response.status, detail, description);
}

interface UploadFile {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
}

/** A JSON body, or with files multipart/form-data: `payload_json` plus `files[n]` (attachments[] ties each to a file name). */
function requestBody(body: JsonObject | undefined, files: UploadFile[] = []): { headers: Record<string, string>; body?: BodyInit } {
  if (!body) return { headers: {} };
  if (!files.length) return { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const form = new FormData();
  const attachments = files.map((file, id) => ({ id, filename: file.fileName }));
  form.append('payload_json', JSON.stringify({ ...body, attachments }));
  files.forEach((file, id) => form.append(`files[${id}]`, new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }), file.fileName));
  return { headers: {}, body: form };
}

/** The item's files named by the Attachments option (comma-separated binary properties). */
async function uploadFiles(ctx: IExecuteContext, options: JsonObject, i: number): Promise<UploadFile[]> {
  const files: UploadFile[] = [];
  for (const property of [...new Set(String(options.attachments ?? '').split(',').map((n) => n.trim()).filter(Boolean))]) {
    const ref = ctx.helpers.assertBinaryData(i, property);
    const bytes = await ctx.helpers.getBinaryDataBuffer(i, property);
    files.push({ bytes, fileName: ref.fileName || `${property}.${ref.fileExtension ?? 'bin'}`, mimeType: ref.mimeType });
  }
  if (files.length > 10) throw new NodeOperationError('Discord takes at most 10 files per message', { itemIndex: i });
  return files;
}

async function botCall<T = any>(api: ApiContext, credentials: DiscordBotCredentials, method: string, path: string, body?: JsonObject, files?: UploadFile[]): Promise<T> {
  const payload = requestBody(body, files);
  const response = await discordFetch(api, `${baseUrl(credentials.baseUrl, DEFAULT_BASE_URL)}${path}`, {
    method,
    headers: { authorization: credentials.botToken ? `Bot ${credentials.botToken}` : `Bearer ${credentials.accessToken}`, ...payload.headers },
    ...(payload.body && { body: payload.body }),
    ...(files?.length && { signal: AbortSignal.timeout(300_000) }),
  });
  if (!response.ok) throw discordError(api, response);
  return response.body as T;
}

/**
 * Calls a webhook URL (…/webhooks/{id}/{token}). The whole URL is a secret the SDK
 * redacts; the token segment is registered too, so it never shows up in a span or
 * log even when the URL carries extra query parameters.
 */
async function webhookCall<T = any>(api: ApiContext, credentials: DiscordWebhookCredentials, method: string, body?: JsonObject, files?: UploadFile[]): Promise<T> {
  let url: URL;
  try {
    url = new URL(String(credentials.webhookUrl ?? '').trim());
  } catch {
    throw new NodeOperationError('The Discord webhook URL is not a valid URL');
  }
  const release = registerSecrets(url.pathname.split('/').filter(Boolean).slice(-1));
  try {
    if (method === 'POST') url.searchParams.set('wait', 'true');
    const payload = requestBody(body, files);
    const response = await discordFetch(api, url.toString(), {
      method,
      ...(payload.body && { headers: payload.headers, body: payload.body }),
      ...(files?.length && { signal: AbortSignal.timeout(300_000) }),
    });
    if (!response.ok) throw discordError(api, response);
    return response.body as T;
  } finally {
    release();
  }
}

export const discordBotApi = defineCredentialType<DiscordBotCredentials>({
  name: 'discordBotApi',
  displayName: 'Discord Bot API',
  icon: 'file:discord.svg',
  documentationUrl: 'https://discord.com/developers/docs/topics/oauth2#bots',
  properties: [
    {
      name: 'botToken',
      displayName: 'Bot Token',
      type: 'string',
      required: true,
      typeOptions: { password: true },
      description: 'Developer Portal → your application → Bot → Reset Token',
    },
    { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: DEFAULT_BASE_URL, description: 'Change it only for a proxy or a test double' },
  ],
  async test(data, ctx) {
    try {
      const me = await botCall<{ username?: string }>({ http: ctx.http }, data, 'GET', '/users/@me');
      return { ok: true, message: `Authenticated as ${me.username ?? 'unknown'}` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});

/**
 * Discord OAuth2: extends the host's generic OAuth2 type. Connect signs a Discord user in (scopes `identify guilds`),
 * the host sends the user's `accessToken`, refreshed before it expires. Discord lets only bots post to channels, so
 * the optional Bot Token is what channel calls use; without it the node sends the access token as a Bearer, which
 * covers the user-level reads (Guilds).
 */
export const discordOAuth2Api = defineCredentialType<DiscordBotCredentials>({
  name: 'discordOAuth2Api',
  displayName: 'Discord OAuth2 API',
  icon: 'file:discord.svg',
  documentationUrl: 'https://discord.com/developers/docs/topics/oauth2',
  description:
    'Sign in with Discord: add the redirect URL shown below under OAuth2 in your application, then Connect. Add a Bot Token to message channels, which only bots can do.',
  extends: ['oAuth2Api'],
  properties: [
    oauth2Hidden('grantType', 'Grant Type', 'pkce'),
    oauth2Hidden('authUrl', 'Authorization URL', 'https://discord.com/oauth2/authorize'),
    oauth2Hidden('accessTokenUrl', 'Access Token URL', 'https://discord.com/api/oauth2/token'),
    oauth2Hidden('authentication', 'Client Authentication', 'body'),
    oauth2Hidden('userInfoUrl', 'User Info URL', 'https://discord.com/api/users/@me'),
    { name: 'scope', displayName: 'Scope', type: 'string', default: 'identify guilds', description: 'Space-separated scopes asked for at Connect' },
    {
      name: 'botToken',
      displayName: 'Bot Token (optional)',
      type: 'string',
      default: '',
      typeOptions: { password: true },
      description: 'Developer Portal → your application → Bot → Reset Token. Needed to send, list, delete and react to messages.',
    },
    { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: DEFAULT_BASE_URL, description: 'Change it only for a proxy or a test double' },
  ],
  async test(data, ctx) {
    try {
      const me = await botCall<{ username?: string }>({ http: ctx.http }, data, 'GET', '/users/@me');
      return { ok: true, message: `Authenticated as ${me.username ?? 'unknown'}` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});

/** The node's Discord credential: bot token or OAuth2, by the Connection Type (else whichever was sent). */
const discordCredentials = (ctx: { getCredentials: IExecuteContext['getCredentials'] }, authentication?: unknown) =>
  pickCredentials<DiscordBotCredentials>(ctx, authentication, 'discordBotApi', 'discordOAuth2Api');

export const discordWebhookApi = defineCredentialType<DiscordWebhookCredentials>({
  name: 'discordWebhookApi',
  displayName: 'Discord Webhook',
  icon: 'file:discord.svg',
  documentationUrl: 'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks',
  properties: [
    {
      name: 'webhookUrl',
      displayName: 'Webhook URL',
      type: 'string',
      required: true,
      typeOptions: { password: true },
      placeholder: 'https://discord.com/api/webhooks/123456789/abcDEF…',
      description: 'Channel settings → Integrations → Webhooks → Copy Webhook URL. The URL contains its own token',
    },
  ],
  async test(data, ctx) {
    try {
      const hook = await webhookCall<{ name?: string; channel_id?: string }>({ http: ctx.http }, data, 'GET');
      return { ok: true, message: `Webhook "${hook.name ?? 'unknown'}" posts to channel ${hook.channel_id ?? 'unknown'}` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});

function embedsParameter(value: unknown): JsonValue[] | undefined {
  const parsed = jsonParameter(value, 'Embeds');
  if (parsed === undefined) return undefined;
  const embeds = Array.isArray(parsed) ? parsed : [parsed];
  if (embeds.some((e) => typeof e !== 'object' || e === null || Array.isArray(e)))
    throw new NodeOperationError('Embeds must be a JSON object or an array of embed objects');
  return embeds;
}

function simplifyMessage(message: JsonObject): JsonObject {
  const author = (message.author ?? {}) as JsonObject;
  return {
    id: message.id,
    channel_id: message.channel_id,
    content: message.content ?? '',
    author_id: author.id ?? null,
    author: author.global_name ?? author.username ?? null,
    timestamp: message.timestamp ?? null,
    edited_timestamp: message.edited_timestamp ?? null,
    attachments: Array.isArray(message.attachments) ? message.attachments.length : 0,
    embeds: Array.isArray(message.embeds) ? message.embeds.length : 0,
  };
}

/** Channel types a bot can post plain messages to: text, voice text chat, announcement. */
const MESSAGE_CHANNEL_TYPES = new Set([0, 2, 5]);
const PAGE_SIZE = 100;

const bot = (operation: string[]) => ({ show: { authentication: ['botToken', 'oAuth2'], resource: ['message'], operation } });

export const Discord = defineNode({
  description: {
    name: 'discord',
    displayName: 'Discord',
    description: 'Send, list, delete and react to Discord messages with a bot, or post through a channel webhook',
    version: 1,
    kind: 'action',
    categories: ['Communication'],
    icon: 'file:discord.svg',
    color: '#5865F2',
    subtitle: '{{operation}}: {{resource}}',
    documentationUrl: 'https://discord.com/developers/docs/resources/message',
    keywords: ['discord', 'chat', 'message', 'webhook', 'bot'],
    usableAsTool: true,
    // Sends, posts and edits are at most once over a broker; read operations opt back in with `idempotent: true`.
    idempotent: false,
    toolDescription: 'Send a Discord message (bot or webhook), list recent messages in a channel, delete a message, or react with an emoji.',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [
      { name: 'discordBotApi', required: true, displayOptions: { show: { authentication: ['botToken'] } } },
      { name: 'discordOAuth2Api', required: true, displayOptions: { show: { authentication: ['oAuth2'] } } },
      { name: 'discordWebhookApi', required: true, displayOptions: { show: { authentication: ['webhook'] } } },
    ],
    properties: [
      {
        name: 'authentication',
        displayName: 'Connection Type',
        type: 'options',
        noDataExpression: true,
        default: 'botToken',
        options: [
          { name: 'Bot Token', value: 'botToken', description: 'Manage messages in any channel the bot can see' },
          { name: 'OAuth2', value: 'oAuth2', description: 'Connect with Discord; add a bot token to message channels' },
          { name: 'Webhook', value: 'webhook', description: 'Post to one channel through its webhook URL' },
        ],
      },
      {
        name: 'resource',
        displayName: 'Resource',
        type: 'options',
        noDataExpression: true,
        default: 'message',
        options: [{ name: 'Message', value: 'message' }],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'send',
        displayOptions: { show: { authentication: ['webhook'], resource: ['message'] } },
        options: [{ name: 'Send', value: 'send', description: 'Send a message through the webhook', action: 'Send a message' }],
      },
      // The default connection type's operation comes last: parameter defaults are keyed by name, last one wins.
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'send',
        displayOptions: { show: { authentication: ['botToken', 'oAuth2'], resource: ['message'] } },
        options: [
          { name: 'Delete', value: 'deleteMessage', action: 'Delete a message' },
          { name: 'Get Many', value: 'getAll', description: 'Retrieve the latest messages in a channel', action: 'Get many messages', idempotent: true },
          { name: 'React with Emoji', value: 'react', action: 'React to a message with an emoji' },
          { name: 'Send', value: 'send', action: 'Send a message' },
        ],
      },
      {
        name: 'guildId',
        displayName: 'Server',
        type: 'options',
        default: '',
        typeOptions: { loadOptionsMethod: 'getGuilds' },
        displayOptions: { show: { authentication: ['botToken', 'oAuth2'] } },
        description: 'The server whose channels are listed below',
      },
      {
        name: 'channelId',
        displayName: 'Channel',
        type: 'options',
        required: true,
        default: '',
        typeOptions: { loadOptionsMethod: 'getChannels', loadOptionsDependsOn: ['guildId'] },
        displayOptions: { show: { authentication: ['botToken', 'oAuth2'] } },
        description: 'Pick a channel of the server, or set a channel ID with an expression',
      },
      {
        name: 'messageId',
        displayName: 'Message ID',
        type: 'string',
        required: true,
        default: '',
        displayOptions: bot(['deleteMessage', 'react']),
      },
      {
        name: 'emoji',
        displayName: 'Emoji',
        type: 'string',
        required: true,
        default: '',
        placeholder: '👍 or custom_name:123456789012345678',
        displayOptions: bot(['react']),
        description: 'A Unicode emoji, or name:id for a custom emoji',
      },
      {
        name: 'content',
        displayName: 'Message',
        type: 'string',
        default: '',
        typeOptions: { rows: 3 },
        displayOptions: { show: { resource: ['message'], operation: ['send'] } },
        description: 'Up to 2000 characters. Optional when embeds are set',
      },
      {
        name: 'embeds',
        displayName: 'Embeds',
        type: 'json',
        default: '',
        typeOptions: { rows: 6 },
        displayOptions: { show: { resource: ['message'], operation: ['send'] } },
        description: 'Optional embed objects as JSON: one object or an array of up to 10',
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: bot(['send']),
        values: [
          { name: 'tts', displayName: 'Text-to-Speech', type: 'boolean', default: false },
          {
            name: 'attachments',
            displayName: 'Attachments',
            type: 'string',
            default: '',
            placeholder: 'data, chart',
            description: 'Comma-separated names of the item’s binary properties to upload with the message (up to 10 files, 25 MB in total on most servers)',
          },
          {
            name: 'replyTo',
            displayName: 'Reply To Message ID',
            type: 'string',
            default: '',
            description: 'Send as a reply to this message in the same channel',
          },
        ],
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: { show: { authentication: ['webhook'], operation: ['send'] } },
        values: [
          { name: 'username', displayName: 'Username', type: 'string', default: '', description: "Override the webhook's default name" },
          { name: 'avatar_url', displayName: 'Avatar URL', type: 'string', default: '', description: "Override the webhook's default avatar" },
          { name: 'tts', displayName: 'Text-to-Speech', type: 'boolean', default: false },
          {
            name: 'attachments',
            displayName: 'Attachments',
            type: 'string',
            default: '',
            placeholder: 'data, chart',
            description: 'Comma-separated names of the item’s binary properties to upload with the message (up to 10 files, 25 MB in total on most servers)',
          },
        ],
      },
      {
        name: 'returnAll',
        displayName: 'Return All',
        type: 'boolean',
        default: false,
        displayOptions: bot(['getAll']),
        description: 'Whether to return all messages or only up to a limit',
      },
      {
        name: 'limit',
        displayName: 'Limit',
        type: 'number',
        default: 50,
        typeOptions: { minValue: 1, numberPrecision: 0 },
        displayOptions: { show: { authentication: ['botToken', 'oAuth2'], operation: ['getAll'], returnAll: [false] } },
        description: 'Max number of results to return',
      },
      {
        name: 'simplify',
        displayName: 'Simplify',
        type: 'boolean',
        default: true,
        displayOptions: bot(['getAll']),
        description: 'Whether to return a few flat fields instead of the raw Discord message',
      },
    ],
  },
  methods: {
    loadOptions: {
      async getGuilds(ctx): Promise<PropertyOption[]> {
        const guilds = await botCall<JsonObject[]>({ http: ctx.http }, discordCredentials(ctx), 'GET', '/users/@me/guilds');
        return guilds.map((g) => ({ name: String(g.name), value: String(g.id) })).sort((a, b) => a.name.localeCompare(b.name));
      },
      async getChannels(ctx): Promise<PropertyOption[]> {
        const guildId = String(ctx.getNodeParameter('guildId', '') ?? '');
        if (!guildId) return [];
        const credentials = discordCredentials(ctx);
        const channels = await botCall<JsonObject[]>({ http: ctx.http }, credentials, 'GET', `/guilds/${encodeURIComponent(guildId)}/channels`);
        return channels
          .filter((c) => MESSAGE_CHANNEL_TYPES.has(Number(c.type)))
          .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
          .map((c) => ({ name: `#${c.name}`, value: String(c.id) }));
      },
    },
  },
  async execute(ctx) {
    const authentication = ctx.getNodeParameter<string>('authentication', 0, 'botToken');
    const api: ApiContext = { http: ctx.http, metrics: ctx.metrics };

    if (authentication === 'webhook') {
      const credentials = ctx.getCredentials<DiscordWebhookCredentials>('discordWebhookApi');
      return mapItems(ctx, async (i) => {
        const operation = ctx.getNodeParameter<string>('operation', i);
        if (operation !== 'send') throw unsupported('message', operation);
        const content = String(ctx.getNodeParameter('content', i, '') ?? '');
        const embeds = embedsParameter(ctx.getNodeParameter('embeds', i, ''));
        const options = ctx.getNodeParameter<JsonObject>('options', i, {}) ?? {};
        const files = await uploadFiles(ctx, options, i);
        if (!content && !embeds && !files.length) throw new NodeOperationError('Set Message or Embeds', { itemIndex: i });
        const body: JsonObject = { content, ...(embeds && { embeds }) };
        if (options.username) body.username = String(options.username);
        if (options.avatar_url) body.avatar_url = String(options.avatar_url);
        if (options.tts === true) body.tts = true;
        const message = await webhookCall<JsonObject>(api, credentials, 'POST', body, files);
        countSent(api, 'discord', 'webhookSend');
        return message;
      });
    }

    const credentials = discordCredentials(ctx, authentication);
    return mapItems(ctx, async (i) => {
      const resource = ctx.getNodeParameter<string>('resource', i);
      const operation = ctx.getNodeParameter<string>('operation', i);
      if (resource !== 'message') throw unsupported(resource, operation);
      const channel = encodeURIComponent(requireString(ctx, 'channelId', 'Channel', i));
      const messageId = () => encodeURIComponent(requireString(ctx, 'messageId', 'Message ID', i));

      switch (operation) {
        case 'send': {
          const content = String(ctx.getNodeParameter('content', i, '') ?? '');
          const embeds = embedsParameter(ctx.getNodeParameter('embeds', i, ''));
          const options = ctx.getNodeParameter<JsonObject>('options', i, {}) ?? {};
          const files = await uploadFiles(ctx, options, i);
          if (!content && !embeds && !files.length) throw new NodeOperationError('Set Message or Embeds', { itemIndex: i });
          const body: JsonObject = { content, ...(embeds && { embeds }) };
          if (options.tts === true) body.tts = true;
          if (options.replyTo) body.message_reference = { message_id: String(options.replyTo), fail_if_not_exists: false };
          const message = await botCall<JsonObject>(api, credentials, 'POST', `/channels/${channel}/messages`, body, files);
          countSent(api, 'discord', operation);
          return message;
        }
        case 'getAll': {
          const returnAll = ctx.getNodeParameter<boolean>('returnAll', i, false);
          const limit = returnAll ? Infinity : Math.max(1, Number(ctx.getNodeParameter('limit', i, 50)) || 50);
          const messages: JsonObject[] = [];
          let before: string | undefined;
          // Newest first; `before` pages back through the history.
          while (messages.length < limit) {
            const size = Math.min(PAGE_SIZE, limit - messages.length);
            const page = await botCall<JsonObject[]>(
              api,
              credentials,
              'GET',
              `/channels/${channel}/messages?limit=${size}${before ? `&before=${before}` : ''}`,
            );
            messages.push(...page);
            if (page.length < size) break;
            before = String(page[page.length - 1].id);
          }
          const simplify = ctx.getNodeParameter<boolean>('simplify', i, true);
          return messages.slice(0, limit).map((m) => (simplify ? simplifyMessage(m) : m));
        }
        case 'deleteMessage':
          await botCall(api, credentials, 'DELETE', `/channels/${channel}/messages/${messageId()}`);
          return { success: true };
        case 'react': {
          const emoji = requireString(ctx, 'emoji', 'Emoji', i).replace(/^<a?:|>$/g, '');
          await botCall(api, credentials, 'PUT', `/channels/${channel}/messages/${messageId()}/reactions/${encodeURIComponent(emoji)}/@me`);
          return { success: true };
        }
        default:
          throw unsupported(resource, operation);
      }
    });
  },
});
