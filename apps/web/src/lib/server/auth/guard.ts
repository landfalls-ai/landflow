/**
 * The server-side guard. `handler` (lib/server/http.ts) calls `guardRequest` before every API route: public paths
 * (lib/shared/auth-paths.ts) pass; everything else needs a session cookie or an API key, the API key scope and the
 * role action the route policy (./policy) names, and, for cookie-authenticated changes, a same-origin request.
 * The caller becomes the request's principal (./context), which `requireUser` returns. Routes that name a resource
 * (`resourceRule` in ./policy) also need access to it through its project or a share (lib/server/projects/access.ts).
 *
 * Pages: the proxy (src/proxy.ts) sends visitors without a session cookie to /login, and the root layout checks
 * the session itself with `pageViewer`. Tests that call route handlers directly use `enableTestAuth`
 * (./test-bypass, from test/setup.ts), which signs guarded requests without credentials in as a synthetic owner.
 */
import { NextResponse } from 'next/server';
import { can, hasScope, type Action, type Viewer } from '../../shared/auth';
import { API_KEY_HEADER, API_KEY_PREFIX, isPublicPath, PATH_HEADER, SESSION_COOKIE } from '../../shared/auth-paths';
import { verifyApiKey } from './api-keys';
import { requestAuth, type Principal, type RequestAuth } from './context';
import { readCookie } from './cookies';
import { protectedWriteRefusal } from '../environments/protection';
import { checkResourceRule } from '../projects/access';
import { editLocks } from './edit-locks';
import { AuthError } from './errors';
import { sameSecret } from './passwords';
import { resourceRule, routePolicy } from './policy';
import { sessionUser } from './sessions';
import { testPrincipal } from './test-bypass';
import { setupRequired, viewerOf, type UserRecord } from './users';

/** Thrown by `requireUser` inside a route handler; `handler` turns it into a JSON error. */
export { AuthError };

// ---- credentials ----------------------------------------------------------------

function bearerToken(request: Request): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization')?.trim() ?? '');
  return match?.[1];
}

/** The API key a request carries: `X-Landflow-API-Key`, or `Authorization: Bearer lf_…` (not the MCP token). */
export function apiKeyOf(request: Request): string | undefined {
  const header = request.headers.get(API_KEY_HEADER)?.trim();
  if (header) return header;
  const bearer = bearerToken(request);
  return bearer?.startsWith(API_KEY_PREFIX) && !bearer.startsWith('lf_mcp_') ? bearer : undefined;
}

export type Resolved = { ok: true; principal?: Principal } | { ok: false; status: 401; message: string };

/** Who the request's credentials belong to. An API key that doesn't check out fails (no fallback to the cookie). */
export function resolvePrincipal(request: Request): Resolved {
  const key = apiKeyOf(request);
  if (key) {
    const checked = verifyApiKey(key);
    if (!checked.ok) return { ok: false, status: 401, message: checked.reason === 'expired' ? 'This API key has expired' : 'Invalid API key' };
    return { ok: true, principal: { user: checked.user, via: 'api-key', apiKey: { id: checked.key.id, scopes: checked.key.scopes } } };
  }
  const found = sessionUser(readCookie(request, SESSION_COOKIE));
  if (found) return { ok: true, principal: { user: found.user, via: 'session', sessionId: found.session.id } };
  return { ok: true };
}

/** A cookie-authenticated change from another site: refuse (SameSite=Lax already stops most; this stops the rest). */
function crossSite(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin || origin === 'null') return Boolean(origin);
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  const hosts = [request.headers.get('x-forwarded-host')?.split(',')[0]?.trim(), request.headers.get('host'), safeHost(request.url), safeHost(process.env.LANDFLOW_PUBLIC_URL)];
  return !hosts.includes(originHost);
}

function safeHost(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).host : undefined;
  } catch {
    return undefined;
  }
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** LANDFLOW_REGISTRY_SECRET: plugins must send it to announce (header `X-Landflow-Registry-Secret` or Bearer). */
export function registrySecretOk(request: Request): boolean {
  const secret = process.env.LANDFLOW_REGISTRY_SECRET;
  if (!secret) return true;
  return sameSecret(request.headers.get('x-landflow-registry-secret') ?? bearerToken(request), secret);
}

