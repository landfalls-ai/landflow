/** The Landfall endpoints the nodes use, over the shared HTTP client. Nothing here reads node parameters. */
import { NodeOperationError, type JsonObject } from '@landflow/sdk';
import { baseUrl, expectOk, fetchLandfall, landfallError, type ApiContext } from './shared';

export interface LandfallCredentials extends JsonObject {
  baseUrl: string;
  orgSlug: string;
  apiKey: string;
  ingestToken: string;
  connectionId: string;
}

export interface HeartbeatCredentials extends JsonObject {
  baseUrl: string;
  orgSlug: string;
  token: string;
}

export interface IncidentView extends JsonObject {
  id: string;
  number: number;
  status: string;
}

export interface TimelineEvent extends JsonObject {
  seq: number;
  type: string;
}

export type Severity = 'sev1' | 'sev2' | 'sev3' | 'sev4';

/** Statuses (lower-case) that mean the incident is over. */
export const ENDED_STATUSES = ['resolved', 'closed', 'mitigated', 'recovered', 'done', 'archived'];
export const isEnded = (status: unknown) => typeof status === 'string' && ENDED_STATUSES.includes(status.toLowerCase());

interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: JsonObject;
}

/** One request with a bearer token; the caller decides what a non-2xx status means. */
export function request(api: ApiContext, base: string, token: string, method: string, path: string, options: RequestOptions = {}) {
  const query = Object.entries(options.query ?? {}).filter(([, v]) => v !== undefined && v !== '');
  const qs = query.length ? `?${new URLSearchParams(query.map(([k, v]) => [k, String(v)]))}` : '';
  return fetchLandfall(api, `${baseUrl(base)}${path}${qs}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(options.body && { 'content-type': 'application/json' }) },
    ...(options.body && { body: JSON.stringify(options.body) }),
  });
}

function need(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new NodeOperationError(`The Landfall credential has no ${label}`);
  return text;
}

/** An org-scoped client authenticated with the API key. */
export class Org {
  readonly slug: string;
  constructor(
    private readonly api: ApiContext,
    readonly credentials: LandfallCredentials,
  ) {
    this.slug = encodeURIComponent(need(credentials.orgSlug, 'Org Slug'));
  }

  private token = () => need(this.credentials.apiKey, 'API Key');
  private path = (rest: string) => `/o/${this.slug}${rest}`;
  private id = (incidentId: string) => encodeURIComponent(incidentId);

  raw(method: string, rest: string, options?: RequestOptions) {
    return request(this.api, this.credentials.baseUrl, this.token(), method, this.path(rest), options);
  }

  async json<T = any>(method: string, rest: string, options?: RequestOptions): Promise<T> {
    return expectOk(await this.raw(method, rest, options)) as T;
  }

  /** Manual trigger: never suppressed, no dedup. */
  declareTrigger(body: JsonObject) {
    return this.json<JsonObject>('POST', '/triggers', { body });
  }

  declareIncident(body: JsonObject) {
    return this.json<IncidentView>('POST', '/incidents', { body });
  }

  listIncidents(query: { limit?: number; cursor?: string; status?: string; q?: string }) {
    return this.json<{ items: IncidentView[]; nextCursor: string | null }>('GET', '/incidents', { query });
  }

  getState(incidentId: string, throughSeq?: number) {
    return this.json<JsonObject>('GET', `/incidents/${this.id(incidentId)}/state`, { query: { throughSeq } });
  }

  /** Ascending. `limit` makes Landfall return the NEWEST `limit` rows after `sinceSeq`/before `beforeSeq`. */
  getEvents(incidentId: string, query: { sinceSeq?: number; limit?: number; beforeSeq?: number } = {}) {
    return this.json<TimelineEvent[]>('GET', `/incidents/${this.id(incidentId)}/events`, { query });
  }

  /** The seq the next event gets: the newest seq plus one (0 on an empty timeline). */
  async nextSeq(incidentId: string): Promise<number> {
    const [newest] = await this.getEvents(incidentId, { limit: 1 });
    return newest ? Number(newest.seq) + 1 : 0;
  }

  /** Append with optimistic concurrency: read the newest seq, write with it, and on a 409 read again and retry once. */
  async addEvent(incidentId: string, type: string, payload: JsonObject): Promise<TimelineEvent> {
    for (let attempt = 1; ; attempt++) {
      const expectedSeq = await this.nextSeq(incidentId);
      const response = await this.raw('POST', `/incidents/${this.id(incidentId)}/events`, { body: { type, expectedSeq, payload } });
      if (response.status === 409 && attempt < 2) continue;
      return expectOk(response) as TimelineEvent;
    }
  }
}

/** POST /triggers with the ingest token (not the API key). */
export async function postTrigger(api: ApiContext, credentials: LandfallCredentials, body: JsonObject): Promise<JsonObject> {
  const response = await request(api, credentials.baseUrl, need(credentials.ingestToken, 'Ingest Token'), 'POST', '/triggers', { body });
  if (!response.ok) throw landfallError(response, { operation: 'trigger' });
  return response.body as JsonObject;
}

export async function pingHeartbeat(api: ApiContext, credentials: HeartbeatCredentials, name: string): Promise<void> {
  const slug = encodeURIComponent(need(credentials.orgSlug, 'Org Slug'));
  const response = await request(api, credentials.baseUrl, need(credentials.token, 'Token'), 'POST', `/o/${slug}/heartbeats/${encodeURIComponent(name)}/ping`);
  expectOk(response);
}
