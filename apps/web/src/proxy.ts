/**
 * The Next.js proxy (Next 16's name for middleware): the first, optimistic auth check in front of every page and
 * API route. Public paths (lib/shared/auth-paths.ts) go through. Anything else needs a session cookie or an API key
 * header; without one, pages redirect to /login and API routes answer 401. It doesn't look the session up (the proxy
 * has no database): the route guard (`handler`, lib/server/auth/guard.ts) and the root layout do that.
 *
 * It also hands pages the requested path (x-landflow-path), so the layout knows where to send someone after sign-in.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { API_KEY_HEADER, isPublicPath, PATH_HEADER, SESSION_COOKIE } from './lib/shared/auth-paths';

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const headers = new Headers(request.headers);
  // Only pages read it; on API routes it would show up in webhook items' headers.
  if (pathname.startsWith('/api/')) headers.delete(PATH_HEADER);
  else headers.set(PATH_HEADER, `${pathname}${search}`);
  const pass = () => NextResponse.next({ request: { headers } });

  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization')?.trim() ?? '')?.[1];
  if (isPublicPath(pathname, { bearer, metricsPublic: process.env.LANDFLOW_METRICS_PUBLIC === 'true' })) return pass();
  if (request.cookies.get(SESSION_COOKIE)?.value || request.headers.get(API_KEY_HEADER) || bearer) return pass();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Sign in, or send an API key (Authorization: Bearer lf_…)' }, { status: 401, headers: { 'www-authenticate': 'Bearer realm="landflow"' } });
  }
  const login = request.nextUrl.clone();
  login.pathname = '/login';
  login.search = pathname === '/' ? '' : `?next=${encodeURIComponent(`${pathname}${search}`)}`;
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except Next.js's static files and image optimizer (the allow-list covers the rest).
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
