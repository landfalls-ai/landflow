/**
 * The Landledger endpoints the nodes use (Landledger's docs/reference/api.md, wave 2 contract in its
 * libs/contracts/src/requests.ts), over the shared HTTP client. Nothing here reads node parameters.
 */
import { NodeOperationError, type JsonObject } from '@landflow/sdk';
import { baseUrl, expectOk, fetchLandledger, type ApiContext, type ApiResponse, type LandledgerCredentials, type LandledgerRelayCredentials, type Scope } from './shared';

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: object;
  /** The scope the call needs, for the 403 hint. */
  scope?: Scope;
}

const enc = encodeURIComponent;

export class Landledger {
  readonly base: string;
  constructor(
    private readonly api: ApiContext,
    private readonly credentials: LandledgerCredentials | LandledgerRelayCredentials,
  ) {
    this.base = baseUrl(credentials.baseUrl);
  }

  private token(): string {
    const key = typeof this.credentials.apiKey === 'string' ? this.credentials.apiKey.trim() : '';
    if (!key) throw new NodeOperationError('The Landledger credential has no API Key');
    return key;
  }

  /** One authenticated request; the caller decides what a non-2xx status means. */
  raw(method: string, path: string, options: RequestOptions = {}): Promise<ApiResponse> {
    const query = Object.entries(options.query ?? {}).filter(([, v]) => v !== undefined && v !== '');
    const qs = query.length ? `?${new URLSearchParams(query.map(([k, v]) => [k, String(v)]))}` : '';
    return fetchLandledger(this.api, `${this.base}${path}${qs}`, {
      method,
      headers: { authorization: `Bearer ${this.token()}`, accept: 'application/json', ...(options.body && { 'content-type': 'application/json' }) },
      ...(options.body && { body: JSON.stringify(options.body) }),
    });
  }

  async json<T = any>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    return expectOk(await this.raw(method, path, options), { scope: options.scope ?? (method === 'GET' ? 'read' : undefined) }) as T;
  }

  /** `GET /api/health` (no auth). */
  async health(): Promise<JsonObject> {
    const response = await fetchLandledger(this.api, `${this.base}/api/health`, { method: 'GET', headers: { accept: 'application/json' } });
    return expectOk(response) as JsonObject;
  }

  /** `GET /api/auth/me`: who the key is and its scopes. */
  me() {
    return this.json<{ kind: string; user: { id: string; name: string }; scopes: string[] }>('GET', '/api/auth/me');
  }

  /** `GET /api/budgets?month=`: a row per cost center (budget, actual, reserved, available, forecast, state). */
  budgets(month?: string) {
    return this.json<{ month: string; currency: string; rows: JsonObject[]; totals: JsonObject }>('GET', '/api/budgets', { query: { month } });
  }

  /** `GET /api/spend`: spend grouped by a dimension over a month or a range of days. */
  spend(query: { by: string; month?: string; from?: string; to?: string; filter?: string; layer?: string; provisional?: string }) {
    return this.json<JsonObject>('GET', '/api/spend', { query });
  }

  /** `GET /api/periods`: every month the ledger knows, newest first. */
  periods() {
    return this.json<{ periods: JsonObject[] }>('GET', '/api/periods');
  }

  requests(query: { box?: string; status?: string; kind?: string; costCenter?: string; limit?: number }) {
    return this.json<{ requests: JsonObject[]; counts: JsonObject }>('GET', '/api/requests', { query });
  }

  /** `{ request, evidence, evidenceSha256 }`. */
  request(id: string) {
    return this.json<{ request: JsonObject; evidence: JsonObject; evidenceSha256: string }>('GET', `/api/requests/${enc(id)}`);
  }

  /** `POST /api/requests`: 201 for a new request, 200 when the idempotency key returned the first. */
  async createRequest(body: JsonObject): Promise<{ request: JsonObject; created: boolean }> {
    const response = await this.raw('POST', '/api/requests', { body, scope: 'requests:write' });
    const answer = expectOk(response, { scope: 'requests:write' }) as { request: JsonObject };
    return { request: answer.request, created: response.status === 201 };
  }

  markApplied(id: string, body: { note: string; links: { label: string; url: string }[] }) {
    return this.json<JsonObject>('POST', `/api/requests/${enc(id)}/applied`, { body, scope: 'requests:write' });
  }

  /**
   * `POST /api/relays/slack` with a `decisions:relay` key: the raw Slack interaction (body and signature headers as
   * Slack sent them). Landledger verifies it and decides as the person who linked that Slack user: `{ request, decision }`.
   */
  relaySlack(body: { body: string; signature: string; timestamp: string; channelId?: string }) {
    return this.json<{ request: JsonObject; decision: JsonObject }>('POST', '/api/relays/slack', { body, scope: 'decisions:relay' });
  }

  /** `POST /api/reservations`: 201 for a new reservation, 200 when that month's exists. */
  async reserve(body: { requestId: string; month?: string; amount?: string }): Promise<{ reservation: JsonObject; created: boolean }> {
    const response = await this.raw('POST', '/api/reservations', { body, scope: 'reservations:write' });
    const answer = expectOk(response, { scope: 'reservations:write' }) as JsonObject;
    const reservation = (answer?.reservation && typeof answer.reservation === 'object' ? answer.reservation : answer) as JsonObject;
    return { reservation, created: response.status === 201 };
  }

  async release(id: string, reason: string): Promise<JsonObject> {
    const answer = await this.json<JsonObject>('POST', `/api/reservations/${enc(id)}/release`, { body: reason ? { reason } : {}, scope: 'reservations:write' });
    return (answer?.reservation && typeof answer.reservation === 'object' ? answer.reservation : answer) as JsonObject;
  }

  /** A `webhooks:write` key lists only the subscriptions it created. */
  webhooks() {
    return this.json<{ webhooks: JsonObject[] }>('GET', '/api/webhooks', { scope: 'webhooks:write' });
  }

  /** Answers with the `whsec_` signing secret, once. */
  createWebhook(body: { url: string; events: string[]; description: string }) {
    return this.json<JsonObject>('POST', '/api/webhooks', { body, scope: 'webhooks:write' });
  }

  /** Delete a webhook; true when it was there, false when it was already gone (404). */
  async deleteWebhook(id: string): Promise<boolean> {
    const response = await this.raw('DELETE', `/api/webhooks/${enc(id)}`);
    if (response.status === 404) return false;
    expectOk(response, { scope: 'webhooks:write' });
    return true;
  }
}
