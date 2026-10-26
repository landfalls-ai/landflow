/**
 * Twilio (docs/transports.md, the pilot): Messages (SMS, MMS, WhatsApp, get, list) and Calls (make, get, list) on the
 * 2010-04-01 REST API. Bodies go up form-encoded with Basic auth (Account SID + Auth Token, or an API key SID + secret);
 * Twilio's `{ code, message, more_info, status }` errors become node errors that keep the code; a 429 waits
 * `Retry-After` (bounded by the call's deadline) and retries once. Sends and calls are `idempotent: false` (at most
 * once over a broker: an SMS never goes out twice); Get and List are `idempotent: true`.
 */
import { defineCredentialType, defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type JsonValue, type PropertyDescriptor } from '@landflow/sdk';
import { baseUrl, countApiError, countSent, fetchJson, mapItems, requireString, sleepUnless, statusClass, unsupported, type ApiContext, type ApiResponse } from '../shared';

export interface TwilioCredentials extends JsonObject {
  authType: 'authToken' | 'apiKey';
  accountSid: string;
  /** With `authType: 'authToken'`. */
  authToken: string;
  /** With `authType: 'apiKey'`. */
  apiKeySid: string;
  apiKeySecret: string;
  baseUrl: string;
}

export const TWILIO_DEFAULT_BASE_URL = 'https://api.twilio.com';
const API_VERSION = '2010-04-01';
/** A 429 asking to wait longer than this fails right away instead of holding the execution. */
const MAX_RETRY_WAIT_S = 10;
const PAGE_SIZE = 100;

/** Twilio's error body (https://www.twilio.com/docs/usage/twilios-response#response-formats-exceptions). */
export interface TwilioError {
  code?: number;
  message?: string;
  more_info?: string;
  status?: number;
}

/** The call's abort signal and deadline, when the node runs under a dispatcher (loadOptions and credential tests have none). */
interface CallBounds {
  signal?: AbortSignal;
  deadline?: number;
}

/** The account path every resource hangs off: `/2010-04-01/Accounts/{sid}`. */
export function accountPath(credentials: TwilioCredentials): string {
  const sid = String(credentials.accountSid ?? '').trim();
  if (!sid) throw new NodeOperationError('The Twilio credential has no Account SID');
  return `/${API_VERSION}/Accounts/${encodeURIComponent(sid)}`;
}

/** Basic auth: `AC…:authToken`, or `SK…:secret` for an API key (the Account SID then only names the account in the path). */
function authorization(credentials: TwilioCredentials): string {
  const apiKey = credentials.authType === 'apiKey';
  const user = apiKey ? String(credentials.apiKeySid ?? '').trim() : String(credentials.accountSid ?? '').trim();
  const secret = apiKey ? String(credentials.apiKeySecret ?? '') : String(credentials.authToken ?? '');
  if (!user || !secret) throw new NodeOperationError(apiKey ? 'The Twilio credential needs an API key SID and secret' : 'The Twilio credential needs an Account SID and Auth Token');
  return `Basic ${Buffer.from(`${user}:${secret}`, 'utf8').toString('base64')}`;
}

/** The form body Twilio expects; a repeated key (`MediaUrl`) is sent once per value, a missing value is left out. */
export function formBody(fields: Record<string, string | number | boolean | string[] | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === '') continue;
    for (const entry of Array.isArray(value) ? value : [value]) if (entry !== '') params.append(key, String(entry));
  }
  return params.toString();
}

function hint(status: number, error: TwilioError | undefined): string | undefined {
  const parts: string[] = [];
  if (status === 401 || error?.code === 20003) parts.push('Twilio rejected the credentials: check the Account SID and Auth Token (or the API key SID and secret).');
  else if (status === 404 && error?.code === 20404) parts.push('No such resource on this account: check the SID.');
  else if (status === 429) parts.push('Twilio rate limit (too many requests or concurrent calls).');
  else if (error?.code === 21211) parts.push("The 'To' number is not a valid phone number (use E.164, e.g. +15551234567).");
  else if (error?.code === 21608) parts.push('A trial account can only send to verified numbers.');
  else if (error?.code === 21614) parts.push("The 'To' number cannot receive SMS (a landline?).");
  if (error?.more_info) parts.push(`See ${error.more_info}`);
  return parts.length ? parts.join(' ') : undefined;
}

