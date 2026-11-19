/**
 * The error every Notion call throws (docs/features/notion-brain.md#how-landflow-talks-to-notion). It implements the contract's
 * `NotionErrorInfo`. Its message carries the status, Notion's `code` and the path template: never the key, never page text.
 */
import type { NotionErrorInfo, NotionErrorKind } from './port';

export interface NotionErrorInit {
  kind: NotionErrorKind;
  status: number;
  code?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  mayHaveLanded?: boolean;
}

export class NotionError extends Error implements NotionErrorInfo {
  readonly kind: NotionErrorKind;
  readonly status: number;
  readonly code?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly mayHaveLanded?: boolean;

  constructor(message: string, init: NotionErrorInit) {
    super(message);
    this.name = 'NotionError';
    this.kind = init.kind;
    this.status = init.status;
    if (init.code !== undefined) this.code = init.code;
    this.retryable = init.retryable ?? ['rateLimited', 'unavailable', 'conflict', 'network'].includes(init.kind);
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
    if (init.mayHaveLanded) this.mayHaveLanded = true;
  }
}

/** The longest a `Retry-After` is honoured. */
export const MAX_RETRY_AFTER_MS = 120_000;

/** Seconds from the `Retry-After` header or `additional_data.retry_after`, as milliseconds (capped), or undefined. */
export function retryAfterMs(header: string | null, body: unknown): number | undefined {
  const fromBody = (body as { additional_data?: { retry_after?: unknown } } | undefined)?.additional_data?.retry_after;
  for (const raw of [header, fromBody]) {
    const seconds = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1000));
  }
  return undefined;
}

/** The kind of a non-retryable or exhausted HTTP failure. */
export function kindOfStatus(status: number, code: string | undefined): NotionErrorKind {
  if (status === 429 && code === 'public_api_request_blocked') return 'blocked';
  if (status === 429 || status === 529) return 'rateLimited';
  if (status === 409) return 'conflict';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'notFound';
  if (status >= 500) return 'unavailable';
  return 'invalid';
}
