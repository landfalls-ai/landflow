/**
 * Who may register or join a plugin. `registryOpen()` decides whether announces are accepted at all (auth/guard.ts and
 * the gRPC registry call it); the rest is what the registry applies to an announced endpoint: no metadata addresses in
 * production, and without the registry secret no joining an existing plugin from a new host.
 */
import { isProduction, envFlag, envString } from '../config';

/** A refusal the announce route and the gRPC server turn into a status of their own (409 join, 422 address). */
export class RegistryRefused extends Error {
  constructor(message: string, readonly status: 409 | 422) {
    super(message);
  }
}

/** True when announces without a secret are accepted: the development profile, or LANDFLOW_REGISTRY_OPEN=true. */
export function registryOpen(): boolean {
  return !isProduction() || envFlag('LANDFLOW_REGISTRY_OPEN', false);
}

/** Whether an announce is allowed to proceed given its credential; `secretOk` says it carried the right secret. */
export function registryAccepts(secretOk: boolean): boolean {
  return envString('LANDFLOW_REGISTRY_SECRET') ? secretOk : registryOpen();
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
  return /^169\.254\./.test(v4) || host.startsWith('fe80:') || host === 'fd00:ec2::254';
}

/** An endpoint on a host the plugin already has may join; another host needs LANDFLOW_REGISTRY_ALLOW_JOIN=true. */
export function registryJoinAllowed(endpoint: string, existing: string[]): boolean {
  if (envFlag('LANDFLOW_REGISTRY_ALLOW_JOIN', false)) return true;
  const host = hostname(endpoint);
  if (!host) return false;
  return existing.some((other) => {
    const known = hostname(other);
    return known !== undefined && sameHost(host, known);
  });
}