/** "Twilio API error 400 (code 21211): The 'To' number is not a valid phone number." — the Twilio code stays in the message. */
export function twilioError(api: ApiContext, response: ApiResponse): NodeOperationError {
  const error = (response.body && typeof response.body === 'object' ? response.body : undefined) as TwilioError | undefined;
  const text = error?.message ?? (response.text.slice(0, 200) || `HTTP ${response.status}`);
  countApiError(api, 'twilio', statusClass(response.status));
  const description = hint(response.status, error);
  return new NodeOperationError(`Twilio API error ${response.status}${error?.code ? ` (code ${error.code})` : ''}: ${text}`, description ? { description } : {});
}

/** `Retry-After` in seconds (Twilio sends seconds; an HTTP date is accepted too), or undefined. */
export function retryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, (at - Date.now()) / 1000) : undefined;
}

/**
 * One authenticated call. A 429 is never a delivered send (Twilio refused it before creating anything), so it is safe
 * to wait `Retry-After` and try once more; the wait is skipped when it would pass the call's deadline or the cap, and
 * the execution's abort signal cuts it short.
 */
export async function twilioCall<T = any>(api: ApiContext, credentials: TwilioCredentials, method: 'GET' | 'POST', path: string, body?: string, bounds: CallBounds = {}): Promise<T> {
  const url = path.startsWith('http') ? path : `${baseUrl(credentials.baseUrl, TWILIO_DEFAULT_BASE_URL)}${path}`;
  const init: RequestInit = {
    method,
    headers: { authorization: authorization(credentials), accept: 'application/json', ...(body !== undefined && { 'content-type': 'application/x-www-form-urlencoded' }) },
    ...(body !== undefined && { body }),
    ...(bounds.signal && { signal: AbortSignal.any([bounds.signal, AbortSignal.timeout(30_000)]) }),
  };
  let response = await fetchJson(api, 'twilio', 'Twilio', url, init);
  if (response.status === 429) {
    const retryAfter = retryAfterSeconds(response.headers) ?? 1;
    const waitMs = Math.ceil(retryAfter * 1000);
    const fitsDeadline = bounds.deadline === undefined || Date.now() + waitMs < bounds.deadline - 1_000;
    if (retryAfter <= MAX_RETRY_WAIT_S && fitsDeadline) {
      countApiError(api, 'twilio', '4xx');
      await sleepUnless(waitMs, bounds.signal);
      response = await fetchJson(api, 'twilio', 'Twilio', url, init);
    }
  }
  if (response.ok && response.body !== undefined) return response.body as T;
  throw twilioError(api, response);
}

/** Collect up to `max` entries of a Twilio list (`{ <key>: [...], next_page_uri }`), following `next_page_uri`. */
export async function listAll<T extends JsonObject>(api: ApiContext, credentials: TwilioCredentials, path: string, key: string, query: Record<string, string | undefined>, max: number, bounds: CallBounds): Promise<T[]> {
  const out: T[] = [];
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) if (value) params.set(name, value);
  params.set('PageSize', String(Math.min(PAGE_SIZE, Math.max(1, max))));
  let next: string | undefined = `${path}?${params.toString()}`;
  while (next && out.length < max) {
    const page: JsonObject = await twilioCall<JsonObject>(api, credentials, 'GET', next, undefined, bounds);
    const entries = (page[key] as T[] | undefined) ?? [];
    out.push(...entries);
    const uri = page.next_page_uri;
    next = typeof uri === 'string' && uri && entries.length ? uri : undefined;
  }
  return out.slice(0, max);
}

