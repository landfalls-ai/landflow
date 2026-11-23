/** The Attio REST API (v2): credentials, one request function with error mapping, paging and small helpers. */
import { defineCredentialType, NodeOperationError, type IExecuteContext, type JsonObject, type NodeItem, type PropertyDescriptor, type TracedFetch } from '@landflow/sdk';

export interface AttioCredentials extends JsonObject {
  accessToken: string;
  baseUrl: string;
}

export const DEFAULT_BASE_URL = 'https://api.attio.com';
const TIMEOUT_MS = 30_000;

export const asObject = (value: unknown): JsonObject | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined);
export const asString = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** An Attio failure with its HTTP status, so callers can treat 404 as "gone". */
export class AttioError extends NodeOperationError {
  constructor(
    message: string,
    readonly status: number | undefined,
    description?: string,
  ) {
    super(message, description ? { description } : {});
    this.name = 'AttioError';
  }
}

function hint(status: number, code: string | undefined, message: string): string | undefined {
  if (status === 401) return 'Attio rejected the token (unauthorized). Use a workspace access token from Settings, Developers, or Connect the Attio OAuth2 credential again.';
  if (status === 403) return `The token lacks a scope or access for this call (${message}). Add the scope in the Attio developer settings (OAuth apps: the app's Scopes tab) and create a new token.`;
  if (status === 404 && code === 'not_found') return 'Check the object, list or record ID: Attio found nothing there.';
  if (status === 409) return 'Attio already has an equal entry (for webhooks, each target URL, event type and filter must be unique in the workspace).';
  if (status === 429) return 'Attio rate limit reached (100 reads and 25 writes per second); retry after the time in the Retry-After header.';
  return undefined;
}

export interface CallOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Statuses that are returned instead of thrown (default none). */
  allow?: number[];
}

/** One call to `/v2/<path>`. Returns the parsed JSON (or `{}`); errors become AttioError. */
export async function attioCall<T = any>(http: TracedFetch, credentials: AttioCredentials, method: string, path: string, options: CallOptions = {}): Promise<T> {
  const base = (String(credentials.baseUrl ?? '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined && value !== '') query.set(key, String(value));
  const url = `${base}/v2${path}${query.size ? `?${query}` : ''}`;
  const headers: Record<string, string> = { authorization: `Bearer ${credentials.accessToken}`, accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await http(url, { method, headers, ...(options.body !== undefined && { body: JSON.stringify(options.body) }), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const timeout = (error as Error)?.name === 'TimeoutError';
    throw new AttioError(`Attio API request failed: ${timeout ? `no answer within ${TIMEOUT_MS / 1000} s` : (error as Error)?.message ?? String(error)}`, undefined);
  }
  const text = await response.text();
  let body: any = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 200) };
    }
  }
  if (response.ok || options.allow?.includes(response.status)) return body as T;
  const message = String(body?.message ?? body?.raw ?? `HTTP ${response.status}`);
  const retry = response.status === 429 ? response.headers.get('retry-after') : null;
  throw new AttioError(`Attio API error ${response.status}: ${message}${retry ? ` (retry after ${retry})` : ''}`, response.status, hint(response.status, body?.code, message));
}

export const isNotFound = (error: unknown) => error instanceof AttioError && error.status === 404;

/** The credential's workspace behind GET /v2/self; `active: false` is how Attio answers an unknown token. */
export async function identify(http: TracedFetch, credentials: AttioCredentials) {
  const self = await attioCall<JsonObject>(http, credentials, 'GET', '/self');
  if (self.active !== true) throw new AttioError('Attio says the token is not active', 401, hint(401, undefined, ''));
  return self;
}

