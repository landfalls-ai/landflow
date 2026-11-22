/** Shared by the C16 route tests: a request helper, session cookie reading and a user already enrolled with TOTP. */
import { expect } from 'vitest';

export const BASE = 'http://localhost:3000';
type Route = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
export type Options = { method?: string; body?: unknown; session?: string; key?: string; headers?: Record<string, string> };

export function request(path: string, options: Options = {}): Request {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.session) headers.cookie = `landflow_session=${options.session}`;
  if (options.key) headers['x-landflow-api-key'] = options.key;
  return new Request(`${BASE}${path}`, { method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'), headers, ...(options.body !== undefined && { body: JSON.stringify(options.body) }) });
}

export async function call(route: unknown, path: string, options: Options = {}, params?: Record<string, string>) {
  const response = await (route as Route)(request(path, options), params && { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as Record<string, any>, response };
}

export function sessionCookie(response: Response): string | undefined {
  const line = response.headers.getSetCookie().find((c) => c.startsWith('landflow_session='));
  return line ? decodeURIComponent(line.split(';')[0].slice('landflow_session='.length)) : undefined;
}

export const must = <T>(value: T | undefined | null): T => {
  expect(value).toBeDefined();
  return value as T;
};
