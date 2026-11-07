/**
 * Mapping SAP's answers to node errors (spec 3.4). The message never carries request bodies, headers or credentials. A 401 says
 * so in the text, because the host renews an OAuth token once on an error that reads like a 401.
 */
import { NodeOperationError } from '@landflow/sdk';

export class SapError extends NodeOperationError {
  constructor(
    message: string,
    readonly status: number,
    options: { description?: string; code?: string; target?: string; details?: string[] } = {},
  ) {
    super(message, { ...(options.description && { description: options.description }) });
    this.name = 'SapError';
    this.code = options.code;
    this.target = options.target;
    this.details = options.details ?? [];
  }
  code?: string;
  target?: string;
  details: string[];
}

const text = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'value' in value && typeof (value as { value: unknown }).value === 'string') return (value as { value: string }).value;
  return undefined;
};

interface Parsed {
  code?: string;
  message?: string;
  target?: string;
  details: string[];
}

/** V2: `{error:{code, message:{lang,value}, innererror:{errordetails:[{code,message}]}}}`; V4: `{error:{code,message,target,details:[]}}`. */
export function parseErrorBody(body: unknown): Parsed | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return undefined;
  const e = error as Record<string, unknown>;
  const details: string[] = [];
  const inner = e.innererror as { errordetails?: unknown } | undefined;
  const lists = [Array.isArray(e.details) ? e.details : [], Array.isArray(inner?.errordetails) ? (inner?.errordetails as unknown[]) : []];
  for (const list of lists) {
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const d = entry as Record<string, unknown>;
      const message = text(d.message);
      if (!message) continue;
      const code = typeof d.code === 'string' && d.code ? `${d.code}: ` : '';
      const line = `${code}${message}`;
      if (!details.includes(line) && line !== text(e.message)) details.push(line);
    }
  }
  return {
    ...(typeof e.code === 'string' && e.code && { code: e.code }),
    ...(text(e.message) && { message: text(e.message) }),
    ...(typeof e.target === 'string' && e.target && { target: e.target }),
    details: details.slice(0, 10),
  };
}

const isHtml = (body: unknown, contentType: string) => (typeof body === 'string' && /^\s*<(!doctype|html|head|body)/i.test(body)) || /text\/html/i.test(contentType);

export interface ErrorContext {
  service: string;
  operation: string;
  entitySet?: string;
}

/** Builds the error for a non-2xx answer. `body` is the parsed JSON or the text. */
export function mapError(context: ErrorContext, status: number, body: unknown, headers: Headers | Record<string, string> = {}): SapError {
  const get = (name: string) => (headers instanceof Headers ? (headers.get(name) ?? '') : (headers[name] ?? ''));
  const where = `SAP ${context.service}${context.entitySet ? `/${context.entitySet}` : ''} ${context.operation} failed`;
  if (isHtml(body, get('content-type'))) {
    return new SapError(`${where}: ${status}, not an OData answer`, status, {
      description: 'The server answered with a web page, usually a login page. Check the base URL of the credential and that the communication arrangement exists.',
    });
  }
  const parsed = parseErrorBody(body);
  const detail = parsed
    ? [parsed.code, parsed.message].filter(Boolean).join(': ') + (parsed.target ? ` (${parsed.target})` : '')
    : typeof body === 'string' && body.trim()
      ? body.trim().slice(0, 300)
      : '';
  const tail = (parsed?.details.length ? ` Details: ${parsed.details.join(' | ')}` : '') + '';
  const base = `${where}: ${status}${detail ? ` ${detail}` : ''}${tail}`;
  const options = { code: parsed?.code, target: parsed?.target, details: parsed?.details };
  switch (status) {
    case 401:
      return new SapError(`${base} (401 Unauthorized: the credentials were refused or the token expired)`, status, {
        ...options,
        description: 'Check the user and password of the communication user, or reconnect the OAuth credential.',
      });
    case 403:
      return new SapError(`${base} (403 Forbidden)`, status, {
        ...options,
        description: 'Either the communication arrangement does not include this service, the user lacks authorization, or the CSRF token was missing or stale.',
      });
    case 404:
      return new SapError(context.entitySet && /get|update|delete/.test(context.operation) ? `${where}: 404 no such key${detail ? ` (${detail})` : ''}` : base, status, options);
    case 412:
      return new SapError(`${where}: 412 the entity changed since it was read${detail ? ` (${detail})` : ''}. Read it again and repeat the change.`, status, options);
    case 428:
      return new SapError(`${where}: 428 SAP wants an ETag (If-Match) for this change${detail ? ` (${detail})` : ''}`, status, options);
    case 429: {
      const wait = get('retry-after');
      return new SapError(`${base} (429 rate limited${wait ? `, retry after ${wait} s` : ''})`, status, { ...options, description: 'SAP is limiting calls. Try again later or lower the number of calls.' });
    }
    default:
      return new SapError(base, status, options);
  }
}
