import { defineCredentialType, defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type PropertyDescriptor } from '@landflow/sdk';
import { apiError, baseUrl, countSent, fetchJson, ItemWithFiles, mapItems, requireString, unsupported, type ApiContext } from '../shared';

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
  return telegramPost<T>(api, credentials, method, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
}

/** The same call with a file: multipart/form-data, the file in `field` and the other parameters as form fields. */
export async function telegramUpload<T = any>(
  api: ApiContext,
  credentials: TelegramCredentials,
  method: string,
  params: JsonObject,
  field: string,
  file: { bytes: Uint8Array; fileName: string; mimeType: string },
): Promise<T> {
  const form = new FormData();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  form.append(field, new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }), file.fileName);
  // A big upload takes longer than a JSON call.
  return telegramPost<T>(api, credentials, method, { body: form, signal: AbortSignal.timeout(300_000) });
}

async function telegramPost<T>(api: ApiContext, credentials: TelegramCredentials, method: string, init: RequestInit): Promise<T> {
  const url = `${baseUrl(credentials.baseUrl, DEFAULT_BASE_URL)}/bot${credentials.accessToken}/${method}`;
  const response = await fetchJson(api, 'telegram', 'Telegram', url, { method: 'POST', ...init });
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

const show = (operation: string[], extra: Record<string, unknown[]> = {}) => ({ show: { resource: ['message'], operation, ...extra } });

const MB = 1024 * 1024;

/** Operations that send a file: a URL or file_id Telegram fetches, or an item file uploaded with the request. */
const FILE_OPERATIONS: Record<string, { field: string; label: string; maxBytes: number }> = {
  sendAudio: { field: 'audio', label: 'Audio', maxBytes: 50 * MB },
  sendDocument: { field: 'document', label: 'Document', maxBytes: 50 * MB },
  sendPhoto: { field: 'photo', label: 'Photo', maxBytes: 10 * MB },
  sendVideo: { field: 'video', label: 'Video', maxBytes: 50 * MB },
};
const SEND_FILE = Object.keys(FILE_OPERATIONS);

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

/** Send a photo, document, audio or video: a URL / file_id, or the item's file as a multipart upload. */
async function sendFile(ctx: IExecuteContext, api: ApiContext, credentials: TelegramCredentials, operation: string, i: number, params: JsonObject, fields: JsonObject) {
  const spec = FILE_OPERATIONS[operation];
  if (!ctx.getNodeParameter<boolean>('binaryData', i, false)) {
    return telegramCall<JsonObject>(api, credentials, operation, { ...params, [spec.field]: requireString(ctx, 'file', spec.label, i) });
  }
  const property = String(ctx.getNodeParameter('binaryPropertyName', i, 'data') || 'data').trim();
  const ref = ctx.helpers.assertBinaryData(i, property);
  if (ref.fileSize > spec.maxBytes && baseUrl(credentials.baseUrl, DEFAULT_BASE_URL) === DEFAULT_BASE_URL) {
    throw new NodeOperationError(`${ref.fileName ?? 'The file'} is too big for Telegram (${(ref.fileSize / MB).toFixed(1)} MB)`, {
      itemIndex: i,
      description: `The Bot API takes ${spec.label.toLowerCase()} uploads up to ${spec.maxBytes / MB} MB. A local Bot API server (the credential’s Base URL) takes up to 2000 MB.`,
    });
  }
  const bytes = await ctx.helpers.getBinaryDataBuffer(i, property);
  const fileName = String(fields.fileName ?? '').trim() || ref.fileName || `${property}.${ref.fileExtension ?? 'bin'}`;
  return telegramUpload<JsonObject>(api, credentials, operation, params, spec.field, { bytes, fileName, mimeType: ref.mimeType });
}

/** getFile, then the bytes from {baseUrl}/file/bot{token}/{file_path} into item.binary. */
async function getFile(ctx: IExecuteContext, api: ApiContext, credentials: TelegramCredentials, i: number): Promise<JsonObject | ItemWithFiles> {
  const file = await telegramCall<JsonObject>(api, credentials, 'getFile', { file_id: requireString(ctx, 'fileId', 'File ID', i) });
  if (!ctx.getNodeParameter<boolean>('download', i, true)) return file;
  const path = typeof file.file_path === 'string' ? file.file_path : '';
  if (!path) throw new NodeOperationError('Telegram gave no download path for this file', { itemIndex: i, description: 'The cloud Bot API lets bots download files up to 20 MB.' });
  const url = `${baseUrl(credentials.baseUrl, DEFAULT_BASE_URL)}/file/bot${credentials.accessToken}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const response = await fetchFile(api, url);
  const type = response.headers.get('content-type');
  const ref = await ctx.helpers.prepareBinaryData(response.body!, path.split('/').pop(), type && !/octet-stream/i.test(type) ? type : undefined);
  const property = String(ctx.getNodeParameter('binaryPropertyName', i, 'data') || 'data').trim();
  return new ItemWithFiles(file, { [property]: ref });
}

async function fetchFile(api: ApiContext, url: string): Promise<Response> {
  let response: Response;
  try {
    response = await api.http(url, { signal: AbortSignal.timeout(300_000) });
  } catch (error) {
    throw apiError(api, 'telegram', 'Telegram', undefined, `the file download failed: ${(error as Error).message}`, undefined, 'network');
  }
  if (!response.ok || !response.body) throw apiError(api, 'telegram', 'Telegram', response.status, 'the file download failed', response.status === 404 ? 'The file is no longer available; get a fresh file_id.' : undefined);
  return response;
}

export const Telegram = defineNode({
  description: {
    name: 'telegram',
    displayName: 'Telegram',
    description: 'Send, edit and delete Telegram messages, send photos, documents, audio and video (URLs or item files), download files and read chat details',
    version: 1,
    kind: 'action',
    categories: ['Communication'],
    icon: 'file:telegram.svg',
    color: '#229ED9',
    subtitle: '{{operation}}: {{resource}}',
    documentationUrl: 'https://core.telegram.org/bots/api',
    keywords: ['telegram', 'bot', 'chat', 'message', 'document', 'file', 'upload', 'attachment'],
    usableAsTool: true,
    // Sends, posts and edits are at most once over a broker; read operations opt back in with `idempotent: true`.
    idempotent: false,
    toolDescription:
      'Send a Telegram message, photo, document, audio or video, edit or delete a message, show a chat action, or get chat details. Needs the numeric chat ID or @channelusername.',
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
          { name: 'File', value: 'file' },
          { name: 'Message', value: 'message' },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'get',
        displayOptions: { show: { resource: ['file'] } },
        options: [{ name: 'Get', value: 'get', description: 'Get a file’s details and download it into the item', action: 'Get a file', idempotent: true }],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'get',
        displayOptions: { show: { resource: ['chat'] } },
        options: [{ name: 'Get', value: 'get', description: 'Get up-to-date information about a chat', action: 'Get a chat', idempotent: true }],
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
          { name: 'Send Audio', value: 'sendAudio', action: 'Send an audio file' },
          { name: 'Send Chat Action', value: 'sendChatAction', description: 'Show "typing…" or another status in the chat', action: 'Send a chat action' },
          { name: 'Send Document', value: 'sendDocument', description: 'Any file (PDF, CSV, ZIP…)', action: 'Send a document' },
          { name: 'Send Message', value: 'sendMessage', action: 'Send a text message' },
          { name: 'Send Photo', value: 'sendPhoto', action: 'Send a photo message' },
          { name: 'Send Video', value: 'sendVideo', action: 'Send a video' },
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
        displayOptions: { show: { resource: ['chat', 'message'] } },
      },
      {
        name: 'fileId',
        displayName: 'File ID',
        type: 'string',
        required: true,
        default: '',
        displayOptions: { show: { resource: ['file'] } },
        description: 'The file_id of a document, photo, voice note… (from the Telegram Trigger or a sent message)',
      },
      {
        name: 'download',
        displayName: 'Download',
        type: 'boolean',
        default: true,
        displayOptions: { show: { resource: ['file'] } },
        description: 'Put the file in item.binary (the cloud Bot API serves files up to 20 MB); off: only its details',
      },
      {
        name: 'binaryPropertyName',
        displayName: 'Put Output File in Field',
        type: 'string',
        default: 'data',
        displayOptions: { show: { resource: ['file'], download: [true] } },
      },
      {
        name: 'binaryData',
        displayName: 'Binary File',
        type: 'boolean',
        default: false,
        displayOptions: show(SEND_FILE),
        description: 'Upload a file of the input item instead of sending a URL or file_id',
      },
      {
        name: 'binaryPropertyName',
        displayName: 'Input Binary Field',
        type: 'string',
        required: true,
        default: 'data',
        displayOptions: show(SEND_FILE, { binaryData: [true] }),
        description: 'The item file to upload (item.binary.<name>)',
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
        displayOptions: show(['sendPhoto'], { binaryData: [false] }),
        description: 'An HTTP URL Telegram downloads the photo from, or the file_id of a photo already on Telegram',
      },
      ...(['sendAudio', 'sendDocument', 'sendVideo'] as const).map(
        (operation): PropertyDescriptor => ({
          name: 'file',
          displayName: FILE_OPERATIONS[operation].label,
          type: 'string',
          required: true,
          default: '',
          placeholder: 'https://example.com/file',
          displayOptions: show([operation], { binaryData: [false] }),
          description: 'An HTTP URL Telegram downloads the file from, or the file_id of a file already on Telegram',
        }),
      ),
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
        displayOptions: show(SEND_FILE),
        values: [
          { name: 'caption', displayName: 'Caption', type: 'string', default: '', typeOptions: { rows: 2 } },
          disableNotification,
          { name: 'fileName', displayName: 'File Name', type: 'string', default: '', description: 'For an uploaded item file (default: its own name)' },
          parseMode,
          replyTo,
        ],
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
      if (resource === 'file') {
        if (operation !== 'get') throw unsupported(resource, operation);
        return getFile(ctx, api, credentials, i);
      }
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
        case 'sendAudio':
        case 'sendDocument':
        case 'sendPhoto':
        case 'sendVideo': {
          const message = await sendFile(ctx, api, credentials, operation, i, { chat_id, ...messageOptions(fields) }, fields);
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
