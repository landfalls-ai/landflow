import { defineCredentialType, defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type JsonValue, type PropertyOption } from '@landflow/sdk';
import { apiError, baseUrl, countSent, fetchJson, ItemWithFiles, jsonParameter, mapItems, oauth2Hidden, pickCredentials, requireString, unsupported, type ApiContext } from '../shared';

export interface SlackCredentials extends JsonObject {
  accessToken: string;
  baseUrl: string;
  /** Verifies requests Slack sends to Landflow (agent channels, approval buttons); empty when not set. */
  signingSecret: string;
}

const DEFAULT_BASE_URL = 'https://slack.com/api';

/** Slack answers HTTP 200 with `ok: false` for most failures; these few are its own fault. */
const SERVER_ERRORS = new Set(['internal_error', 'fatal_error', 'service_unavailable', 'request_timeout']);

function hint(body: JsonObject): string | undefined {
  switch (body.error) {
    case 'invalid_auth':
    case 'not_authed':
    case 'token_revoked':
    case 'account_inactive':
      return 'Slack rejected the token (unauthorized). Use the Bot User OAuth Token (xoxb-…) from the app\'s "OAuth & Permissions" page, or Connect the Slack OAuth2 credential again.';
    case 'token_expired':
      // The host renews an OAuth2 token on this wording and runs the node again (token rotation on).
      return 'The access token expired (token expired). Slack OAuth2 credentials are renewed with their refresh token; Connect again if that fails.';
    case 'missing_scope':
      return `The token lacks the scope "${body.needed}"${body.provided ? ` (it has: ${body.provided})` : ''}. Add it under "OAuth & Permissions" and reinstall the app.`;
    case 'channel_not_found':
      return 'Check the channel ID, and invite the bot to private channels (/invite @your-bot).';
    case 'not_in_channel':
      return 'The bot is not a member of the channel. Invite it with /invite @your-bot.';
    case 'invalid_blocks':
    case 'invalid_blocks_format':
      return 'The blocks are not valid Block Kit JSON. Try them in Block Kit Builder.';
    case 'users_not_found':
      return 'No user in this workspace has that email address (or the token lacks users:read.email).';
    default:
      return undefined;
  }
}

