import { defineCredentialType, defineNode, NodeOperationError, type JsonObject, type PropertyDescriptor } from '@landflow/sdk';
import { apiError, baseUrl, countSent, fetchJson, mapItems, requireString, unsupported, type ApiContext } from '../shared';

export interface TelegramCredentials extends JsonObject {
  accessToken: string;
  baseUrl: string;
}

const DEFAULT_BASE_URL = 'https://api.telegram.org';

interface TelegramResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

/** Hints for the errors people actually hit. */
function hint(status: number, description: string, retryAfter?: number): string | undefined {
  if (status === 401) return 'Telegram rejected the bot token. Copy it again from @BotFather.';
  if (status === 403) return 'The bot cannot write to this chat: it was blocked by the user, removed from the group, or never started by the user.';
  if (status === 400 && /chat not found/i.test(description)) {
    return 'Check the chat ID. A user has to message the bot first, and the bot must be a member of a group or an admin of a channel (@channelusername).';
  }
  if (status === 409 && /webhook/i.test(description)) {
    return 'This bot has a webhook set, so getUpdates (used by the Telegram Trigger) is unavailable. Delete the webhook with the deleteWebhook method, or use a separate bot for polling.';
  }
  if (status === 409)
    return 'Another process is polling this bot with getUpdates. Telegram allows one consumer at a time: stop the other poller or use a separate bot.';
  if (status === 429) return `Telegram rate limit reached${retryAfter ? `: retry after ${retryAfter} s` : ''}.`;
  return undefined;
}

