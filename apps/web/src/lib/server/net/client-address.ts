/**
 * The caller's address behind zero or more trusted proxies. Next.js sets X-Forwarded-For to the socket address only
 * when the request has none, so a client that sends the header controls every entry but the ones its proxies append:
 * the hop count (LANDFLOW_TRUSTED_PROXIES) says how many entries at the end of the list were written by our own
 * infrastructure. With 0 the last entry is used (the socket address when the client sent none; a direct client can
 * still forge it, which is why per-IP limits are only as good as the hop count).
 */
import { envInt, isProduction } from '../config';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';

/** How many reverse proxies sit in front of the host (LANDFLOW_TRUSTED_PROXIES, default 0). */
export const trustedProxies = (): number => envInt('LANDFLOW_TRUSTED_PROXIES', { fallback: 0, min: 0, max: 16 });

/** One address as text: spaces, a port and IPv6 brackets removed; ::ffff:a.b.c.d is the IPv4 address. */
export function normalizeAddress(raw: string): string {
  let ip = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
  return /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip) ? ip.slice(7) : ip;
}

/** Whether the unset-LANDFLOW_TRUSTED_PROXIES warning was logged: process-wide, so Next's separate bundles warn once. */
const warning = () => singleton('client-address-warning', () => ({ warned: false }));

/** The client's address, or `local` when no header names one. */
export function clientAddress(request: Request): string {
  const hops = trustedProxies();
  if (hops === 0 && isProduction() && !process.env.LANDFLOW_TRUSTED_PROXIES?.trim() && !warning().warned) {
    warning().warned = true;
    logger.warn('LANDFLOW_TRUSTED_PROXIES is not set: client addresses (rate limits, audit, webhook allow-lists) are unverified. Set it to the number of reverse proxies in front of the host (0 when clients connect directly).');
  }
  const entries = (request.headers.get('x-forwarded-for') ?? '').split(',').map(normalizeAddress).filter(Boolean);
  let ip: string | undefined;
  if (hops >= 1) ip = entries.length ? entries[Math.max(0, entries.length - hops)] : request.headers.get('x-real-ip')?.trim() ? normalizeAddress(request.headers.get('x-real-ip')!) : undefined;
  else ip = entries.at(-1);
  return (ip || 'local').slice(0, 64);
}

/** Test hook: the once-only warning fires again. */
export const resetClientAddressWarning = () => {
  warning().warned = false;
};
