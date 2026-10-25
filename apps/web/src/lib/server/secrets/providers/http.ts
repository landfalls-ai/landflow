/**
 * HTTP for secret providers: a timeout, JSON in and out, and errors that say who refused and why without echoing
 * request data (a provider's own error text is kept, cut short; it never contains the values we asked for).
 */
import { SecretProviderError } from './types';

const TIMEOUT_MS = Number(process.env.LANDFLOW_SECRETS_TIMEOUT_MS) || 10_000;

export interface JsonRequest {
  method?: string;
  headers?: Record<string, string>;
  /** JSON body (objects) or a ready body (strings: form posts, signed payloads). */
  body?: unknown;
  /** Statuses answered with `undefined` instead of an error (404 for a missing secret). */
  allow?: number[];
}

/** The provider's error text from a JSON or text body: Vault's `errors`, AWS's `message`, Google's and Azure's `error`. */
function reasonOf(text: string): string {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const pick = (value: unknown): string | undefined => {
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) return value.map(pick).filter(Boolean).join('; ');
      if (value && typeof value === 'object') {
        const object = value as Record<string, unknown>;
        return pick(object.message ?? object.Message ?? object.error_description ?? object.error ?? object.code);
      }
      return undefined;
    };
    return pick(body.errors ?? body.message ?? body.Message ?? body.error_description ?? body.error) ?? '';
  } catch {
    return text.replace(/\s+/g, ' ').trim();
  }
}

export async function requestJson<T>(fetchImpl: typeof fetch | undefined, url: string, what: string, request: JsonRequest = {}): Promise<T | undefined> {
  const { method = 'GET', headers = {}, body, allow = [] } = request;
  const json = body !== undefined && typeof body !== 'string';
  let response: Response;
  try {
    response = await (fetchImpl ?? fetch)(url, {
      method,
      headers: { accept: 'application/json', 'user-agent': 'Landflow-Secrets/1', ...(json && { 'content-type': 'application/json' }), ...headers },
      ...(body !== undefined && { body: json ? JSON.stringify(body) : (body as string) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'manual',
    });
  } catch (error) {
    const reason = (error as Error).name === 'TimeoutError' ? `no answer within ${TIMEOUT_MS / 1000} s` : ((error as Error & { cause?: Error }).cause?.message ?? (error as Error).message);
    throw new SecretProviderError(`${what} could not be reached: ${reason}`);
  }
  const text = await response.text().catch(() => '');
  if (allow.includes(response.status)) return undefined;
  if (!response.ok) {
    const reason = reasonOf(text).slice(0, 300);
    throw new SecretProviderError(`${what} answered HTTP ${response.status}${reason ? `: ${reason}` : ''}`, response.status);
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SecretProviderError(`${what} answered with something that isn't JSON`);
  }
}

/** A base URL without its trailing slashes. */
export const baseUrl = (url: string) => url.trim().replace(/\/+$/, '');

/** Check that a setting is an http(s) URL; the message names the field. */
export function checkUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SecretProviderError(`${label} is not a URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SecretProviderError(`${label} must be an http:// or https:// URL`);
  if (url.username || url.password) throw new SecretProviderError(`Keep credentials out of ${label}`);
  return baseUrl(value);
}
