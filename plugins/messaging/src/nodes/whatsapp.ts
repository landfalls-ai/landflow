import { defineCredentialType, defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type PropertyOption } from '@landflow/sdk';
import { apiError, baseUrl, countSent, fetchJson, ItemWithFiles, jsonParameter, mapItems, requireString, unsupported, type ApiContext } from '../shared';

export interface WhatsAppCredentials extends JsonObject {
  accessToken: string;
  businessAccountId: string;
  baseUrl: string;
}

const DEFAULT_BASE_URL = 'https://graph.facebook.com/v21.0';

interface GraphError {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_data?: { details?: string };
}

function hint(status: number, error: GraphError | undefined): string | undefined {
  if (error?.error_data?.details) return error.error_data.details;
  if (status === 401 || error?.code === 190) return 'The access token is invalid or expired. Use a permanent System User token from Business Settings.';
  if (error?.code === 131030) return "In development mode the recipient must be in the phone number's allowed list (WhatsApp Manager → API Setup).";
  if (error?.code === 131047) return 'More than 24 hours passed since the user last wrote: only an approved template message can be sent.';
  return undefined;
}

/** Graph API call; errors arrive as `{ error: { message, code, error_data } }`. */
async function graphCall<T = any>(api: ApiContext, credentials: WhatsAppCredentials, method: string, path: string, body?: JsonObject): Promise<T> {
  return graphResponse<T>(api, credentials, method, path, body && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

async function graphResponse<T>(api: ApiContext, credentials: WhatsAppCredentials, method: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetchJson(api, 'whatsapp', 'WhatsApp', `${baseUrl(credentials.baseUrl, DEFAULT_BASE_URL)}${path}`, {
    method,
    ...init,
    headers: { authorization: `Bearer ${credentials.accessToken}`, ...(init.headers as Record<string, string> | undefined) },
  });
  if (response.ok && response.body !== undefined) return response.body as T;
  const error = response.body?.error as GraphError | undefined;
  const detail = error?.message ? `${error.message}${error.code ? ` (code ${error.code})` : ''}` : response.text.slice(0, 200) || `HTTP ${response.status}`;
  throw apiError(api, 'whatsapp', 'WhatsApp', response.status, detail, hint(response.status, error));
}

/** POST /{phone-number-id}/media: the item's file as multipart/form-data; answers `{ id }`, the media ID to send by. */
async function uploadMedia(ctx: IExecuteContext, api: ApiContext, credentials: WhatsAppCredentials, sender: string, i: number): Promise<{ id: string; fileName: string; mimeType: string }> {
  const property = String(ctx.getNodeParameter('binaryPropertyName', i, 'data') || 'data').trim();
  const ref = ctx.helpers.assertBinaryData(i, property);
  const bytes = await ctx.helpers.getBinaryDataBuffer(i, property);
  const fileName = ref.fileName || `${property}.${ref.fileExtension ?? 'bin'}`;
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', ref.mimeType);
  form.append('file', new Blob([new Uint8Array(bytes)], { type: ref.mimeType }), fileName);
  const result = await graphResponse<JsonObject>(api, credentials, 'POST', `/${encodeURIComponent(sender)}/media`, { body: form, signal: AbortSignal.timeout(300_000) });
  if (typeof result.id !== 'string') throw new NodeOperationError('WhatsApp returned no media ID for the upload', { itemIndex: i });
  return { id: result.id, fileName, mimeType: ref.mimeType };
}

/** GET /{media-id} for the temporary URL, then the bytes from it (the URL needs the access token too) into item.binary. */
async function downloadMedia(ctx: IExecuteContext, api: ApiContext, credentials: WhatsAppCredentials, i: number): Promise<ItemWithFiles | JsonObject> {
  const mediaId = requireString(ctx, 'mediaId', 'Media ID', i);
  const info = await graphCall<JsonObject>(api, credentials, 'GET', `/${encodeURIComponent(mediaId)}`);
  if (!ctx.getNodeParameter<boolean>('download', i, true)) return info;
  if (typeof info.url !== 'string') throw new NodeOperationError('WhatsApp returned no download URL for this media', { itemIndex: i, description: 'Media IDs expire after 30 days; the URL itself after 5 minutes.' });
  let response: Response;
  try {
    response = await api.http(info.url, { headers: { authorization: `Bearer ${credentials.accessToken}` }, signal: AbortSignal.timeout(300_000) });
  } catch (error) {
    throw apiError(api, 'whatsapp', 'WhatsApp', undefined, `the media download failed: ${(error as Error).message}`, undefined, 'network');
  }
  if (!response.ok || !response.body) throw apiError(api, 'whatsapp', 'WhatsApp', response.status, 'the media download failed', response.status === 404 ? 'The media was deleted or expired; ask for a fresh media ID.' : undefined);
  const mimeType = typeof info.mime_type === 'string' ? info.mime_type : response.headers.get('content-type') || undefined;
  const extension = mimeType ? EXTENSIONS[mimeType.split(';')[0].trim()] : undefined;
  const ref = await ctx.helpers.prepareBinaryData(response.body, extension ? `${mediaId}.${extension}` : mediaId, mimeType);
  const property = String(ctx.getNodeParameter('binaryPropertyName', i, 'data') || 'data').trim();
  return new ItemWithFiles(info, { [property]: ref });
}

/** File name extensions for the types the Cloud API supports (the download carries no file name). */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/aac': 'aac', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/amr': 'amr',
  'audio/ogg': 'ogg', 'video/mp4': 'mp4', 'video/3gpp': '3gp', 'application/pdf': 'pdf', 'text/plain': 'txt',
  'application/msword': 'doc', 'application/vnd.ms-excel': 'xls', 'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

function phoneNumbers(api: ApiContext, credentials: WhatsAppCredentials) {
  const account = String(credentials.businessAccountId ?? '').trim();
  if (!account) throw new NodeOperationError('The WhatsApp credential has no Business Account ID');
  return graphCall<{ data?: JsonObject[] }>(
    api,
    credentials,
    'GET',
    `/${encodeURIComponent(account)}/phone_numbers?fields=id,display_phone_number,verified_name`,
  );
}

export const whatsAppApi = defineCredentialType<WhatsAppCredentials>({
  name: 'whatsAppApi',
  displayName: 'WhatsApp API',
  icon: 'file:whatsapp.svg',
  documentationUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started',
  properties: [
    {
      name: 'accessToken',
      displayName: 'Access Token',
      type: 'string',
      required: true,
      typeOptions: { password: true },
      description: 'A System User access token with whatsapp_business_messaging and whatsapp_business_management',
    },
    {
      name: 'businessAccountId',
      displayName: 'Business Account ID',
      type: 'string',
      required: true,
      default: '',
      description: 'The WhatsApp Business Account ID (WhatsApp Manager → API Setup)',
    },
    { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: DEFAULT_BASE_URL, description: 'Graph API base, including the version' },
  ],
  async test(data, ctx) {
    try {
      const { data: numbers = [] } = await phoneNumbers({ http: ctx.http }, data);
      return { ok: true, message: `Business account has ${numbers.length} phone number(s)` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});

const MEDIA_TYPES = ['image', 'document', 'audio', 'video'];
const send = (extra: Record<string, string[]> = {}) => ({ show: { resource: ['message'], operation: ['send'], ...extra } });

export const WhatsApp = defineNode({
  description: {
    name: 'whatsApp',
    displayName: 'WhatsApp Business Cloud',
    description: 'Send WhatsApp text, media (by URL, by uploading an item file or by media ID) and template messages, and download received media, through the Cloud API',
    version: 1,
    kind: 'action',
    categories: ['Communication'],
    icon: 'file:whatsapp.svg',
    color: '#25D366',
    subtitle: '{{operation}}: {{resource}}',
    documentationUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages',
    keywords: ['whatsapp', 'meta', 'message', 'template', 'sms'],
    usableAsTool: true,
    // Sends, posts and edits are at most once over a broker; read operations opt back in with `idempotent: true`.
    idempotent: false,
    toolDescription:
      'Send a WhatsApp message (text, or an image, document, audio or video by URL) or an approved template to a phone number in international format.',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'whatsAppApi', required: true }],
    properties: [
      {
        name: 'resource',
        displayName: 'Resource',
        type: 'options',
        noDataExpression: true,
        default: 'message',
        options: [
          { name: 'Message', value: 'message' },
          { name: 'Media', value: 'media' },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'upload',
        displayOptions: { show: { resource: ['media'] } },
        options: [
          { name: 'Upload', value: 'upload', description: 'Upload an item file; returns the media ID to send by', action: 'Upload media' },
          { name: 'Get', value: 'get', description: 'Download received media by its ID into item.binary', action: 'Get media', idempotent: true },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'send',
        displayOptions: { show: { resource: ['message'] } },
        options: [
          { name: 'Send', value: 'send', description: 'Send a text message, or media by URL', action: 'Send message' },
          { name: 'Send Template', value: 'sendTemplate', description: 'Send an approved message template', action: 'Send template' },
        ],
      },
      {
        name: 'phoneNumberId',
        displayName: 'Sender Phone Number (or ID)',
        type: 'options',
        required: true,
        default: '',
        displayOptions: { hide: { resource: ['media'], operation: ['get'] } },
        typeOptions: { loadOptionsMethod: 'getPhoneNumbers' },
        description: 'The business phone number to send from (its phone number ID)',
      },
      {
        name: 'recipientPhoneNumber',
        displayName: "Recipient's Phone Number",
        type: 'string',
        required: true,
        default: '',
        displayOptions: { show: { resource: ['message'] } },
        placeholder: '+15551234567',
        description: 'International format with country code',
      },
      {
        name: 'messageType',
        displayName: 'Message Type',
        type: 'options',
        default: 'text',
        displayOptions: send(),
        options: [
          { name: 'Text', value: 'text' },
          { name: 'Image', value: 'image' },
          { name: 'Document', value: 'document' },
          { name: 'Audio', value: 'audio' },
          { name: 'Video', value: 'video' },
        ],
      },
      {
        name: 'textBody',
        displayName: 'Text Body',
        type: 'string',
        required: true,
        default: '',
        typeOptions: { rows: 3 },
        displayOptions: send({ messageType: ['text'] }),
      },
      {
        name: 'previewUrl',
        displayName: 'Show URL Preview',
        type: 'boolean',
        default: false,
        displayOptions: send({ messageType: ['text'] }),
        description: 'Whether to render a preview of the first URL in the text',
      },
      {
        name: 'mediaSource',
        displayName: 'Media Source',
        type: 'options',
        default: 'link',
        displayOptions: send({ messageType: MEDIA_TYPES }),
        options: [
          { name: 'URL', value: 'link', description: 'A public HTTPS URL WhatsApp downloads from' },
          { name: 'Binary File', value: 'binary', description: 'Upload the item’s file to WhatsApp first (POST /media), then send it by ID' },
          { name: 'Media ID', value: 'id', description: 'An ID from an earlier upload or an incoming message' },
        ],
      },
      {
        name: 'mediaLink',
        displayName: 'Media URL',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'https://example.com/file.pdf',
        displayOptions: send({ messageType: MEDIA_TYPES, mediaSource: ['link'] }),
        description: 'Public HTTPS URL WhatsApp downloads the media from',
      },
      {
        name: 'mediaId',
        displayName: 'Media ID',
        type: 'string',
        required: true,
        default: '',
        displayOptions: send({ messageType: MEDIA_TYPES, mediaSource: ['id'] }),
        description: 'The ID of uploaded or received media',
      },
      {
        name: 'mediaId',
        displayName: 'Media ID',
        type: 'string',
        required: true,
        default: '',
        displayOptions: { show: { resource: ['media'], operation: ['get'] } },
        description: 'The ID of received media (messages webhook: messages[].image.id and similar)',
      },
      {
        name: 'binaryPropertyName',
        displayName: 'Input Binary Field',
        type: 'string',
        default: 'data',
        displayOptions: send({ messageType: MEDIA_TYPES, mediaSource: ['binary'] }),
        description: 'The item file to upload (item.binary.<name>); images up to 5 MB, audio and video 16 MB, documents 100 MB',
      },
      {
        name: 'binaryPropertyName',
        displayName: 'Binary Field',
        type: 'string',
        default: 'data',
        displayOptions: { show: { resource: ['media'] } },
        description: 'The item.binary field to upload, or to put the downloaded file in',
      },
      {
        name: 'download',
        displayName: 'Download File',
        type: 'boolean',
        default: true,
        displayOptions: { show: { resource: ['media'], operation: ['get'] } },
        description: 'Whether to put the file in item.binary (limit 100 MB); off: only its URL, type and size',
      },
      {
        name: 'mediaCaption',
        displayName: 'Caption',
        type: 'string',
        default: '',
        displayOptions: send({ messageType: ['image', 'document', 'video'] }),
      },
      {
        name: 'mediaFilename',
        displayName: 'Filename',
        type: 'string',
        default: '',
        displayOptions: send({ messageType: ['document'] }),
        description: 'File name shown to the recipient',
      },
      {
        name: 'templateName',
        displayName: 'Template Name',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'hello_world',
        displayOptions: { show: { resource: ['message'], operation: ['sendTemplate'] } },
      },
      {
        name: 'languageCode',
        displayName: 'Language Code',
        type: 'string',
        required: true,
        default: 'en_US',
        displayOptions: { show: { resource: ['message'], operation: ['sendTemplate'] } },
        description: 'The language of the approved template, e.g. en_US or de',
      },
      {
        name: 'components',
        displayName: 'Components',
        type: 'json',
        default: '',
        typeOptions: { rows: 6 },
        displayOptions: { show: { resource: ['message'], operation: ['sendTemplate'] } },
        description: 'Optional template components as a JSON array (header, body and button parameters)',
      },
    ],
  },
  methods: {
    loadOptions: {
      async getPhoneNumbers(ctx): Promise<PropertyOption[]> {
        const { data = [] } = await phoneNumbers({ http: ctx.http }, ctx.getCredentials<WhatsAppCredentials>('whatsAppApi'));
        return data.map((n) => ({
          name: n.verified_name ? `${n.verified_name} (${n.display_phone_number})` : String(n.display_phone_number ?? n.id),
          value: String(n.id),
        }));
      },
    },
  },
  async execute(ctx) {
    const credentials = ctx.getCredentials<WhatsAppCredentials>('whatsAppApi');
    const api: ApiContext = { http: ctx.http, metrics: ctx.metrics };
    return mapItems(ctx, async (i) => {
      const resource = ctx.getNodeParameter<string>('resource', i);
      const operation = ctx.getNodeParameter<string>('operation', i);
      if (resource !== 'message' && resource !== 'media') throw unsupported(resource, operation);
      if (resource === 'media') {
        if (operation === 'get') return downloadMedia(ctx, api, credentials, i);
        if (operation !== 'upload') throw unsupported(resource, operation);
        const uploaded = await uploadMedia(ctx, api, credentials, requireString(ctx, 'phoneNumberId', 'Sender Phone Number', i), i);
        return { mediaId: uploaded.id, fileName: uploaded.fileName, mimeType: uploaded.mimeType };
      }
      const sender = requireString(ctx, 'phoneNumberId', 'Sender Phone Number', i);
      const to = requireString(ctx, 'recipientPhoneNumber', "Recipient's Phone Number", i).replace(/[\s()-]/g, '');
      const message: JsonObject = { messaging_product: 'whatsapp', recipient_type: 'individual', to };

      if (operation === 'send') {
        const type = ctx.getNodeParameter<string>('messageType', i, 'text');
        if (type === 'text') {
          message.type = 'text';
          message.text = { body: requireString(ctx, 'textBody', 'Text Body', i), preview_url: ctx.getNodeParameter<boolean>('previewUrl', i, false) === true };
        } else if (MEDIA_TYPES.includes(type)) {
          const source = ctx.getNodeParameter<string>('mediaSource', i, 'link');
          let media: JsonObject;
          let uploadedName: string | undefined;
          if (source === 'binary') {
            const uploaded = await uploadMedia(ctx, api, credentials, sender, i);
            media = { id: uploaded.id };
            uploadedName = uploaded.fileName;
          } else if (source === 'id') media = { id: requireString(ctx, 'mediaId', 'Media ID', i) };
          else media = { link: requireString(ctx, 'mediaLink', 'Media URL', i) };
          const caption = String(ctx.getNodeParameter('mediaCaption', i, '') ?? '');
          if (caption && type !== 'audio') media.caption = caption;
          const filename = String(ctx.getNodeParameter('mediaFilename', i, '') ?? '');
          if (type === 'document' && (filename || uploadedName)) media.filename = filename || uploadedName!;
          message.type = type;
          message[type] = media;
        } else {
          throw new NodeOperationError(`Unknown message type "${type}"`, { itemIndex: i });
        }
      } else if (operation === 'sendTemplate') {
        const components = jsonParameter(ctx.getNodeParameter('components', i, ''), 'Components');
        if (components !== undefined && !Array.isArray(components)) throw new NodeOperationError('Components must be a JSON array', { itemIndex: i });
        message.type = 'template';
        message.template = {
          name: requireString(ctx, 'templateName', 'Template Name', i),
          language: { code: requireString(ctx, 'languageCode', 'Language Code', i) },
          ...(components && { components }),
        };
      } else {
        throw unsupported(resource, operation);
      }

      const result = await graphCall<JsonObject>(api, credentials, 'POST', `/${encodeURIComponent(sender)}/messages`, message);
      countSent(api, 'whatsapp', operation);
      const [first] = (result.messages as JsonObject[] | undefined) ?? [];
      return { messageId: first?.id ?? null, ...result };
    });
  },
});
