/**
 * Cookie helpers that work on any Request (route handlers, and tests that build plain Requests): reading the
 * Cookie header, and setting or clearing the session cookie on a NextResponse. The cookie is HttpOnly and
 * SameSite=Lax, and Secure when the request came over https (or LANDFLOW_SECURE_COOKIES=true).
 */
import { isProduction, publicUrl, publicUrlConfigured } from '../config';
import { trustedProxies } from '../net/client-address';
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

/**
 * The origin links and redirects use: LANDFLOW_PUBLIC_URL, else the request's own URL. X-Forwarded-Host and
 * -Proto count only behind trusted proxies (LANDFLOW_TRUSTED_PROXIES >= 1): otherwise a client could name any host.
 */
export function publicOrigin(request?: Request): string {
  if (publicUrlConfigured()) return publicUrl();
  if (request) {
    const url = new URL(request.url);
    const trusted = trustedProxies() >= 1;
    const host = (trusted && request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()) || url.host;
    const proto = (trusted && request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()) || url.protocol.replace(':', '');
    return `${proto}://${host}`;
  }
  return publicUrl();
}

/** Why links can't be made (production without LANDFLOW_PUBLIC_URL), or undefined when they can. */
export function linkOriginMissing(): string | undefined {
  return isProduction() && !publicUrlConfigured() ? 'Set LANDFLOW_PUBLIC_URL to send links' : undefined;
}

/** The origin for links sent by email (invites, resets): in production never taken from a request header. */
export function emailedOrigin(request?: Request): string {
  const missing = linkOriginMissing();
  if (missing) throw new Error(missing);
  return publicOrigin(request);
}
