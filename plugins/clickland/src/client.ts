/** The Clickland endpoints the nodes use (docs: Clickland's docs/reference/api.md), over the shared HTTP client. Nothing here reads node parameters. */
import { NodeOperationError, type JsonObject } from '@landflow/sdk';
import { baseUrl, expectOk, fetchClickland, type ApiContext, type ApiResponse, type ClicklandCredentials, type Scope, type TimeRange } from './shared';

export type Signal = 'logs' | 'traces';

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: object;
  /** The scope the call needs, for the 403 hint. */
  scope?: Scope;
}

const enc = encodeURIComponent;

export class Clickland {
  readonly base: string;
  constructor(
    private readonly api: ApiContext,
    private readonly credentials: ClicklandCredentials,
  ) {
    this.base = baseUrl(credentials.baseUrl);
  }

  private token(): string {
    const key = typeof this.credentials.apiKey === 'string' ? this.credentials.apiKey.trim() : '';
    if (!key) throw new NodeOperationError('The Clickland credential has no API Key');
    return key;
  }

  /** One authenticated request; the caller decides what a non-2xx status means. */
  raw(method: string, path: string, options: RequestOptions = {}): Promise<ApiResponse> {
    const query = Object.entries(options.query ?? {}).filter(([, v]) => v !== undefined && v !== '');
    const qs = query.length ? `?${new URLSearchParams(query.map(([k, v]) => [k, String(v)]))}` : '';
    return fetchClickland(this.api, `${this.base}${path}${qs}`, {
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
    const response = await fetchClickland(this.api, `${this.base}/api/health`, { method: 'GET', headers: { accept: 'application/json' } });
    return expectOk(response) as JsonObject;
  }

  search(body: { signal: Signal; query: string; limit?: number; before?: string } & TimeRange) {
    return this.json<{ rows: JsonObject[]; nextCursor: string | null; stats?: JsonObject }>('POST', '/api/search', { body, scope: 'read' });
  }

  histogram(body: { signal: Signal; query: string; groupBy?: string } & TimeRange) {
    return this.json<JsonObject>('POST', '/api/search/histogram', { body, scope: 'read' });
  }

  patterns(body: { signal: Signal; query: string; sample?: number } & TimeRange) {
    return this.json<JsonObject>('POST', '/api/patterns', { body, scope: 'read' });
  }

  trace(traceId: string) {
    return this.json<JsonObject>('GET', `/api/traces/${enc(traceId)}`);
  }

  services(range: TimeRange) {
    return this.json<{ services: JsonObject[] }>('GET', '/api/services', { query: { ...range } });
  }

  metricNames(range: TimeRange) {
    return this.json<{ metrics: JsonObject[] }>('GET', '/api/metrics/names', { query: { ...range } });
  }

  metricQuery(body: JsonObject) {
    return this.json<JsonObject>('POST', '/api/metrics/query', { body, scope: 'read' });
  }

  alerts() {
    return this.json<{ alerts: JsonObject[] }>('GET', '/api/alerts');
  }

  alert(id: string) {
    return this.json<JsonObject>('GET', `/api/alerts/${enc(id)}`);
  }

  createAlert(body: JsonObject) {
    return this.json<JsonObject>('POST', '/api/alerts', { body, scope: 'alerts:write' });
  }

  updateAlert(id: string, body: JsonObject) {
    return this.json<JsonObject>('PUT', `/api/alerts/${enc(id)}`, { body, scope: 'alerts:write' });
  }

  async deleteAlert(id: string): Promise<void> {
    expectOk(await this.raw('DELETE', `/api/alerts/${enc(id)}`), { scope: 'alerts:write' });
  }

  /** Newest first. */
  alertEvents(id: string, limit?: number) {
    return this.json<{ events: JsonObject[] }>('GET', `/api/alerts/${enc(id)}/events`, { query: { limit } });
  }

  notes(query: { service?: string; q?: string; limit?: number }) {
    return this.json<{ notes: JsonObject[] }>('GET', '/api/notes', { query });
  }

  createNote(body: JsonObject) {
    return this.json<JsonObject>('POST', '/api/notes', { body, scope: 'notes:write' });
  }

  knowledge(body: { query: string; from?: string; to?: string; limit?: number }) {
    return this.json<{ results: JsonObject[] }>('POST', '/api/knowledge/search', { body, scope: 'read' });
  }

  renderView(spec: JsonObject, pinned = false) {
    return this.json<JsonObject>('POST', '/api/views', { body: { spec, pinned }, scope: 'read' });
  }

  view(id: string) {
    return this.json<JsonObject>('GET', `/api/views/${enc(id)}`);
  }

  views(query: { pinned?: boolean }) {
    return this.json<{ views: JsonObject[] }>('GET', '/api/views', { query });
  }

  updateView(id: string, body: JsonObject) {
    return this.json<JsonObject>('PUT', `/api/views/${enc(id)}`, { body, scope: 'read' });
  }

  addPanel(id: string, panel: JsonObject, position?: number) {
    return this.json<JsonObject>('POST', `/api/views/${enc(id)}/panels`, { body: { panel, ...(position !== undefined && { position }) }, scope: 'read' });
  }

  async removePanel(id: string, index: number): Promise<JsonObject | undefined> {
    const response = await this.raw('DELETE', `/api/views/${enc(id)}/panels/${index}`);
    return (expectOk(response, { scope: 'read' }) as JsonObject | undefined) ?? undefined;
  }

  createWebhook(body: { url: string; events: string[]; alertId: string | null; description: string }) {
    return this.json<JsonObject>('POST', '/api/webhooks', { body, scope: 'webhooks:write' });
  }

  /** The webhook, or undefined when Clickland answers 404. */
  async webhook(id: string): Promise<JsonObject | undefined> {
    const response = await this.raw('GET', `/api/webhooks/${enc(id)}`);
    if (response.status === 404) return undefined;
    return expectOk(response, { scope: 'read' }) as JsonObject;
  }

  /** Delete a webhook; true when it was there, false when it was already gone (404). */
  async deleteWebhook(id: string): Promise<boolean> {
    const response = await this.raw('DELETE', `/api/webhooks/${enc(id)}`);
    if (response.status === 404) return false;
    expectOk(response, { scope: 'webhooks:write' });
    return true;
  }
}
