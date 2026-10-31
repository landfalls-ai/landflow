/**
 * The GitHub REST v3 client: one traced call per request (a client span via ctx.http), and GitHub's own error text
 * with a hint for the statuses people hit (never the token). `baseUrl` is the credential's API base URL, so GitHub
 * Enterprise Server (`https://<host>/api/v3`) and the test double work the same way.
 */
import { NodeOperationError, type JsonObject, type NodeMetrics, type TracedFetch } from '@landflow/sdk';

export interface GitHubCredentials extends JsonObject {
  accessToken: string;
  baseUrl: string;
}

export const DEFAULT_BASE_URL = 'https://api.github.com';
export const API_VERSION = '2022-11-28';
const API_TIMEOUT_MS = 30_000;

/** What the helpers need: the traced fetch, plus metrics when called from execute (a credential test has none). */
export interface ApiContext {
  http: TracedFetch;
  metrics?: NodeMetrics;
}

export const METRICS = {
  apiErrors: 'landflow.github.api_errors',
} as const;

const statusClass = (status: number) => `${Math.floor(status / 100)}xx`;

function countApiError(api: ApiContext, klass: string) {
  api.metrics?.counter(METRICS.apiErrors, { description: 'Failed calls to the GitHub API' }).add(1, { status_class: klass });
}

/** The credential's base URL without trailing slashes; an empty value falls back to github.com. */
export function baseUrl(value: unknown): string {
  const url = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_BASE_URL;
  return url.replace(/\/+$/, '');
}

/** A path segment-wise encoded ref or file path: slashes stay, everything else is escaped. */
export const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** "repos/{owner}/{repo}" with both parts escaped. */
export const repoPath = (owner: string, repository: string) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;

export interface GitHubResponse<T = any> {
  status: number;
  ok: boolean;
  headers: Headers;
  body: T;
}

interface ErrorBody {
  message?: string;
  errors?: Array<string | { resource?: string; field?: string; code?: string; message?: string }>;
  documentation_url?: string;
}

/** GitHub's message plus the per-field detail of a 422: "Validation Failed: head: invalid; A pull request already exists for …". */
function detail(body: ErrorBody | undefined, text: string, status: number): string {
  const message = body?.message ?? (text.slice(0, 200) || `HTTP ${status}`);
  const errors = (body?.errors ?? [])
    .map((e) => (typeof e === 'string' ? e : (e.message ?? [e.resource, e.field, e.code].filter(Boolean).join(' '))))
    .filter(Boolean);
  return errors.length ? `${message}: ${errors.join('; ')}` : message;
}

/** Hints for the errors people actually hit. */
function hint(status: number, headers: Headers, message: string): string | undefined {
  if (status === 401) return 'GitHub rejected the token. Check that it is correct, has not expired or been revoked, and (for Enterprise) that the API base URL is right.';
  if (status === 403) {
    if (headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(headers.get('x-ratelimit-reset'));
      return `The GitHub rate limit is used up${reset ? `; it resets at ${new Date(reset * 1000).toISOString()}` : ''}.`;
    }
    if (/rate limit|abuse/i.test(message)) return 'GitHub is limiting this token for making many requests: wait a little and run the node again.';
    return 'The token is valid but not allowed to do this. Check its scopes (classic: repo) or, for a fine-grained token, that the repository is selected and has the needed permission (Contents, Pull requests or Issues: read and write). SSO-protected organizations also need the token authorized.';
  }
  if (status === 404) return 'GitHub answers 404 for a missing resource and also for a private repository the token cannot see. Check owner, repository, branch and path, and the token’s access to the repository.';
  if (status === 405) return 'GitHub would not merge it: a draft, a conflict with the base branch, a required check or review missing, or a merge method the repository does not allow.';
  if (status === 409 && /head branch was modified/i.test(message)) return 'The pull request moved on after the given head SHA: something new was pushed. Check it again before merging.';
  if (status === 409) return 'The change conflicts with the repository state: the branch moved on while the commit was prepared, or the repository is empty. Run the node again.';
  if (status === 422) return 'GitHub understood the request but refused its content: see the details above (for example the branch already exists, or the pull request has no commits between head and base).';
  return undefined;
}

export function apiError(api: ApiContext, response: GitHubResponse<ErrorBody | undefined> & { text?: string }): NodeOperationError {
  const message = detail(response.body, response.text ?? '', response.status);
  countApiError(api, statusClass(response.status));
  const description = hint(response.status, response.headers, message);
  return new NodeOperationError(`GitHub API error ${response.status}: ${message}`, description ? { description } : {});
}

/** "fetch failed (ECONNREFUSED)" rather than undici's bare "fetch failed". */
function networkReason(error: unknown): string {
  const e = error as Error & { cause?: { code?: string; message?: string } };
  const cause = e?.cause?.code ?? e?.cause?.message;
  return cause ? `${e.message} (${cause})` : (e?.message ?? String(error));
}

/** One call; returns the response whatever its status. Network failures and timeouts become node errors. */
export async function rawCall<T = any>(api: ApiContext, credentials: GitHubCredentials, method: string, path: string, body?: JsonObject): Promise<GitHubResponse<T> & { text: string }> {
  const url = `${baseUrl(credentials.baseUrl)}${path}`;
  let response: Response;
  try {
    response = await api.http(url, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${credentials.accessToken}`,
        'x-github-api-version': API_VERSION,
        'user-agent': 'landflow-github-plugin',
        ...(body && { 'content-type': 'application/json' }),
      },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (error) {
    const timeout = (error as Error)?.name === 'TimeoutError';
    countApiError(api, timeout ? 'timeout' : 'network');
    throw new NodeOperationError(`GitHub API request failed: ${timeout ? `no answer within ${API_TIMEOUT_MS / 1000} s` : networkReason(error)}`);
  }
  const text = await response.text();
  let parsed: unknown;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  return { status: response.status, ok: response.ok, headers: response.headers, body: parsed as T, text };
}

/** One call whose failure is a node error. */
export async function githubCall<T = any>(api: ApiContext, credentials: GitHubCredentials, method: string, path: string, body?: JsonObject): Promise<T> {
  const response = await rawCall<T>(api, credentials, method, path, body);
  if (!response.ok) throw apiError(api, response as GitHubResponse<any>);
  return response.body;
}

/** Like githubCall, but a 404 is `undefined` (a missing branch or file is an answer, not a failure). */
export async function githubCallOrMissing<T = any>(api: ApiContext, credentials: GitHubCredentials, method: string, path: string): Promise<T | undefined> {
  const response = await rawCall<T>(api, credentials, method, path);
  if (response.status === 404) return undefined;
  if (!response.ok) throw apiError(api, response as GitHubResponse<any>);
  return response.body;
}