/** A Web API method: GET with a query for reads, POST JSON for writes. Maps `ok: false` and HTTP errors to node errors. */
export async function slackCall<T = any>(
  api: ApiContext,
  credentials: SlackCredentials,
  method: string,
  params: JsonObject = {},
  httpMethod: 'GET' | 'POST' = 'POST',
): Promise<T> {
  let url = `${baseUrl(credentials.baseUrl, DEFAULT_BASE_URL)}/${method}`;
  const headers: Record<string, string> = { authorization: `Bearer ${credentials.accessToken}` };
  let init: RequestInit;
  if (httpMethod === 'GET') {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
    if ([...query.keys()].length) url += `?${query}`;
    init = { method: 'GET', headers };
  } else {
    init = { method: 'POST', headers: { ...headers, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(params) };
  }
  const response = await fetchJson(api, 'slack', 'Slack', url, init);
  const body = response.body as JsonObject | undefined;
  if (response.status === 429) {
    const retry = response.headers.get('retry-after');
    throw apiError(api, 'slack', 'Slack', 429, 'ratelimited', `Slack rate limit reached${retry ? `: retry after ${retry} s` : ''}.`);
  }
  if (!response.ok || !body) {
    throw apiError(api, 'slack', 'Slack', response.status, String(body?.error ?? (response.text.slice(0, 200) || `HTTP ${response.status}`)));
  }
  if (body.ok !== true) {
    const error = String(body.error ?? 'unknown_error');
    throw apiError(api, 'slack', 'Slack', undefined, error, hint(body), SERVER_ERRORS.has(error) ? '5xx' : '4xx');
  }
  return body as T;
}

const CREDENTIAL_TYPES = { token: 'slackApi', oauth2: 'slackOAuth2Api' } as const;

/** The node's Slack credential: the bot token type or the OAuth2 one, by the Authentication parameter (else whichever was sent). */
export const slackCredentials = (ctx: { getCredentials: IExecuteContext['getCredentials'] }, authentication?: unknown) =>
  pickCredentials<SlackCredentials>(ctx, authentication, CREDENTIAL_TYPES.token, CREDENTIAL_TYPES.oauth2);

export const slackApi = defineCredentialType<SlackCredentials>({
  name: 'slackApi',
  displayName: 'Slack API',
  icon: 'file:slack.svg',
  documentationUrl: 'https://api.slack.com/authentication/token-types#bot',
  properties: [
    {
      name: 'accessToken',
      displayName: 'Access Token',
      type: 'string',
      required: true,
      typeOptions: { password: true },
      placeholder: 'xoxb-…',
      description: 'Bot User OAuth Token from your Slack app ("OAuth & Permissions")',
    },
    { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: DEFAULT_BASE_URL, description: 'Change it only for a proxy or a test double' },
    {
      name: 'signingSecret',
      displayName: 'Signing Secret',
      type: 'string',
      default: '',
      typeOptions: { password: true },
      description: 'From the app\'s "Basic Information" page. Needed when Slack calls Landflow: agent channels (Events API), approval buttons (Interactivity) and the Slack Trigger (its Request URL goes into Event Subscriptions).',
    },
  ],
  async test(data, ctx) {
    try {
      const auth = await slackCall<{ team?: string; user?: string }>({ http: ctx.http }, data, 'auth.test');
      return { ok: true, message: `Authenticated as ${auth.user ?? 'unknown'} in team ${auth.team ?? 'unknown'}` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});

/**
 * Slack OAuth2: extends the host's generic OAuth2 type. Connect runs the v2 consent flow for the bot scopes below and
 * the host sends the bot token (`xoxb-…`) as `accessToken`, refreshed when token rotation is on.
 */
export const slackOAuth2Api = defineCredentialType<SlackCredentials>({
  name: 'slackOAuth2Api',
  displayName: 'Slack OAuth2 API',
  icon: 'file:slack.svg',
  documentationUrl: 'https://api.slack.com/authentication/oauth-v2',
  description:
    'Sign in with Slack: create an app at api.slack.com/apps, add the redirect URL shown below under OAuth & Permissions, add the bot scopes, then Connect. The bot token is renewed for you when token rotation is on. ' +
    'For the Slack Trigger also fill in the Signing Secret, publish the workflow and paste the node\'s Request URL (editor Publish menu, App webhooks: {public URL}/api/webhook/app/<workflow id>/<node id>) into Event Subscriptions, ' +
    'then subscribe to the bot events and add the matching scopes (app_mentions:read, channels:history, groups:history, im:history, mpim:history, reactions:read, files:read, …). Reinstall the app after changing scopes.',
  extends: ['oAuth2Api'],
  properties: [
    oauth2Hidden('grantType', 'Grant Type', 'authorizationCode'),
    oauth2Hidden('authUrl', 'Authorization URL', 'https://slack.com/oauth/v2/authorize'),
    oauth2Hidden('accessTokenUrl', 'Access Token URL', 'https://slack.com/api/oauth.v2.access'),
    oauth2Hidden('authentication', 'Client Authentication', 'body'),
    {
      name: 'scope',
      displayName: 'Bot Scopes',
      type: 'string',
      default: 'chat:write,channels:read,groups:read,reactions:write,users:read,users:read.email,files:write,files:read',
      description: 'Comma-separated bot scopes asked for at Connect. Drop the ones your workflows do not need.',
    },
    { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: DEFAULT_BASE_URL, description: 'Change it only for a proxy or a test double' },
    {
      name: 'signingSecret',
      displayName: 'Signing Secret',
      type: 'string',
      default: '',
      typeOptions: { password: true },
      description: 'From the app\'s "Basic Information" page. Needed when Slack calls Landflow (agent channels, approval buttons, the Slack Trigger\'s Events API Request URL).',
    },
  ],
  async test(data, ctx) {
    try {
      const auth = await slackCall<{ team?: string; user?: string }>({ http: ctx.http }, data, 'auth.test');
      return { ok: true, message: `Authenticated as ${auth.user ?? 'unknown'} in team ${auth.team ?? 'unknown'}` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});

/** Block Kit JSON: an array, or `{ blocks: [...] }` as Block Kit Builder exports it. */
function blocksParameter(value: unknown): JsonValue[] | undefined {
  const parsed = jsonParameter(value, 'Blocks');
  if (parsed === undefined) return undefined;
  const blocks = Array.isArray(parsed) ? parsed : (parsed as JsonObject | null)?.blocks;
  if (!Array.isArray(blocks)) throw new NodeOperationError('Blocks must be a JSON array of Block Kit blocks (or an object with a "blocks" array)');
  return blocks;
}

/** Drop Slack's envelope fields from a successful answer. */
function strip(body: JsonObject): JsonObject {
  const { ok: _ok, response_metadata: _meta, warning: _warning, ...rest } = body;
  return rest;
}

function simplifyChannel(channel: JsonObject): JsonObject {
  return {
    id: channel.id,
    name: channel.name ?? null,
    is_private: channel.is_private ?? false,
    is_archived: channel.is_archived ?? false,
    is_member: channel.is_member ?? false,
    num_members: channel.num_members ?? null,
    topic: (channel.topic as JsonObject | undefined)?.value ?? '',
    purpose: (channel.purpose as JsonObject | undefined)?.value ?? '',
    created: channel.created ?? null,
  };
}

function simplifyUser(user: JsonObject): JsonObject {
  const profile = (user.profile ?? {}) as JsonObject;
  return {
    id: user.id,
    name: user.name ?? null,
    real_name: user.real_name ?? profile.real_name ?? null,
    display_name: profile.display_name ?? null,
    email: profile.email ?? null,
    title: profile.title ?? null,
    tz: user.tz ?? null,
    is_bot: user.is_bot ?? false,
    is_admin: user.is_admin ?? false,
    deleted: user.deleted ?? false,
  };
}

const PAGE_SIZE = 200;

/** conversations.list, following next_cursor until `max` channels (or the end). */
async function listChannels(api: ApiContext, credentials: SlackCredentials, params: JsonObject, max = Infinity): Promise<JsonObject[]> {
  const channels: JsonObject[] = [];
  let cursor: string | undefined;
  do {
    const page = await slackCall<{ channels?: JsonObject[]; response_metadata?: { next_cursor?: string } }>(
      api,
      credentials,
      'conversations.list',
      { ...params, limit: Math.min(PAGE_SIZE, max - channels.length), ...(cursor && { cursor }) },
      'GET',
    );
    channels.push(...(page.channels ?? []));
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor && channels.length < max);
  return channels.slice(0, max);
}

/** POST to an upload URL or GET a file URL, mapping network and HTTP failures to node errors. */
async function fileRequest(api: ApiContext, url: string, init: RequestInit, what: string, description?: string): Promise<Response> {
  let response: Response;
  try {
    response = await api.http(url, { ...init, signal: AbortSignal.timeout(300_000) });
  } catch (error) {
    throw apiError(api, 'slack', 'Slack', undefined, `the file ${what} failed: ${(error as Error).message}`, undefined, 'network');
  }
  if (!response.ok) throw apiError(api, 'slack', 'Slack', response.status, `the file ${what} failed`, description);
  return response;
}

/** Slack's upload flow: files.getUploadURLExternal, the bytes to that URL, then files.completeUploadExternal shares the file. */
async function uploadFile(ctx: IExecuteContext, api: ApiContext, credentials: SlackCredentials, i: number, channelId: string): Promise<JsonObject> {
  const property = String(ctx.getNodeParameter('binaryPropertyName', i, 'data') || 'data').trim();
  const ref = ctx.helpers.assertBinaryData(i, property);
  const options = ctx.getNodeParameter<JsonObject>('fileOptions', i, {}) ?? {};
  const bytes = new Uint8Array(await ctx.helpers.getBinaryDataBuffer(i, property));
  const filename = String(options.fileName ?? '').trim() || ref.fileName || `${property}.${ref.fileExtension ?? 'bin'}`;
  const target = await slackCall<{ upload_url: string; file_id: string }>(api, credentials, 'files.getUploadURLExternal', { filename, length: bytes.length }, 'GET');
  const uploaded = await fileRequest(api, target.upload_url, { method: 'POST', headers: { 'content-type': ref.mimeType || 'application/octet-stream' }, body: bytes }, 'upload');
  await uploaded.arrayBuffer().catch(() => undefined);
  const params: JsonObject = { files: [{ id: target.file_id, title: String(options.title ?? '').trim() || filename }], channel_id: channelId };
  if (options.initial_comment) params.initial_comment = String(options.initial_comment);
  if (options.thread_ts) params.thread_ts = String(options.thread_ts);
  const { files } = await slackCall<{ files?: JsonObject[] }>(api, credentials, 'files.completeUploadExternal', params);
  countSent(api, 'slack', 'upload');
  return files?.[0] ?? { id: target.file_id };
}

/** files.info, then the bytes from url_private_download (it needs the token) into item.binary. */
async function getFile(ctx: IExecuteContext, api: ApiContext, credentials: SlackCredentials, i: number): Promise<JsonObject | ItemWithFiles> {
  const { file } = await slackCall<{ file: JsonObject }>(api, credentials, 'files.info', { file: requireString(ctx, 'fileId', 'File ID', i) }, 'GET');
  if (!ctx.getNodeParameter<boolean>('download', i, true)) return file;
  const url = String(file.url_private_download ?? file.url_private ?? '');
  if (!url) {
    throw new NodeOperationError('Slack gave no download URL for this file', { itemIndex: i, description: 'Files linked from other services (Google Drive, Dropbox…) have no copy in Slack.' });
  }
  const scope = 'The token needs the files:read scope, and the bot must be able to see the file.';
  const response = await fileRequest(api, url, { headers: { authorization: `Bearer ${credentials.accessToken}` } }, 'download', scope);
  const type = response.headers.get('content-type');
  // Without access Slack answers its sign-in page (HTML, status 200) instead of the file.
  if (type && /text\/html/i.test(type) && file.mimetype !== 'text/html') throw apiError(api, 'slack', 'Slack', response.status, 'the file download returned a sign-in page', scope);
  const mimeType = typeof file.mimetype === 'string' && file.mimetype ? file.mimetype : type && !/octet-stream/i.test(type) ? type : undefined;
  const ref = await ctx.helpers.prepareBinaryData(response.body!, typeof file.name === 'string' ? file.name : undefined, mimeType);
  const property = String(ctx.getNodeParameter('binaryPropertyName', i, 'data') || 'data').trim();
  return new ItemWithFiles(file, { [property]: ref });
}

const messageOps = (operation: string[]) => ({ show: { resource: ['message'], operation } });
const fileOps = (operation: string[]) => ({ show: { resource: ['file'], operation } });

export const Slack = defineNode({
  description: {
    name: 'slack',
    displayName: 'Slack',
    description: 'Send, update and delete Slack messages, upload and download files, list channels, look up users and add reactions',
    version: 1,
    kind: 'action',
    categories: ['Communication'],
    icon: 'file:slack.svg',
    color: '#4A154B',
    subtitle: '{{operation}}: {{resource}}',
    documentationUrl: 'https://api.slack.com/methods',
    keywords: ['slack', 'chat', 'message', 'channel', 'file', 'upload', 'attachment'],
    usableAsTool: true,
    // Sends, posts and edits are at most once over a broker; read operations opt back in with `idempotent: true`.
    idempotent: false,
    toolDescription: 'Send, update or delete a Slack message, get its permalink, upload or download a file, list channels, find a user by email, or add an emoji reaction.',
    inputs: [{ type: 'main' }],
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
      {
        name: 'resource',
        displayName: 'Resource',
        type: 'options',
        noDataExpression: true,
        default: 'message',
        options: [
          { name: 'Channel', value: 'channel' },
          { name: 'File', value: 'file' },
          { name: 'Message', value: 'message' },
          { name: 'Reaction', value: 'reaction' },
          { name: 'User', value: 'user' },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'getAll',
        displayOptions: { show: { resource: ['channel'] } },
        options: [{ name: 'Get Many', value: 'getAll', description: 'Get many channels in the workspace', action: 'Get many channels', idempotent: true }],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'add',
        displayOptions: { show: { resource: ['reaction'] } },
        options: [{ name: 'Add', value: 'add', description: 'Add an emoji reaction to a message', action: 'Add a reaction' }],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'getByEmail',
        displayOptions: { show: { resource: ['user'] } },
        options: [{ name: 'Get by Email', value: 'getByEmail', description: 'Find a user by email address', action: 'Get a user by email', idempotent: true }],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'upload',
        displayOptions: { show: { resource: ['file'] } },
        options: [
          { name: 'Get', value: 'get', description: 'Get a file’s details and download it into the item', action: 'Get a file', idempotent: true },
          { name: 'Upload', value: 'upload', description: 'Upload an item file to a channel or thread', action: 'Upload a file' },
        ],
      },
      // The default resource's operation comes last: parameter defaults are keyed by name, last one wins.
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'post',
        displayOptions: { show: { resource: ['message'] } },
        options: [
          { name: 'Delete', value: 'delete', action: 'Delete a message' },
          { name: 'Get Permalink', value: 'getPermalink', action: 'Get a message permalink', idempotent: true },
          { name: 'Send', value: 'post', action: 'Send a message' },
          { name: 'Update', value: 'update', action: 'Update a message' },
        ],
      },
      {
        name: 'channelId',
        displayName: 'Channel',
        type: 'options',
        required: true,
        default: '',
        typeOptions: { loadOptionsMethod: 'getChannels' },
        displayOptions: { show: { resource: ['message', 'reaction'] } },
        description: 'Pick a channel, or set a channel ID (C0123ABCD) with an expression',
      },
      {
        name: 'channelId',
        displayName: 'Channel',
        type: 'options',
        required: true,
        default: '',
        typeOptions: { loadOptionsMethod: 'getChannels' },
        displayOptions: fileOps(['upload']),
        description: 'The channel to share the file in. Pick one, or set a channel ID (C0123ABCD) with an expression',
      },
      {
        name: 'binaryPropertyName',
        displayName: 'Input Binary Field',
        type: 'string',
        required: true,
        default: 'data',
        displayOptions: fileOps(['upload']),
        description: 'The item file to upload (item.binary.<name>)',
      },
      {
        name: 'fileOptions',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: fileOps(['upload']),
        values: [
          { name: 'fileName', displayName: 'File Name', type: 'string', default: '', description: 'Default: the item file’s name' },
          { name: 'title', displayName: 'Title', type: 'string', default: '', description: 'Default: the file name' },
          { name: 'initial_comment', displayName: 'Message', type: 'string', default: '', typeOptions: { rows: 2 }, description: 'Text posted with the file' },
          { name: 'thread_ts', displayName: 'Reply to Thread (ts)', type: 'string', default: '', description: 'Share the file as a reply in the thread of this message' },
        ],
      },
      {
        name: 'fileId',
        displayName: 'File ID',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'F0123ABCD',
        displayOptions: fileOps(['get']),
        description: 'The file’s ID, e.g. from a message event’s files',
      },
      {
        name: 'download',
        displayName: 'Download',
        type: 'boolean',
        default: true,
        displayOptions: fileOps(['get']),
        description: 'Whether to put the file in item.binary; off: only its details',
      },
      {
        name: 'binaryPropertyName',
        displayName: 'Put Output File in Field',
        type: 'string',
        default: 'data',
        displayOptions: { show: { resource: ['file'], operation: ['get'], download: [true] } },
        description: 'The item.binary field for the downloaded file',
      },
      {
        name: 'text',
        displayName: 'Text',
        type: 'string',
        default: '',
        typeOptions: { rows: 4 },
        displayOptions: messageOps(['post', 'update']),
        description: 'Message text (mrkdwn). With blocks it becomes the notification fallback',
      },
      {
        name: 'blocksUi',
        displayName: 'Blocks',
        type: 'json',
        default: '',
        typeOptions: { rows: 6 },
        displayOptions: messageOps(['post', 'update']),
        description: 'Optional Block Kit blocks: a JSON array, or the {"blocks": [...]} object Block Kit Builder exports',
      },
      {
        name: 'ts',
        displayName: 'Message Timestamp',
        type: 'string',
        required: true,
        default: '',
        placeholder: '1663233118.856619',
        displayOptions: messageOps(['update', 'delete', 'getPermalink']),
        description: 'The ts of the message (returned when it was sent)',
      },
      {
        name: 'otherOptions',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: messageOps(['post']),
        values: [
          { name: 'thread_ts', displayName: 'Reply to Thread (ts)', type: 'string', default: '', description: 'Post as a reply in the thread of this message' },
          {
            name: 'reply_broadcast',
            displayName: 'Also Send to Channel',
            type: 'boolean',
            default: false,
            description: 'Show a thread reply in the channel too',
          },
          { name: 'unfurl_links', displayName: 'Unfurl Links', type: 'boolean', default: true },
          { name: 'mrkdwn', displayName: 'Use Markdown', type: 'boolean', default: true },
        ],
      },
      {
        name: 'timestamp',
        displayName: 'Message Timestamp',
        type: 'string',
        required: true,
        default: '',
        displayOptions: { show: { resource: ['reaction'] } },
        description: 'The ts of the message to react to',
      },
      {
        name: 'name',
        displayName: 'Emoji Code',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'thumbsup',
        displayOptions: { show: { resource: ['reaction'] } },
        description: 'Emoji name without colons',
      },
      {
        name: 'email',
        displayName: 'Email',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'name@example.com',
        displayOptions: { show: { resource: ['user'] } },
      },
      {
        name: 'returnAll',
        displayName: 'Return All',
        type: 'boolean',
        default: false,
        displayOptions: { show: { resource: ['channel'] } },
        description: 'Whether to return all results or only up to a limit',
      },
      {
        name: 'limit',
        displayName: 'Limit',
        type: 'number',
        default: 50,
        typeOptions: { minValue: 1, numberPrecision: 0 },
        displayOptions: { show: { resource: ['channel'], returnAll: [false] } },
        description: 'Max number of results to return',
      },
      {
        name: 'filters',
        displayName: 'Filters',
        type: 'collection',
        default: {},
        placeholder: 'Add filter',
        displayOptions: { show: { resource: ['channel'] } },
        values: [
          { name: 'excludeArchived', displayName: 'Exclude Archived Channels', type: 'boolean', default: true },
          {
            name: 'types',
            displayName: 'Types',
            type: 'multiOptions',
            default: ['public_channel'],
            options: [
              { name: 'Public Channel', value: 'public_channel' },
              { name: 'Private Channel', value: 'private_channel' },
              { name: 'Group DM', value: 'mpim' },
              { name: 'Direct Message', value: 'im' },
            ],
          },
        ],
      },
      {
        name: 'simplify',
        displayName: 'Simplify',
        type: 'boolean',
        default: true,
        displayOptions: { show: { resource: ['channel', 'user'] } },
        description: 'Whether to return a few flat fields instead of the raw Slack object',
      },
    ],
  },
  methods: {
    loadOptions: {
      async getChannels(ctx): Promise<PropertyOption[]> {
        const credentials = slackCredentials(ctx);
        const channels = await listChannels({ http: ctx.http }, credentials, { types: 'public_channel,private_channel', exclude_archived: true }, 2000);
        return channels
          .map((c) => ({ name: `#${c.name}`, value: String(c.id), ...(c.is_private === true && { description: 'private' }) }))
          .sort((a, b) => a.name.localeCompare(b.name));
      },
    },
  },
  async execute(ctx) {
    const credentials = slackCredentials(ctx, ctx.getNodeParameter('authentication', 0, 'accessToken'));
    const api: ApiContext = { http: ctx.http, metrics: ctx.metrics };
    return mapItems(ctx, async (i) => {
      const resource = ctx.getNodeParameter<string>('resource', i);
      const operation = ctx.getNodeParameter<string>('operation', i);
      const channel = () => requireString(ctx, 'channelId', 'Channel', i);

      if (resource === 'message') {
        switch (operation) {
          case 'post': {
            const text = String(ctx.getNodeParameter('text', i, '') ?? '');
            const blocks = blocksParameter(ctx.getNodeParameter('blocksUi', i, ''));
            if (!text && !blocks) throw new NodeOperationError('Set Text or Blocks', { itemIndex: i });
            const options = ctx.getNodeParameter<JsonObject>('otherOptions', i, {}) ?? {};
            const params: JsonObject = { channel: channel(), text, ...(blocks && { blocks }) };
            if (options.thread_ts) params.thread_ts = String(options.thread_ts);
            if (options.thread_ts && options.reply_broadcast === true) params.reply_broadcast = true;
            if (typeof options.unfurl_links === 'boolean') params.unfurl_links = options.unfurl_links;
            if (typeof options.mrkdwn === 'boolean') params.mrkdwn = options.mrkdwn;
            const sent = strip(await slackCall(api, credentials, 'chat.postMessage', params));
            countSent(api, 'slack', operation);
            return sent;
          }
          case 'update': {
            const text = String(ctx.getNodeParameter('text', i, '') ?? '');
            const blocks = blocksParameter(ctx.getNodeParameter('blocksUi', i, ''));
            if (!text && !blocks) throw new NodeOperationError('Set Text or Blocks', { itemIndex: i });
            const params: JsonObject = { channel: channel(), ts: requireString(ctx, 'ts', 'Message Timestamp', i), text, ...(blocks && { blocks }) };
            return strip(await slackCall(api, credentials, 'chat.update', params));
          }
          case 'delete': {
            const result = await slackCall(api, credentials, 'chat.delete', { channel: channel(), ts: requireString(ctx, 'ts', 'Message Timestamp', i) });
            return { success: true, ...strip(result) };
          }
          case 'getPermalink':
            return strip(
              await slackCall(
                api,
                credentials,
                'chat.getPermalink',
                { channel: channel(), message_ts: requireString(ctx, 'ts', 'Message Timestamp', i) },
                'GET',
              ),
            );
          default:
            throw unsupported(resource, operation);
        }
      }
      if (resource === 'file' && operation === 'upload') return uploadFile(ctx, api, credentials, i, channel());
      if (resource === 'file' && operation === 'get') return getFile(ctx, api, credentials, i);
      if (resource === 'channel' && operation === 'getAll') {
        const returnAll = ctx.getNodeParameter<boolean>('returnAll', i, false);
        const limit = Math.max(1, Number(ctx.getNodeParameter('limit', i, 50)) || 50);
        const filters = ctx.getNodeParameter<JsonObject>('filters', i, {}) ?? {};
        const types = Array.isArray(filters.types) && filters.types.length ? filters.types.join(',') : 'public_channel';
        const channels = await listChannels(api, credentials, { types, exclude_archived: filters.excludeArchived !== false }, returnAll ? Infinity : limit);
        const simplify = ctx.getNodeParameter<boolean>('simplify', i, true);
        return channels.map((c) => (simplify ? simplifyChannel(c) : c));
      }
      if (resource === 'user' && operation === 'getByEmail') {
        const { user } = await slackCall<{ user: JsonObject }>(
          api,
          credentials,
          'users.lookupByEmail',
          { email: requireString(ctx, 'email', 'Email', i) },
          'GET',
        );
        return ctx.getNodeParameter<boolean>('simplify', i, true) ? simplifyUser(user) : user;
      }
      if (resource === 'reaction' && operation === 'add') {
        const params = {
          channel: channel(),
          timestamp: requireString(ctx, 'timestamp', 'Message Timestamp', i),
          name: requireString(ctx, 'name', 'Emoji Code', i).replace(/^:|:$/g, ''),
        };
        await slackCall(api, credentials, 'reactions.add', params);
        return { success: true, ...params };
      }
      throw unsupported(resource, operation);
    });
  },
});