export const metricsPublic = () => process.env.LANDFLOW_METRICS_PUBLIC === 'true';

export type GuardResult = { ok: true; auth: RequestAuth } | { ok: false; response: Response };

const deny = (message: string, status: number, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error: message, ...extra }, { status, ...(status === 401 && { headers: { 'www-authenticate': 'Bearer realm="landflow"' } }) });

/** The guard: decide whether `request` may reach its route handler, and as whom. */
export function guardRequest(request: Request | undefined): GuardResult {
  let path = '/';
  let method = 'GET';
  if (request) {
    try {
      path = new URL(request.url).pathname;
    } catch {}
    method = request.method.toUpperCase();
  }
  if (request && isPublicPath(path, { bearer: bearerToken(request), metricsPublic: metricsPublic() })) {
    if (path === '/api/plugins/announce' && !registrySecretOk(request)) return { ok: false, response: deny('Send the registry secret (LANDFLOW_REGISTRY_SECRET) as X-Landflow-Registry-Secret', 401) };
    return { ok: true, auth: {} };
  }

  const resolved = request ? resolvePrincipal(request) : ({ ok: true } as Resolved);
  if (!resolved.ok) return { ok: false, response: deny(resolved.message, resolved.status) };
  const principal = resolved.principal ?? testPrincipal();
  if (!principal) {
    return { ok: false, response: deny('Sign in, or send an API key (Authorization: Bearer lf_…)', 401, setupRequired() ? { setupRequired: true } : {}) };
  }

  const policy = routePolicy(method, path);
  if (principal.via === 'api-key') {
    if (policy.sessionOnly) return { ok: false, response: deny('API keys can’t do this; sign in instead', 403) };
    if (policy.scope !== 'any' && !hasScope(principal.apiKey?.scopes ?? [], policy.scope)) {
      return { ok: false, response: deny(`This API key lacks the “${policy.scope}” scope`, 403, { scope: policy.scope }) };
    }
  }
  if (policy.action && !can(principal.user, policy.action)) return { ok: false, response: deny('Your role can’t do this. Ask an owner or admin.', 403) };
  // A protected environment: workflows change only by pull or promotion (lib/server/environments/protection.ts).
  const readOnly = protectedWriteRefusal(method, path);
  if (readOnly) return { ok: false, response: deny(readOnly, 403, { protected: true }) };
  if (principal.via === 'session' && request && UNSAFE.has(method) && crossSite(request)) return { ok: false, response: deny('Cross-site request refused', 403) };
  // Projects and sharing: the workflow, credential, data table, agent or execution the path names (./policy).
  const rule = resourceRule(method, path);
  const denied = rule && checkResourceRule(principal.user, rule);
  if (denied) return { ok: false, response: deny(denied.message, denied.status) };

  // A save from an editor tab that lost the workflow's edit lock (someone took over).
  const tab = request?.headers.get('x-landflow-editor-tab');
  const saving = /^\/api\/workflows\/([^/]+)$/.exec(path);
  if (tab && saving && method === 'PUT') {
    const lock = editLocks.get(decodeURIComponent(saving[1]));
    if (lock && lock.tabId !== tab) return { ok: false, response: deny(`${lock.userName} is editing this workflow`, 423, { lock }) };
  }
  return { ok: true, auth: { principal } };
}

/**
 * The signed-in user, for route handlers (and server functions): inside a guarded handler it is the request's
 * principal; `action` adds a role check. Throws AuthError (401/403), which `handler` answers as JSON. In a server
 * component, use `pageViewer` (lib/server/auth/pages.ts) instead.
 */
export async function requireUser(action?: Action): Promise<UserRecord> {
  const principal = requestAuth()?.principal;
  if (!principal) throw new AuthError('Sign in, or send an API key (Authorization: Bearer lf_…)', 401);
  if (action && !can(principal.user, action)) throw new AuthError('Your role can’t do this. Ask an owner or admin.', 403);
  return principal.user;
}

/** The request's principal (session, API key or test), if any. */
export function currentPrincipal(): Principal | undefined {
  return requestAuth()?.principal;
}

export function viewer(user: UserRecord): Viewer {
  return viewerOf(user);
}

export { PATH_HEADER };
