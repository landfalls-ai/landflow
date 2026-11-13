/**
 * Who may register or join a plugin. `registryOpen()` decides whether announces are accepted at all (auth/guard.ts and
 * the gRPC registry call it); the rest is what the registry applies to an announced endpoint: no metadata addresses in
 * production, and without the registry secret no joining an existing plugin from a new host.
 */
import { isProduction, envFlag } from '../config';
import { brokeredEndpoint } from '../transports/provider';
import { HttpError } from '../errors';

/** A refusal the announce route and the gRPC server turn into a status of their own (409 join, 422 address). */
export class RegistryRefused extends HttpError {
  declare readonly status: 409 | 422;
  constructor(message: string, status: 409 | 422) {
    super(message, status);
  }
}

/**
 * True when announces without a secret are accepted: the development profile, or LANDFLOW_REGISTRY_OPEN=true. It does
 * not look at the secret itself: the callers (auth/guard.ts, registry-grpc.ts) check LANDFLOW_REGISTRY_SECRET first.
 */
export function registryOpen(): boolean {
  return !isProduction() || envFlag('LANDFLOW_REGISTRY_OPEN', false);
}

/**
 * The endpoint's host, normalised as an http URL's would be: `grpc://` and broker URLs are not special schemes, so the
 * URL parser leaves `2852039166` or `0xa9fea9fe` as written; parsing the host again as http turns them into dotted IPv4.
 */
/** Logged once at boot by a main (runtime.ts), whether or not the gRPC registry listens: the HTTP route is open too. */
export function noteRegistryOpen(log: (message: string) => void): void {
  if (!process.env.LANDFLOW_REGISTRY_SECRET && registryOpen()) log('plugin registration is open: LANDFLOW_REGISTRY_SECRET is not set, so any reachable endpoint can register (development profile, or LANDFLOW_REGISTRY_OPEN=true)');
}

const hostname = (endpoint: string): string | undefined => {
  try {
    return new URL(`http://${new URL(endpoint).hostname}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return undefined;
  }
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
const sameHost = (a: string, b: string) => a === b || (LOOPBACK.has(a) && LOOPBACK.has(b));

/** Production only: the cloud metadata address and the link-local range are never a plugin (the full outbound policy is S5). */
export function registryRefusesAddress(endpoint: string): boolean {
  if (!isProduction()) return false;
  const host = hostname(endpoint);
  if (!host) return false;
  const v4 = host.replace(/^::ffff:/, '');
  // IPv4-mapped 169.254.x.x also arrives as hex (`::ffff:a9fe:xxxx`); fe80::/10 is fe80 to febf.
  return /^169\.254\./.test(v4) || host.startsWith('::ffff:a9fe:') || /^fe[89ab][0-9a-f]:/.test(host) || host === 'fd00:ec2::254';
}

/**
 * An endpoint on a host the plugin already has may join; another host needs LANDFLOW_REGISTRY_ALLOW_JOIN=true. Brokered
 * endpoints (`nats://<connectionId>/<plugin>`) have no host: they are left out of the comparison, and a plugin that has
 * only brokered endpoints (or an announce that is itself brokered) lets the join through, since the broker connection
 * was already proven with the transport secret.
 */
export function registryJoinAllowed(endpoint: string, existing: string[]): boolean {
  if (envFlag('LANDFLOW_REGISTRY_ALLOW_JOIN', false)) return true;
  if (brokeredEndpoint(endpoint)) return true;
  const direct = existing.filter((other) => !brokeredEndpoint(other));
  if (direct.length === 0) return true;
  const host = hostname(endpoint);
  if (!host) return false;
  return direct.some((other) => {
    const known = hostname(other);
    return known !== undefined && sameHost(host, known);
  });
}
