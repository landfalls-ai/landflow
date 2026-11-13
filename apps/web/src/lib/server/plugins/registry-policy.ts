/**
 * Who may register or join a plugin. `registryOpen()` decides whether announces are accepted at all (auth/guard.ts and
 * the gRPC registry call it); the rest is what the registry applies to an announced endpoint: no metadata addresses in
 * production, and without the registry secret no joining an existing plugin from a new host.
 */
import { isProduction, envFlag } from '../config';
import { brokeredEndpoint } from '../transports/provider';

/** A refusal the announce route and the gRPC server turn into a status of their own (409 join, 422 address). */
export class RegistryRefused extends Error {
  constructor(message: string, readonly status: 409 | 422) {
    super(message);
  }
}

/**
 * True when announces without a secret are accepted: the development profile, or LANDFLOW_REGISTRY_OPEN=true. It does
 * not look at the secret itself: the callers (auth/guard.ts, registry-grpc.ts) check LANDFLOW_REGISTRY_SECRET first.
 */
export function registryOpen(): boolean {
  return !isProduction() || envFlag('LANDFLOW_REGISTRY_OPEN', false);
}

const hostname = (endpoint: string): string | undefined => {
  try {
    return new URL(endpoint).hostname.replace(/^\[|\]$/g, '').toLowerCase();
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
