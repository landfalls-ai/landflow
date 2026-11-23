/**
 * The two wrappers every public route of the requester page goes through (docs/access-requests.md#signing-in-without-an-account). Landflow's
 * guard lets everything under `/request-access` through with no principal and no same-origin check, so this is where those happen:
 *
 * - the feature switch: while "People without a Landflow account can ask" is off, every route answers 404 (`whenOff: 'allow'` is for
 *   `config`, which says it is off);
 * - a write (anything but GET/HEAD) must be same-origin (`crossSiteRequest`, the guard's own check: `Origin`, else `Sec-Fetch-Site`) and
 *   carry a JSON body, so a cross-site form post is refused before a handler runs; no CORS header is ever sent;
 * - `outsideRoute` also needs a requester session (cookie `landflow_requester`): without one, 401 `{ error: 'signed_out' }`;
 * - nothing is cached (`Cache-Control: no-store`).
 *
 * Both are `handler()` underneath: the host's boot, the shutdown drain, the public-route IP limit, error answers and the audit context.
 */
import { NextResponse } from 'next/server';
import { REQUESTER_COOKIE, REQUESTER_OIDC_COOKIE, REQUESTER_PATH } from '../../../shared/auth-paths';
import { secureRequest } from '../../auth/cookies';
import { crossSiteRequest } from '../../auth/guard';
import { error, handler } from '../../http';
import { clientAddress, trustedProxiesConfigured } from '../../net/client-address';
import type { OutsideRequester } from './identity';
import { requesterFromRequest } from './sessions';
import { outsideSettings } from './settings';

export type RouteParams = Record<string, string>;
type Ctx = { params?: Promise<RouteParams> };

export interface OutsideRouteOptions {
  /** A route that changes something: same-origin and JSON only. */
  write?: boolean;
  /** `allow`: answer while the feature is off (only `config`). */
  whenOff?: 'allow';
}

const SAFE = new Set(['GET', 'HEAD']);

/** The refusals shared by both wrappers, or undefined when the request may go on. */
function gate(req: Request, options: OutsideRouteOptions): Response | undefined {
  if (!outsideSettings().enabled && options.whenOff !== 'allow') return error('Asking here is switched off', 404, { code: 'off' });
  if (options.write || !SAFE.has(req.method.toUpperCase())) {
    if (crossSiteRequest(req)) return error('Cross-site request refused', 403, { code: 'cross_site' });
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return error('Send JSON (content-type: application/json)', 415, { code: 'json_only' });
  }
  return undefined;
}

function sealed(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/** Seal what `handler()` answers too: an error it turns into JSON (an AccessError, a 500) must not be cached either. */
function sealing<A extends unknown[]>(inner: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => sealed(await inner(...args));
}

/** A route that needs no session (the link request, sign-in, the settings the page needs). */
export function outsidePublic(fn: (ctx: { req: Request; params: RouteParams }) => Promise<Response>, options: OutsideRouteOptions = {}) {
  return sealing(
    handler(async (req: Request, ctx?: Ctx): Promise<Response> => {
      const refused = gate(req, options);
      if (refused) return refused;
      return fn({ req, params: (await ctx?.params) ?? {} });
    }),
  );
}

/** A route for a signed-in requester: the handler gets who they are, never a Landflow user. */
export function outsideRoute(fn: (ctx: { req: Request; requester: OutsideRequester; params: RouteParams }) => Promise<Response>, options: OutsideRouteOptions = {}) {
  return sealing(
    handler(async (req: Request, ctx?: Ctx): Promise<Response> => {
      const refused = gate(req, options);
      if (refused) return refused;
      const requester = await requesterFromRequest(req);
      if (!requester) return NextResponse.json({ error: 'signed_out', code: 'signed_out', signIn: true }, { status: 401 });
      return fn({ req, requester, params: (await ctx?.params) ?? {} });
    }),
  );
}

/**
 * The address the public page's limits count. Behind no declared proxy (LANDFLOW_TRUSTED_PROXIES unset) an `X-Forwarded-For` header is the
 * client's own word, so every per-network limit would be free to dodge by rotating it: the page then counts all callers as one address (coarse,
 * and impossible to forge). Set the variable (0 for clients that connect directly, else the number of proxies) before switching the page on.
 */
export function outsideClientIp(req: Request): string {
  return trustedProxiesConfigured() ? clientAddress(req) : 'unconfigured';
}

/** A 429 in plain words, with Retry-After (the limits of a signed-in requester). */
export function tooMany(sentence: string, seconds: number): Response {
  return Response.json({ error: sentence, code: 'rate_limited', retryAfter: seconds }, { status: 429, headers: { 'Retry-After': String(seconds) } });
}

/** Set the session cookie: HttpOnly, SameSite=Strict, only under `/request-access`, Secure behind https, ending with the session. */
export function setRequesterCookie(response: NextResponse, request: Request, token: string, expiresAt: Date): void {
  response.cookies.set(REQUESTER_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: secureRequest(request), path: REQUESTER_PATH, expires: expiresAt });
}

export function clearRequesterCookie(response: NextResponse, request: Request): void {
  response.cookies.set(REQUESTER_COOKIE, '', { httpOnly: true, sameSite: 'strict', secure: secureRequest(request), path: REQUESTER_PATH, maxAge: 0 });
}

/** The state of a Google sign-in in progress: Lax (Google sends the browser back with a top-level GET), 10 minutes, only on the start and callback paths. */
export const GOOGLE_COOKIE_PATH = '/request-access/api/sign-in/google';
export function setGoogleStateCookie(response: NextResponse, request: Request, state: string): void {
  response.cookies.set(REQUESTER_OIDC_COOKIE, state, { httpOnly: true, sameSite: 'lax', secure: secureRequest(request), path: GOOGLE_COOKIE_PATH, maxAge: 600 });
}

export function clearGoogleStateCookie(response: NextResponse, request: Request): void {
  response.cookies.set(REQUESTER_OIDC_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: secureRequest(request), path: GOOGLE_COOKIE_PATH, maxAge: 0 });
}