/** POST {baseUrl}/bot{token}/{method}. The token sits in the URL path; ctx.http redacts it from spans and logs. */
export async function telegramCall<T = any>(api: ApiContext, credentials: TelegramCredentials, method: string, params: JsonObject = {}): Promise<T> {
  const url = `${baseUrl(credentials.baseUrl, DEFAULT_BASE_URL)}/bot${credentials.accessToken}/${method}`;
  const response = await fetchJson(api, 'telegram', 'Telegram', url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const body = response.body as TelegramResponse | undefined;
  if (response.ok && body?.ok) return body.result as T;
  const status = body?.error_code ?? response.status;
  const description = body?.description ?? (response.text.slice(0, 200) || `HTTP ${response.status}`);
  if (status === 409 && /webhook/i.test(description)) {
    throw apiError(
      api,
      'telegram',
      'Telegram',
      status,
      'this bot has a webhook set, so getUpdates is unavailable',
      `Telegram said: "${description}". ${hint(status, description)}`,
    );
  }
  throw apiError(api, 'telegram', 'Telegram', status, description, hint(status, description, body?.parameters?.retry_after));
}

export const telegramApi = defineCredentialType<TelegramCredentials>({
  name: 'telegramApi',
  displayName: 'Telegram API',
  icon: 'file:telegram.svg',
  documentationUrl: 'https://core.telegram.org/bots/features#botfather',
  properties: [
    {
      name: 'accessToken',
      displayName: 'Access Token',
      type: 'string',
      required: true,
      typeOptions: { password: true },
      placeholder: '123456789:ABCdefGhIJKlmnOPQ',
      description: 'The bot token @BotFather gives you with /newbot',
    },
    {
      name: 'baseUrl',
      displayName: 'Base URL',
      type: 'string',
      default: DEFAULT_BASE_URL,
      description: 'Change it for a local Bot API server or a test double',
    },
  ],
  async test(data, ctx) {
    try {
      const me = await telegramCall<{ username?: string; first_name?: string }>({ http: ctx.http }, data, 'getMe');
      return { ok: true, message: `Authenticated as @${me.username ?? me.first_name ?? 'unknown'}` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});

const show = (operation: string[]) => ({ show: { resource: ['message'], operation } });

const parseMode: PropertyDescriptor = {
  name: 'parse_mode',
  displayName: 'Parse Mode',
  type: 'options',
  default: 'HTML',
  options: [
    { name: 'Markdown (Legacy)', value: 'Markdown' },
    { name: 'MarkdownV2', value: 'MarkdownV2' },
    { name: 'HTML', value: 'HTML' },
  ],
  description: 'How Telegram formats the text',
};
const disableNotification: PropertyDescriptor = {
  name: 'disable_notification',
  displayName: 'Disable Notification',
  type: 'boolean',
  default: false,
  description: 'Send silently: users get a notification without sound',
};
const disableLinkPreview: PropertyDescriptor = {
  name: 'disable_web_page_preview',
  displayName: 'Disable WebPage Preview',
  type: 'boolean',
  default: false,
  description: 'Do not show a preview for links in the message',
};
const replyTo: PropertyDescriptor = {
  name: 'reply_to_message_id',
  displayName: 'Reply To Message ID',
  type: 'number',
  default: 0,
  description: 'Send the message as a reply to this message',
};

/** Additional Fields → Bot API parameters. */
function messageOptions(fields: JsonObject): JsonObject {
  const out: JsonObject = {};
  if (fields.parse_mode) out.parse_mode = String(fields.parse_mode);
  if (fields.disable_notification === true) out.disable_notification = true;
  if (fields.disable_web_page_preview === true) out.link_preview_options = { is_disabled: true };
  if (Number(fields.reply_to_message_id) > 0) out.reply_parameters = { message_id: Number(fields.reply_to_message_id), allow_sending_without_reply: true };
  if (typeof fields.caption === 'string' && fields.caption) out.caption = fields.caption;
  return out;
}

const CHAT_ACTIONS = [
  ['Find Location', 'find_location'],
  ['Record Audio', 'record_voice'],
  ['Record Video', 'record_video'],
  ['Record Video Note', 'record_video_note'],
  ['Typing', 'typing'],
  ['Upload Audio', 'upload_voice'],
  ['Upload Document', 'upload_document'],
  ['Upload Photo', 'upload_photo'],
  ['Upload Video', 'upload_video'],
  ['Upload Video Note', 'upload_video_note'],
  ['Choose Sticker', 'choose_sticker'],
].map(([name, value]) => ({ name, value }));

export const Telegram = defineNode({
  description: {
    name: 'telegram',
    displayName: 'Telegram',
    description: 'Send, edit and delete Telegram messages and photos, show chat actions and read chat details',
    version: 1,
    kind: 'action',
    categories: ['Communication'],
    icon: 'file:telegram.svg',
    color: '#229ED9',
    subtitle: '{{operation}}: {{resource}}',
    documentationUrl: 'https://core.telegram.org/bots/api',
    keywords: ['telegram', 'bot', 'chat', 'message'],
    usableAsTool: true,
    toolDescription:
      'Send a Telegram message or photo, edit or delete a message, show a chat action, or get chat details. Needs the numeric chat ID or @channelusername.',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'telegramApi', required: true }],
    properties: [
      {
        name: 'resource',
        displayName: 'Resource',
        type: 'options',
        noDataExpression: true,
        default: 'message',
        options: [
          { name: 'Chat', value: 'chat' },
          { name: 'Message', value: 'message' },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'get',
        displayOptions: { show: { resource: ['chat'] } },
        options: [{ name: 'Get', value: 'get', description: 'Get up-to-date information about a chat', action: 'Get a chat' }],
      },
      // The default resource's operation comes last: parameter defaults are keyed by name, last one wins.
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'sendMessage',
        displayOptions: { show: { resource: ['message'] } },
        options: [
          { name: 'Delete Chat Message', value: 'deleteMessage', action: 'Delete a chat message' },
          { name: 'Edit Message Text', value: 'editMessageText', action: 'Edit a text message' },
          { name: 'Send Chat Action', value: 'sendChatAction', description: 'Show "typing…" or another status in the chat', action: 'Send a chat action' },
          { name: 'Send Message', value: 'sendMessage', action: 'Send a text message' },
          { name: 'Send Photo', value: 'sendPhoto', action: 'Send a photo message' },
        ],
      },
      {
        name: 'chatId',
        displayName: 'Chat ID',
        type: 'string',
        required: true,
        default: '',
        placeholder: '-1001234567890 or @channelusername',
        description: 'Unique identifier of the chat, or the username of a channel (@channelusername)',
      },
      {
        name: 'messageId',
        displayName: 'Message ID',
        type: 'string',
        required: true,
        default: '',
        displayOptions: show(['deleteMessage', 'editMessageText']),
        description: 'Identifier of the message (message_id)',
      },
      {
        name: 'text',
        displayName: 'Text',
        type: 'string',
        required: true,
        default: '',
        typeOptions: { rows: 4 },
        displayOptions: show(['sendMessage', 'editMessageText']),
        description: 'Text of the message, 1-4096 characters',
      },
      {
        name: 'file',
        displayName: 'Photo',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'https://example.com/picture.jpg',
        displayOptions: show(['sendPhoto']),
        description: 'An HTTP URL Telegram downloads the photo from, or the file_id of a photo already on Telegram',
      },
      {
        name: 'action',
        displayName: 'Action',
        type: 'options',
        default: 'typing',
        displayOptions: show(['sendChatAction']),
        options: CHAT_ACTIONS,
        description: 'The status to show; it lasts 5 seconds or until the bot sends a message',
      },
      {
        name: 'additionalFields',
        displayName: 'Additional Fields',
        type: 'collection',
        default: {},
        placeholder: 'Add Field',
        displayOptions: show(['sendMessage']),
        values: [disableNotification, disableLinkPreview, parseMode, replyTo],
      },
      {
        name: 'additionalFields',
        displayName: 'Additional Fields',
        type: 'collection',
        default: {},
        placeholder: 'Add Field',
        displayOptions: show(['sendPhoto']),
        values: [{ name: 'caption', displayName: 'Caption', type: 'string', default: '', typeOptions: { rows: 2 } }, disableNotification, parseMode, replyTo],
      },
      {
        name: 'additionalFields',
        displayName: 'Additional Fields',
        type: 'collection',
        default: {},
        placeholder: 'Add Field',
        displayOptions: show(['editMessageText']),
        values: [disableLinkPreview, parseMode],
      },
    ],
  },
  async execute(ctx) {
    const credentials = ctx.getCredentials<TelegramCredentials>('telegramApi');
    const api: ApiContext = { http: ctx.http, metrics: ctx.metrics };
    return mapItems(ctx, async (i) => {
      const resource = ctx.getNodeParameter<string>('resource', i);
      const operation = ctx.getNodeParameter<string>('operation', i);
      const chat_id = requireString(ctx, 'chatId', 'Chat ID', i);
      const fields = ctx.getNodeParameter<JsonObject>('additionalFields', i, {}) ?? {};
      const messageId = () => {
        const id = Number(requireString(ctx, 'messageId', 'Message ID', i));
        if (!Number.isInteger(id)) throw new NodeOperationError('Message ID must be a number', { itemIndex: i });
        return id;
      };

      if (resource === 'chat') {
        if (operation !== 'get') throw unsupported(resource, operation);
        return telegramCall<JsonObject>(api, credentials, 'getChat', { chat_id });
      }
      if (resource !== 'message') throw unsupported(resource, operation);
      switch (operation) {
        case 'sendMessage': {
          const text = requireString(ctx, 'text', 'Text', i);
          const message = await telegramCall<JsonObject>(api, credentials, 'sendMessage', { chat_id, text, ...messageOptions(fields) });
          countSent(api, 'telegram', operation);
          return message;
        }
        case 'sendPhoto': {
          const photo = requireString(ctx, 'file', 'Photo', i);
          const message = await telegramCall<JsonObject>(api, credentials, 'sendPhoto', { chat_id, photo, ...messageOptions(fields) });
          countSent(api, 'telegram', operation);
          return message;
        }
        case 'editMessageText': {
          const text = requireString(ctx, 'text', 'Text', i);
          const { parse_mode, link_preview_options } = messageOptions(fields);
          const params: JsonObject = { chat_id, message_id: messageId(), text };
          if (parse_mode) params.parse_mode = parse_mode;
          if (link_preview_options) params.link_preview_options = link_preview_options;
          const result = await telegramCall<JsonObject | boolean>(api, credentials, 'editMessageText', params);
          return typeof result === 'object' ? result : { success: result };
        }
        case 'deleteMessage':
          await telegramCall(api, credentials, 'deleteMessage', { chat_id, message_id: messageId() });
          return { success: true };
        case 'sendChatAction':
          await telegramCall(api, credentials, 'sendChatAction', { chat_id, action: ctx.getNodeParameter<string>('action', i) });
          return { success: true };
        default:
          throw unsupported(resource, operation);
      }
    });
  },
});
