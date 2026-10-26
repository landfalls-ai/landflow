import { defineCredentialType, defineNode, NodeOperationError, type JsonObject, type PropertyOption } from '@landflow/sdk';
import { apiError, baseUrl, countSent, fetchJson, jsonParameter, mapItems, requireString, unsupported, type ApiContext } from '../shared';

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
  const response = await fetchJson(api, 'whatsapp', 'WhatsApp', `${baseUrl(credentials.baseUrl, DEFAULT_BASE_URL)}${path}`, {
    method,
    headers: { authorization: `Bearer ${credentials.accessToken}`, ...(body && { 'content-type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  if (response.ok && response.body !== undefined) return response.body as T;
  const error = response.body?.error as GraphError | undefined;
  const detail = error?.message ? `${error.message}${error.code ? ` (code ${error.code})` : ''}` : response.text.slice(0, 200) || `HTTP ${response.status}`;
  throw apiError(api, 'whatsapp', 'WhatsApp', response.status, detail, hint(response.status, error));
}

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
    description: 'Send WhatsApp text, media (by URL) and template messages through the Cloud API',
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
        options: [{ name: 'Message', value: 'message' }],
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
        typeOptions: { loadOptionsMethod: 'getPhoneNumbers' },
        description: 'The business phone number to send from (its phone number ID)',
      },
      {
        name: 'recipientPhoneNumber',
        displayName: "Recipient's Phone Number",
        type: 'string',
        required: true,
        default: '',
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
        name: 'mediaLink',
        displayName: 'Media URL',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'https://example.com/file.pdf',
        displayOptions: send({ messageType: MEDIA_TYPES }),
        description: 'Public HTTPS URL WhatsApp downloads the media from',
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
      if (resource !== 'message') throw unsupported(resource, operation);
      const sender = requireString(ctx, 'phoneNumberId', 'Sender Phone Number', i);
      const to = requireString(ctx, 'recipientPhoneNumber', "Recipient's Phone Number", i).replace(/[\s()-]/g, '');
      const message: JsonObject = { messaging_product: 'whatsapp', recipient_type: 'individual', to };

      if (operation === 'send') {
        const type = ctx.getNodeParameter<string>('messageType', i, 'text');
        if (type === 'text') {
          message.type = 'text';
          message.text = { body: requireString(ctx, 'textBody', 'Text Body', i), preview_url: ctx.getNodeParameter<boolean>('previewUrl', i, false) === true };
        } else if (MEDIA_TYPES.includes(type)) {
          const media: JsonObject = { link: requireString(ctx, 'mediaLink', 'Media URL', i) };
          const caption = String(ctx.getNodeParameter('mediaCaption', i, '') ?? '');
          if (caption && type !== 'audio') media.caption = caption;
          const filename = String(ctx.getNodeParameter('mediaFilename', i, '') ?? '');
          if (filename && type === 'document') media.filename = filename;
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
