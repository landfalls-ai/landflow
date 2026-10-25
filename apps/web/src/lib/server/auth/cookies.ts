/**
 * Cookie helpers that work on any Request (route handlers, and tests that build plain Requests): reading the
 * Cookie header, and setting or clearing the session cookie on a NextResponse. The cookie is HttpOnly and
 * SameSite=Lax, and Secure when the request came over https (or LANDFLOW_SECURE_COOKIES=true).
 */
import type { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '../../shared/auth-paths';

/** The value of cookie `name` in the request's Cookie header. */
export function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

/** Whether cookies set for this request should be Secure: https (directly or behind a proxy), or forced by env. */
export function secureRequest(request: Request): boolean {
  const forced = process.env.LANDFLOW_SECURE_COOKIES?.trim().toLowerCase();
  if (forced === 'true') return true;
  if (forced === 'false') return false;
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === 'https';
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function setSessionCookie(response: NextResponse, request: Request, token: string, expiresAt: Date) {
  response.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: secureRequest(request), path: '/', expires: expiresAt });
}

export function clearSessionCookie(response: NextResponse, request: Request) {
  response.cookies.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: secureRequest(request), path: '/', maxAge: 0 });
}

/** The origin links in emails and redirects use: LANDFLOW_PUBLIC_URL, else the request's own (proxy headers first). */
export function publicOrigin(request?: Request): string {
  const configured = process.env.LANDFLOW_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  if (request) {
    const url = new URL(request.url);
    const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || request.headers.get('host') || url.host;
    const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(':', '');
    return `${proto}://${host}`;
  }
  return `http://localhost:${process.env.PORT ?? 3000}`;
}