async function testCredentials(data: AttioCredentials, ctx: { http: TracedFetch }) {
  try {
    const self = await identify(ctx.http, data);
    return { ok: true, message: `Connected to workspace ${String(self.workspace_name ?? self.workspace_id ?? 'unknown')} (${String(self.token_level ?? 'workspace')} token, scopes: ${String(self.scope ?? 'none')})` };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

const baseUrlProperty: PropertyDescriptor = {
  name: 'baseUrl',
  displayName: 'Base URL',
  type: 'string',
  default: DEFAULT_BASE_URL,
  description: 'Change it only for a proxy or a test double',
};

export const attioApi = defineCredentialType<AttioCredentials>({
  name: 'attioApi',
  displayName: 'Attio API',
  icon: 'file:attio.svg',
  documentationUrl: 'https://docs.attio.com/rest-api/guides/authentication',
  description: 'A workspace access token (API key) made under Settings, Developers in Attio, with the scopes the nodes need (see the plugin README).',
  properties: [
    { name: 'accessToken', displayName: 'Access Token', type: 'string', required: true, typeOptions: { password: true }, description: 'The workspace access token, sent as a Bearer token' },
    baseUrlProperty,
  ],
  test: testCredentials,
});

const hidden = (name: string, displayName: string, value: string): PropertyDescriptor => ({ name, displayName, type: 'hidden', default: value });

/**
 * Attio OAuth2: extends the host's generic OAuth2 type. The scopes are not part of the authorize request; they are set
 * on the app at build.attio.com (Scopes tab), so the Scope field stays empty.
 */
export const attioOAuth2Api = defineCredentialType<AttioCredentials>({
  name: 'attioOAuth2Api',
  displayName: 'Attio OAuth2 API',
  icon: 'file:attio.svg',
  documentationUrl: 'https://docs.attio.com/rest-api/tutorials/connect-an-app-through-oauth',
  description:
    'Sign in with Attio: create an app at build.attio.com, add the redirect URL shown below on its OAuth tab, enable the scopes on its Scopes tab (read for records, lists, notes, tasks and members; write for the Note, Task and Add to List actions; webhook:read-write for the trigger), then Connect. Attio sends no refresh token, the access token does not expire.',
  extends: ['oAuth2Api'],
  properties: [
    hidden('grantType', 'Grant Type', 'authorizationCode'),
    hidden('authUrl', 'Authorization URL', 'https://app.attio.com/authorize'),
    hidden('accessTokenUrl', 'Access Token URL', 'https://app.attio.com/oauth/token'),
    hidden('authentication', 'Client Authentication', 'body'),
    hidden('scope', 'Scope', ''),
    baseUrlProperty,
  ],
  test: testCredentials,
});

export const attioCredentials = (ctx: { getCredentials: IExecuteContext['getCredentials'] }, authentication?: unknown): AttioCredentials => {
  const [want, other] = authentication === 'oAuth2' ? ['attioOAuth2Api', 'attioApi'] : ['attioApi', 'attioOAuth2Api'];
  return ctx.getCredentials<AttioCredentials>(want, { optional: true }) ?? ctx.getCredentials<AttioCredentials>(other, { optional: true }) ?? ctx.getCredentials<AttioCredentials>(want);
};

/** Runs `fn` for every input item; a failure stops the node unless it continues on fail. */
export async function mapItems(ctx: IExecuteContext, fn: (index: number) => Promise<JsonObject | JsonObject[]>): Promise<NodeItem[]> {
  const out: NodeItem[] = [];
  const count = ctx.getInputData().length;
  for (let i = 0; i < count; i++) {
    try {
      const result = await fn(i);
      for (const json of Array.isArray(result) ? result : [result]) out.push({ json, pairedItem: { item: i } });
    } catch (error) {
      const e = error as NodeOperationError;
      const failure = new NodeOperationError(e.message, { itemIndex: i, ...(e.description && { description: e.description }) });
      if (!ctx.continueOnFail()) throw failure;
      out.push({ json: { error: failure.message, ...(failure.description && { description: failure.description }) }, pairedItem: { item: i } });
    }
  }
  return out;
}
