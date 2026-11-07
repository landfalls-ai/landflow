/**
 * The HTTP client: JSON in and out, `Authorization: Bearer <key>` when there is a key, and every failure turned into
 * a CliError — unreachable host (network), the host's `{ error }` by status, and a non-JSON 404 (a route this host
 * doesn't have: an older Landflow) as `not_supported`.
 */
import { CliError, type ErrorCode } from './errors';
import { VERSION } from './version';

export type Query = Record<string, string | number | boolean | string[] | undefined>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Statuses answered instead of thrown (the body is returned as it is). */
  accept?: number[];
}

const CODE_FOR_STATUS: Record<number, ErrorCode> = { 400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 423: 'conflict' };

export class Client {
  constructor(
    readonly url: string,
    readonly apiKey: string | undefined,
    readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private href(path: string, query?: Query): string {
    const url = new URL(path, `${this.url}/`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === false) continue;
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
    }
    return url.toString();
  }

  /** Send a request; answers `{ status, body }` for 2xx (and `accept`ed) statuses, throws a CliError otherwise. */
  async request<T = Record<string, unknown>>(method: string, path: string, options: RequestOptions = {}): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': `landflow-cli/${VERSION}` };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchImpl(this.href(path, options.query), { method, headers, ...(options.body !== undefined && { body: JSON.stringify(options.body) }) });
    } catch (caught) {
      const cause = (caught as { cause?: { code?: string; message?: string } }).cause;
      throw new CliError('network', `Can't reach Landflow at ${this.url}: ${cause?.code ?? cause?.message ?? (caught as Error).message}`);
    }
    const text = await response.text();
    let body: unknown;
    let isJson = false;
    try {
      body = text ? JSON.parse(text) : {};
      isJson = true;
    } catch {
      body = text;
    }
    if (response.ok || options.accept?.includes(response.status)) {
      if (!isJson) throw new CliError('server_error', `${method} ${path} answered ${response.status} with something that isn't JSON`, { status: response.status });
      return { status: response.status, body: body as T };
    }
    if (!isJson || typeof (body as { error?: unknown })?.error !== 'string') {
      if (response.status === 404) throw new CliError('not_supported', `This host has no ${method} ${path.split('?')[0]} (an older Landflow?)`, { status: 404 });
      throw new CliError(response.status >= 500 ? 'server_error' : (CODE_FOR_STATUS[response.status] ?? 'server_error'), `${method} ${path} failed with ${response.status} ${response.statusText}`.trim(), {
        status: response.status,
      });
    }
    const { error: message, ...details } = body as { error: string } & Record<string, unknown>;
    const code = response.status >= 500 ? 'server_error' : (CODE_FOR_STATUS[response.status] ?? 'bad_request');
    const hint = response.status === 401 ? ' (run `landflow login`, or set LANDFLOW_API_KEY)' : '';
    throw new CliError(code, `${message}${hint}`, { status: response.status, ...(Object.keys(details).length && { details }) });
  }

  async get<T = Record<string, unknown>>(path: string, query?: Query): Promise<T> {
    return (await this.request<T>('GET', path, { query })).body;
  }

  async post<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
    return (await this.request<T>('POST', path, { body: body ?? {} })).body;
  }

  async put<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
    return (await this.request<T>('PUT', path, { body })).body;
  }

  async patch<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
    return (await this.request<T>('PATCH', path, { body })).body;
  }

  async delete<T = Record<string, unknown>>(path: string): Promise<T> {
    return (await this.request<T>('DELETE', path)).body;
  }
}

/** A path segment, escaped. */
export const seg = (value: string) => encodeURIComponent(value);
