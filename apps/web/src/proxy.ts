/**
 * The Next.js proxy (Next 16's name for middleware): the first, optimistic auth check in front of every page and
 * API route. Public paths (lib/shared/auth-paths.ts) go through. Anything else needs a session cookie or an API key
 * header; without one, pages redirect to /login and API routes answer 401. It doesn't look the session up (the proxy
 * has no database): the route guard (`handler`, lib/server/auth/guard.ts) and the root layout do that.
 *
 * It also hands pages the requested path (x-landflow-path), so the layout knows where to send someone after sign-in.
 *
 * And it sets the security headers on every response it produces (pass-through, 401 and redirects): nosniff, referrer
 * policy, permissions policy, HSTS over https, and frame denial. Pages also get a per-request nonce Content Security
 * Policy (LANDFLOW_CSP: enforce, report, off); Next reads the nonce from the request's CSP header and stamps its own
 * scripts. Embeddable or self-policed paths (hosted chat and forms, stored files, MCP and webhook endpoints) keep their
 * own policy and get no frame headers or CSP here.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { isProduction } from './lib/server/config/profile';
import { API_KEY_HEADER, isPublicPath, PATH_HEADER, SESSION_COOKIE } from './lib/shared/auth-paths';

/** Paths meant to be framed or that set their own policy (chat route, stored files, MCP file links). */
const EMBEDDABLE = ['/chat', '/form', '/form-test', '/api/binary', '/api/mcp/files', '/mcp', '/mcp-test', '/api/webhook', '/api/webhook-test'];
const underPrefix = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);
export const isEmbeddable = (pathname: string) => EMBEDDABLE.some((p) => underPrefix(pathname, p));

type CspMode = 'enforce' | 'report' | 'off';
function cspMode(): CspMode {
  const v = process.env.LANDFLOW_CSP?.trim().toLowerCase();
  if (v === 'enforce' || v === 'report' || v === 'off') return v;
  return isProduction() ? 'enforce' : 'report';
}

/** The page policy. `unsafe-eval` only in `next dev` (React's debug tooling needs it); styles stay inline (Tailwind, React style props). */
export function pagePolicy(nonce: string): string {
  const dev = process.env.NODE_ENV === 'development';
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "media-src 'self' blob: data:",
    "connect-src 'self'",
    "frame-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const newNonce = () => btoa(crypto.randomUUID());

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const headers = new Headers(request.headers);
  const embeddable = isEmbeddable(pathname);
  const mode = cspMode();
  const nonce = newNonce();
  const csp = !embeddable && !pathname.startsWith('/api/') && mode !== 'off' ? pagePolicy(nonce) : null;
  if (csp && mode === 'enforce') headers.set('content-security-policy', csp);
  // Report-only still needs the nonce visible to Next: it reads it from either header on the request.
  else if (csp) headers.set('content-security-policy-report-only', csp);
  if (csp) headers.set('x-nonce', nonce);
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const https = request.nextUrl.protocol === 'https:' || forwarded === 'https';
  const secure = <T extends Response>(res: T): T => {
    res.headers.set('x-content-type-options', 'nosniff');
    res.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
    res.headers.set('permissions-policy', 'camera=(), geolocation=(), microphone=(self)');
    const hsts = process.env.LANDFLOW_HSTS?.trim().toLowerCase() !== 'off';
    if (https && hsts) res.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (!embeddable) res.headers.set('x-frame-options', 'DENY');
    if (csp) res.headers.set(mode === 'enforce' ? 'content-security-policy' : 'content-security-policy-report-only', csp);
    return res;
  };
  // Only pages read it; on API routes it would show up in webhook items' headers.
  if (pathname.startsWith('/api/')) headers.delete(PATH_HEADER);
  else headers.set(PATH_HEADER, `${pathname}${search}`);
  const pass = () => secure(NextResponse.next({ request: { headers } }));

  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization')?.trim() ?? '')?.[1];
  if (isPublicPath(pathname, { bearer, metricsPublic: process.env.LANDFLOW_METRICS_PUBLIC === 'true' })) return pass();
  if (request.cookies.get(SESSION_COOKIE)?.value || request.headers.get(API_KEY_HEADER) || bearer) return pass();

  if (pathname.startsWith('/api/')) {
    return secure(NextResponse.json({ error: 'Sign in, or send an API key (Authorization: Bearer lf_…)' }, { status: 401, headers: { 'www-authenticate': 'Bearer realm="landflow"' } }));
  }
  const login = request.nextUrl.clone();
  login.pathname = '/login';
  login.search = pathname === '/' ? '' : `?next=${encodeURIComponent(`${pathname}${search}`)}`;
  return secure(NextResponse.redirect(login));
}

export const config = {
  // Everything except Next.js's static files and image optimizer (the allow-list covers the rest).
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
