/**
 * Linear's GraphQL API (https://api.linear.app/graphql): one POST per query. A personal API key goes in the
 * Authorization header as is, an OAuth2 access token with `Bearer `. GraphQL failures come back as an `errors` array
 * (sometimes with HTTP 200), so every call checks it. Rate limits answer 429 with Retry-After.
 */
import { NodeOperationError, type GetCredentials, type JsonObject, type TracedFetch } from '@landflow/sdk';

export const DEFAULT_BASE_URL = 'https://api.linear.app';

export interface LinearCredentials extends JsonObject {
  /** Personal API key (the API key credential). */
  apiKey: string;
  /** OAuth2 access token (the OAuth2 credential; the host renews it). */
  accessToken: string;
  baseUrl: string;
}

export interface ApiContext {
  http: TracedFetch;
}

const API_TIMEOUT_MS = 30_000;
const MAX_RETRY_WAIT_S = 30;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The Authorization header value: the bare key for an API key, `Bearer <token>` for OAuth2. */
export function authorization(credentials: LinearCredentials): string {
  if (credentials.accessToken?.trim()) return `Bearer ${credentials.accessToken.trim()}`;
  return String(credentials.apiKey ?? '').trim();
}

export function graphqlUrl(credentials: LinearCredentials): string {
  const base = (credentials.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  return `${base}/graphql`;
}

/** The node's credential: the API key type or the OAuth2 one, by the Authentication parameter (else whichever was sent). */
export function pickCredentials(ctx: { getCredentials: GetCredentials }, authenticationValue?: unknown): LinearCredentials {
  const [want, other] = authenticationValue === 'oAuth2' ? ['linearOAuth2Api', 'linearApi'] : ['linearApi', 'linearOAuth2Api'];
  return ctx.getCredentials<LinearCredentials>(want, { optional: true }) ?? ctx.getCredentials<LinearCredentials>(other, { optional: true }) ?? ctx.getCredentials<LinearCredentials>(want);
}

interface GraphQLError {
  message?: string;
  extensions?: { code?: string; type?: string; userPresentableMessage?: string };
}

function failure(status: number | undefined, errors: GraphQLError[], fallback: string): NodeOperationError {
  const first = errors[0];
  const detail = first?.extensions?.userPresentableMessage ?? first?.message ?? fallback;
  const code = `${first?.extensions?.code ?? ''} ${first?.extensions?.type ?? ''}`.toLowerCase();
  let description: string | undefined;
  if (status === 401 || /authentication|unauthor/.test(code) || /authentication required|invalid token/i.test(detail)) {
    description = 'Linear rejected the credentials. Use a personal API key (Settings, Security & access) or Connect the Linear OAuth2 credential again.';
  } else if (/forbidden|permission|scope/.test(code) || /scope|admin/i.test(detail)) {
    description = 'The key or token lacks a permission. Creating webhooks needs a workspace admin key or the OAuth admin scope; the actions need write, issues:create or comments:create.';
  }
  return new NodeOperationError(`Linear API error${status ? ` ${status}` : ''}: ${detail}`, description ? { description } : {});
}

/** One GraphQL call. Retries a 429 up to `retries` times after Retry-After (at most 30 s); the token never appears in an error. */
export async function graphql<T = any>(api: ApiContext, credentials: LinearCredentials, query: string, variables: JsonObject = {}, options: { retries?: number; timeoutMs?: number } = {}): Promise<T> {
  const retries = options.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await api.http(graphqlUrl(credentials), {
        method: 'POST',
        headers: { authorization: authorization(credentials), 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(options.timeoutMs ?? API_TIMEOUT_MS),
      });
    } catch (error) {
      const timeout = (error as Error)?.name === 'TimeoutError';
      throw new NodeOperationError(`Linear API request failed: ${timeout ? 'no answer in time' : (error as Error)?.message ?? String(error)}`);
    }
    const text = await response.text();
    let body: { data?: T; errors?: GraphQLError[] } | undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    const limited = response.status === 429 || body?.errors?.some((e) => e.extensions?.code === 'RATELIMITED');
    if (limited && attempt < retries) {
      await sleep(Math.min(MAX_RETRY_WAIT_S, Number(response.headers.get('retry-after')) || 1) * 1000);
      continue;
    }
    if (limited) throw new NodeOperationError('Linear API error 429: rate limit reached', { description: 'Linear allows 2,500 requests an hour per API key and 5,000 per OAuth user. Wait for Retry-After, or narrow the query.' });
    if (body?.errors?.length) throw failure(response.ok ? undefined : response.status, body.errors, 'GraphQL error');
    if (!response.ok || !body?.data) throw failure(response.status, [], text.slice(0, 200) || `HTTP ${response.status}`);
    return body.data;
  }
}