/** The `From` form fields: a Messaging Service SID (`MG…`) goes as `MessagingServiceSid`, anything else as `From`. */
export function senderFields(from: string, channelPrefix = ''): Record<string, string> {
  const value = from.trim();
  if (/^MG[0-9a-fA-F]{32}$/.test(value)) return { MessagingServiceSid: value };
  return { From: withChannel(value, channelPrefix) };
}

/** `whatsapp:+1555…` from `+1555…` (or an already-prefixed address). */
export function withChannel(address: string, prefix: string): string {
  const value = address.trim();
  if (!prefix || value.toLowerCase().startsWith(prefix.toLowerCase())) return value;
  return `${prefix}${value}`;
}

/** Media URLs: the fixedCollection `{ urls: [{ url }] }`, a JSON array, or a string with one URL per line or comma. */
export function mediaUrls(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value === 'string') return value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.flatMap((entry) => mediaUrls(entry));
  if (typeof value === 'object') {
    const object = value as JsonObject;
    if (typeof object.url === 'string') return mediaUrls(object.url);
    return mediaUrls(object.urls);
  }
  return [];
}

export const twilioApi = defineCredentialType<TwilioCredentials>({
  name: 'twilioApi',
  displayName: 'Twilio API',
  icon: 'file:twilio.svg',
  documentationUrl: 'https://www.twilio.com/docs/usage/api',
  properties: [
    {
      name: 'authType',
      displayName: 'Authenticate With',
      type: 'options',
      default: 'authToken',
      options: [
        { name: 'Auth Token', value: 'authToken', description: 'The account’s Auth Token (Console → Account Info)' },
        { name: 'API Key', value: 'apiKey', description: 'A standard API key SID and secret (Console → Account → API keys & tokens)' },
      ],
    },
    {
      name: 'accountSid',
      displayName: 'Account SID',
      type: 'string',
      required: true,
      default: '',
      placeholder: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      description: 'The account (or subaccount) the messages and calls belong to',
    },
    {
      name: 'authToken',
      displayName: 'Auth Token',
      type: 'string',
      required: true,
      default: '',
      typeOptions: { password: true },
      displayOptions: { show: { authType: ['authToken'] } },
    },
    {
      name: 'apiKeySid',
      displayName: 'API Key SID',
      type: 'string',
      required: true,
      default: '',
      placeholder: 'SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      displayOptions: { show: { authType: ['apiKey'] } },
    },
    {
      name: 'apiKeySecret',
      displayName: 'API Key Secret',
      type: 'string',
      required: true,
      default: '',
      typeOptions: { password: true },
      displayOptions: { show: { authType: ['apiKey'] } },
    },
    {
      name: 'baseUrl',
      displayName: 'API Base URL',
      type: 'string',
      default: TWILIO_DEFAULT_BASE_URL,
      description: 'Advanced: where the 2010-04-01 API lives. Leave the default for Twilio; point it at a proxy, a region (api.dublin.ie1.twilio.com) or the fake Twilio server for tests',
    },
  ],
  async test(data, ctx) {
    try {
      const account = await twilioCall<{ friendly_name?: string; status?: string; type?: string }>({ http: ctx.http }, data, 'GET', `${accountPath(data)}.json`);
      return { ok: true, message: `Account "${account.friendly_name ?? data.accountSid}" (${account.type ?? 'account'}, ${account.status ?? 'unknown'})` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});

const MESSAGE_SENDS = ['send', 'sendMms', 'sendWhatsApp'];
const message = (operations: string[], extra: Record<string, string[]> = {}) => ({ show: { resource: ['message'], operation: operations, ...extra } });
const call = (operations: string[], extra: Record<string, string[]> = {}) => ({ show: { resource: ['call'], operation: operations, ...extra } });

/** One output item of a Message operation (Twilio's Message resource, the fields agents and workflows use most). */
const MESSAGE_SCHEMA: JsonObject = {
  type: 'object',
  properties: {
    sid: { type: 'string', description: 'The message SID (SM… or MM…)' },
    account_sid: { type: 'string' },
    messaging_service_sid: { type: ['string', 'null'] },
    from: { type: ['string', 'null'] },
    to: { type: 'string' },
    body: { type: ['string', 'null'] },
    status: { type: 'string', description: 'queued, sending, sent, delivered, undelivered, failed, received…' },
    direction: { type: 'string' },
    num_segments: { type: 'string' },
    num_media: { type: 'string' },
    price: { type: ['string', 'null'] },
    price_unit: { type: ['string', 'null'] },
    error_code: { type: ['integer', 'null'] },
    error_message: { type: ['string', 'null'] },
    date_created: { type: ['string', 'null'] },
    date_updated: { type: ['string', 'null'] },
    date_sent: { type: ['string', 'null'] },
    uri: { type: 'string' },
  },
  required: ['sid', 'to', 'status'],
};

/** One output item of a Call operation (Twilio's Call resource). */
const CALL_SCHEMA: JsonObject = {
  type: 'object',
  properties: {
    sid: { type: 'string', description: 'The call SID (CA…)' },
    account_sid: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    status: { type: 'string', description: 'queued, ringing, in-progress, completed, busy, failed, no-answer, canceled' },
    direction: { type: 'string' },
    duration: { type: ['string', 'null'] },
    price: { type: ['string', 'null'] },
    price_unit: { type: ['string', 'null'] },
    start_time: { type: ['string', 'null'] },
    end_time: { type: ['string', 'null'] },
    date_created: { type: ['string', 'null'] },
    date_updated: { type: ['string', 'null'] },
    uri: { type: 'string' },
  },
  required: ['sid', 'to', 'from', 'status'],
};

const listProperties = (resource: 'message' | 'call'): PropertyDescriptor[] => [
  {
    name: 'returnAll',
    displayName: 'Return All',
    type: 'boolean',
    default: false,
    displayOptions: { show: { resource: [resource], operation: ['list'] } },
    description: 'Whether to return all results or only up to a limit',
  },
  {
    name: 'limit',
    displayName: 'Limit',
    type: 'number',
    default: 50,
    typeOptions: { minValue: 1 },
    displayOptions: { show: { resource: [resource], operation: ['list'], returnAll: [false] } },
    description: 'Max number of results to return',
  },
];

export const Twilio = defineNode({
  description: {
    name: 'twilio',
    displayName: 'Twilio',
    description: 'Send SMS, MMS and WhatsApp messages, place calls, and read messages and calls through the Twilio REST API',
    version: 1,
    kind: 'action',
    categories: ['Communication'],
    icon: 'file:twilio.svg',
    color: '#F22F46',
    subtitle: '{{operation}}: {{resource}}',
    documentationUrl: 'https://www.twilio.com/docs/messaging/api/message-resource',
    keywords: ['twilio', 'sms', 'mms', 'whatsapp', 'call', 'voice', 'phone'],
    usableAsTool: true,
    toolDescription: 'Send an SMS, MMS or WhatsApp message or place a phone call with Twilio, or look up messages and calls. Phone numbers are E.164 (+15551234567).',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'twilioApi', required: true }],
    // Sends and calls are at most once; the read operations below override this with `idempotent: true`.
    idempotent: false,
    outputSchema: MESSAGE_SCHEMA,
    properties: [
      {
        name: 'resource',
        displayName: 'Resource',
        type: 'options',
        noDataExpression: true,
        default: 'message',
        options: [
          { name: 'Message', value: 'message' },
          { name: 'Call', value: 'call' },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'make',
        displayOptions: { show: { resource: ['call'] } },
        options: [
          { name: 'Make', value: 'make', description: 'Place an outbound call that runs TwiML, inline or from a URL', action: 'Make a call', idempotent: false, outputSchema: CALL_SCHEMA },
          { name: 'Get', value: 'get', description: 'Fetch one call by SID', action: 'Get a call', idempotent: true, outputSchema: CALL_SCHEMA },
          { name: 'List', value: 'list', description: 'List calls, newest first, filtered by To, From, status and start time', action: 'List calls', idempotent: true, outputSchema: CALL_SCHEMA },
        ],
      },
      // The default resource's operation comes last: parameter defaults are keyed by name, last one wins.
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'send',
        displayOptions: { show: { resource: ['message'] } },
        options: [
          { name: 'Send SMS', value: 'send', description: 'Send a text message', action: 'Send an SMS', idempotent: false },
          { name: 'Send MMS', value: 'sendMms', description: 'Send a message with media attachments (US and Canada)', action: 'Send an MMS', idempotent: false },
          { name: 'Send WhatsApp', value: 'sendWhatsApp', description: 'Send a WhatsApp message from a WhatsApp-enabled sender', action: 'Send a WhatsApp message', idempotent: false },
          { name: 'Get', value: 'get', description: 'Fetch one message by SID', action: 'Get a message', idempotent: true },
          { name: 'List', value: 'list', description: 'List messages, newest first, filtered by To, From and date sent', action: 'List messages', idempotent: true },
        ],
      },
      // --- Message: send ---
      {
        name: 'from',
        displayName: 'From',
        type: 'string',
        required: true,
        default: '',
        placeholder: '+15551234567 or MGxxxxxxxx…',
        displayOptions: message(MESSAGE_SENDS),
        description: 'The Twilio phone number (E.164) or a Messaging Service SID (MG…) to send from. For WhatsApp, the WhatsApp-enabled number; the whatsapp: prefix is added for you',
      },
      {
        name: 'to',
        displayName: 'To',
        type: 'string',
        required: true,
        default: '',
        placeholder: '+15557654321',
        displayOptions: message(MESSAGE_SENDS),
        description: 'The recipient’s phone number in E.164 format (the whatsapp: prefix is added for WhatsApp)',
      },
      {
        name: 'body',
        displayName: 'Message',
        type: 'string',
        required: true,
        default: '',
        typeOptions: { rows: 3 },
        displayOptions: message(['send', 'sendWhatsApp']),
        description: 'The text of the message (up to 1,600 characters; longer texts are split into segments)',
      },
      {
        name: 'body',
        displayName: 'Message',
        type: 'string',
        default: '',
        typeOptions: { rows: 3 },
        displayOptions: message(['sendMms']),
        description: 'Optional text sent with the media',
      },
      {
        name: 'mediaUrls',
        displayName: 'Media URLs',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        placeholder: 'Add Media URL',
        displayOptions: message(['sendMms', 'sendWhatsApp']),
        description: 'Public URLs of the media to attach (up to 10 for MMS, 1 for WhatsApp; 5 MB each). An expression may also give a JSON array or one URL per line',
        groups: [{ name: 'urls', displayName: 'Media URL', values: [{ name: 'url', displayName: 'URL', type: 'string', default: '', placeholder: 'https://example.com/picture.jpg' }] }],
      },
      {
        name: 'additionalFields',
        displayName: 'Additional Fields',
        type: 'collection',
        default: {},
        placeholder: 'Add Field',
        displayOptions: message(MESSAGE_SENDS),
        values: [
          { name: 'statusCallback', displayName: 'Status Callback URL', type: 'string', default: '', description: 'URL Twilio posts delivery status updates to' },
          { name: 'validityPeriod', displayName: 'Validity Period (s)', type: 'number', default: 14400, description: 'Seconds the message may stay queued before Twilio gives up (1–14400)' },
          { name: 'sendAt', displayName: 'Send At', type: 'string', default: '', placeholder: '2026-11-01T09:00:00Z', description: 'Schedule the message (ISO 8601, needs a Messaging Service as From)' },
          { name: 'contentSid', displayName: 'Content Template SID', type: 'string', default: '', placeholder: 'HXxxxxxxxx…', description: 'WhatsApp: send an approved content template instead of free text' },
          { name: 'contentVariables', displayName: 'Content Variables', type: 'json', default: '', description: 'WhatsApp: JSON object of template variables, e.g. {"1":"Ann"}' },
        ],
      },
      // --- Message: get ---
      {
        name: 'messageSid',
        displayName: 'Message SID',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        displayOptions: message(['get']),
      },
      // --- Message: list ---
      ...listProperties('message'),
      {
        name: 'filters',
        displayName: 'Filters',
        type: 'collection',
        default: {},
        placeholder: 'Add Filter',
        displayOptions: message(['list']),
        values: [
          { name: 'to', displayName: 'To', type: 'string', default: '', description: 'Only messages sent to this number (E.164; whatsapp:+… for WhatsApp)' },
          { name: 'from', displayName: 'From', type: 'string', default: '', description: 'Only messages sent from this number' },
          { name: 'dateSent', displayName: 'Date Sent', type: 'string', default: '', placeholder: 'YYYY-MM-DD', description: 'Only messages sent on this day (UTC)' },
          { name: 'dateSentAfter', displayName: 'Date Sent After', type: 'string', default: '', placeholder: 'YYYY-MM-DD', description: 'Only messages sent after this day (UTC)' },
          { name: 'dateSentBefore', displayName: 'Date Sent Before', type: 'string', default: '', placeholder: 'YYYY-MM-DD', description: 'Only messages sent before this day (UTC)' },
        ],
      },
      // --- Call: make ---
      {
        name: 'callFrom',
        displayName: 'From',
        type: 'string',
        required: true,
        default: '',
        placeholder: '+15551234567',
        displayOptions: call(['make']),
        description: 'The Twilio phone number (E.164) that places the call',
      },
      {
        name: 'callTo',
        displayName: 'To',
        type: 'string',
        required: true,
        default: '',
        placeholder: '+15557654321',
        displayOptions: call(['make']),
        description: 'The phone number to call (E.164), or a SIP address or client identifier',
      },
      {
        name: 'callSource',
        displayName: 'Instructions',
        type: 'options',
        default: 'twiml',
        displayOptions: call(['make']),
        options: [
          { name: 'TwiML', value: 'twiml', description: 'TwiML given here' },
          { name: 'URL', value: 'url', description: 'A URL Twilio fetches TwiML from when the call connects' },
        ],
      },
      {
        name: 'twiml',
        displayName: 'TwiML',
        type: 'string',
        required: true,
        default: '<Response><Say>Hello from Landflow</Say></Response>',
        typeOptions: { rows: 4 },
        displayOptions: call(['make'], { callSource: ['twiml'] }),
        description: 'The TwiML that runs when the call is answered (up to 4,000 characters)',
      },
      {
        name: 'url',
        displayName: 'TwiML URL',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'https://example.com/voice.xml',
        displayOptions: call(['make'], { callSource: ['url'] }),
      },
      {
        name: 'callOptions',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add Option',
        displayOptions: call(['make']),
        values: [
          { name: 'statusCallback', displayName: 'Status Callback URL', type: 'string', default: '', description: 'URL Twilio posts call status updates to' },
          { name: 'timeout', displayName: 'Ring Timeout (s)', type: 'number', default: 60, description: 'Seconds to let the phone ring (5–600)' },
          { name: 'record', displayName: 'Record', type: 'boolean', default: false, description: 'Whether to record the call' },
          { name: 'machineDetection', displayName: 'Machine Detection', type: 'options', default: '', options: [{ name: 'Off', value: '' }, { name: 'Enable', value: 'Enable' }, { name: 'Detect Message End', value: 'DetectMessageEnd' }] },
        ],
      },
      // --- Call: get ---
      {
        name: 'callSid',
        displayName: 'Call SID',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        displayOptions: call(['get']),
      },
      // --- Call: list ---
      ...listProperties('call'),
      {
        name: 'callFilters',
        displayName: 'Filters',
        type: 'collection',
        default: {},
        placeholder: 'Add Filter',
        displayOptions: call(['list']),
        values: [
          { name: 'to', displayName: 'To', type: 'string', default: '', description: 'Only calls to this number' },
          { name: 'from', displayName: 'From', type: 'string', default: '', description: 'Only calls from this number' },
          {
            name: 'status',
            displayName: 'Status',
            type: 'options',
            default: '',
            options: [
              { name: 'Any', value: '' },
              { name: 'Queued', value: 'queued' },
              { name: 'Ringing', value: 'ringing' },
              { name: 'In Progress', value: 'in-progress' },
              { name: 'Completed', value: 'completed' },
              { name: 'Busy', value: 'busy' },
              { name: 'Failed', value: 'failed' },
              { name: 'No Answer', value: 'no-answer' },
              { name: 'Canceled', value: 'canceled' },
            ],
          },
          { name: 'startTime', displayName: 'Start Time', type: 'string', default: '', placeholder: 'YYYY-MM-DD', description: 'Only calls that started on this day (UTC)' },
          { name: 'startTimeAfter', displayName: 'Start Time After', type: 'string', default: '', placeholder: 'YYYY-MM-DD' },
          { name: 'startTimeBefore', displayName: 'Start Time Before', type: 'string', default: '', placeholder: 'YYYY-MM-DD' },
        ],
      },
    ],
  },
  async execute(ctx) {
    const credentials = ctx.getCredentials<TwilioCredentials>('twilioApi');
    const api: ApiContext = { http: ctx.http, metrics: ctx.metrics };
    const bounds: CallBounds = { signal: ctx.signal, deadline: ctx.deadline };
    const account = accountPath(credentials);
    return mapItems(ctx, async (i) => {
      const resource = ctx.getNodeParameter<string>('resource', i);
      const operation = ctx.getNodeParameter<string>('operation', i);
      const collection = (name: string): JsonObject => (ctx.getNodeParameter<JsonObject>(name, i, {}) as JsonObject | undefined) ?? {};
      const text = (object: JsonObject, name: string): string | undefined => {
        const value = object[name];
        return value === undefined || value === null || value === '' ? undefined : String(value);
      };
      const listLimit = () => (ctx.getNodeParameter<boolean>('returnAll', i, false) ? Infinity : Math.max(1, Number(ctx.getNodeParameter('limit', i, 50)) || 50));

      if (resource === 'message') {
        if (MESSAGE_SENDS.includes(operation)) return sendMessage(ctx, api, credentials, account, operation, i, bounds, collection, text);
        if (operation === 'get') {
          const sid = requireString(ctx, 'messageSid', 'Message SID', i);
          return twilioCall<JsonObject>(api, credentials, 'GET', `${account}/Messages/${encodeURIComponent(sid)}.json`, undefined, bounds);
        }
        if (operation === 'list') {
          const filters = collection('filters');
          return listAll<JsonObject>(
            api,
            credentials,
            `${account}/Messages.json`,
            'messages',
            { To: text(filters, 'to'), From: text(filters, 'from'), DateSent: text(filters, 'dateSent'), 'DateSent>': text(filters, 'dateSentAfter'), 'DateSent<': text(filters, 'dateSentBefore') },
            listLimit(),
            bounds,
          );
        }
        throw unsupported(resource, operation);
      }

      if (resource === 'call') {
        if (operation === 'make') {
          const from = requireString(ctx, 'callFrom', 'From', i);
          const to = requireString(ctx, 'callTo', 'To', i);
          const source = ctx.getNodeParameter<string>('callSource', i, 'twiml');
          const options = collection('callOptions');
          const body = formBody({
            To: to,
            From: from,
            ...(source === 'url' ? { Url: requireString(ctx, 'url', 'TwiML URL', i) } : { Twiml: requireString(ctx, 'twiml', 'TwiML', i) }),
            StatusCallback: text(options, 'statusCallback'),
            Timeout: text(options, 'timeout'),
            Record: options.record === true ? 'true' : undefined,
            MachineDetection: text(options, 'machineDetection'),
          });
          const result = await twilioCall<JsonObject>(api, credentials, 'POST', `${account}/Calls.json`, body, bounds);
          countSent(api, 'twilio', operation);
          return result;
        }
        if (operation === 'get') {
          const sid = requireString(ctx, 'callSid', 'Call SID', i);
          return twilioCall<JsonObject>(api, credentials, 'GET', `${account}/Calls/${encodeURIComponent(sid)}.json`, undefined, bounds);
        }
        if (operation === 'list') {
          const filters = collection('callFilters');
          return listAll<JsonObject>(
            api,
            credentials,
            `${account}/Calls.json`,
            'calls',
            {
              To: text(filters, 'to'),
              From: text(filters, 'from'),
              Status: text(filters, 'status'),
              StartTime: text(filters, 'startTime'),
              'StartTime>': text(filters, 'startTimeAfter'),
              'StartTime<': text(filters, 'startTimeBefore'),
            },
            listLimit(),
            bounds,
          );
        }
        throw unsupported(resource, operation);
      }
      throw unsupported(resource, operation);
    });
  },
});

/** Send SMS / MMS / WhatsApp: one `POST /Messages.json`, form-encoded; never retried except after a 429 (nothing was created). */
async function sendMessage(
  ctx: IExecuteContext,
  api: ApiContext,
  credentials: TwilioCredentials,
  account: string,
  operation: string,
  i: number,
  bounds: CallBounds,
  collection: (name: string) => JsonObject,
  text: (object: JsonObject, name: string) => string | undefined,
): Promise<JsonObject> {
  const whatsapp = operation === 'sendWhatsApp';
  const prefix = whatsapp ? 'whatsapp:' : '';
  const from = requireString(ctx, 'from', 'From', i);
  const to = withChannel(requireString(ctx, 'to', 'To', i), prefix);
  const media = mediaUrls(ctx.getNodeParameter('mediaUrls', i, {}));
  const bodyText = String(ctx.getNodeParameter('body', i, '') ?? '').trim();
  const extra = collection('additionalFields');
  const contentSid = text(extra, 'contentSid');
  if (operation === 'send' && !bodyText) throw new NodeOperationError('Message is required', { itemIndex: i });
  if (operation === 'sendMms' && !media.length) throw new NodeOperationError('At least one Media URL is required for an MMS', { itemIndex: i });
  if (whatsapp && !bodyText && !media.length && !contentSid) throw new NodeOperationError('A WhatsApp message needs a Message, a Media URL or a Content Template SID', { itemIndex: i });
  if (media.length > 10) throw new NodeOperationError('At most 10 Media URLs can be attached', { itemIndex: i });
  let contentVariables: string | undefined;
  const rawVariables = extra.contentVariables;
  if (rawVariables !== undefined && rawVariables !== null && rawVariables !== '') {
    contentVariables = typeof rawVariables === 'string' ? rawVariables : JSON.stringify(rawVariables);
    try {
      const parsed: JsonValue = JSON.parse(contentVariables);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    } catch {
      throw new NodeOperationError('Content Variables must be a JSON object', { itemIndex: i });
    }
  }
  const body = formBody({
    To: to,
    ...senderFields(from, prefix),
    Body: bodyText || undefined,
    MediaUrl: media,
    StatusCallback: text(extra, 'statusCallback'),
    ValidityPeriod: extra.validityPeriod !== undefined && extra.validityPeriod !== 14400 ? text(extra, 'validityPeriod') : undefined,
    SendAt: text(extra, 'sendAt'),
    ScheduleType: text(extra, 'sendAt') ? 'fixed' : undefined,
    ContentSid: contentSid,
    ContentVariables: contentVariables,
  });
  const result = await twilioCall<JsonObject>(api, credentials, 'POST', `${account}/Messages.json`, body, bounds);
  countSent(api, 'twilio', operation);
  return result;
}
