/**
 * Secret routes of a Claude Code agent on kagent (docs/a2a.md, "Secret routes"): the rules a route must meet, shared by the
 * server (which refuses a bad one) and the kagent card (which says why as the person types). A route sends one Landflow
 * credential's value as a header to the hosts it lists; kagent's egress gateway adds it, so the sandbox never holds it.
 */
import type { CredentialRef } from './agents';

export interface KagentSecretRoute {
  credential: CredentialRef;
  /** `https://` origins: DNS names only, no wildcard, path or userinfo. */
  hosts: string[];
  /** Default: `Authorization` for Bearer Auth, the credential's own header name for Header Auth. */
  header?: string;
  /** Put before the value (default `Bearer ` for Bearer Auth, none for Header Auth). */
  prefix?: string;
}

export const ROUTE_LIMITS = { routes: 20, hostsPerRoute: 10 } as const;
/** Credential types that hold one static header value: Bearer Auth and Header Auth. */
export const ROUTE_CREDENTIAL_TYPES = ['core.httpBearerAuth', 'core.httpHeaderAuth'] as const;
export const ROUTE_TYPE_LABELS: Record<string, string> = { 'core.httpBearerAuth': 'Bearer Auth', 'core.httpHeaderAuth': 'Header Auth' };
export const PLACEHOLDER_HINT = 'The sandbox sends the header with any value, and the gateway puts the real one in.';
export const PLACEHOLDER_EXAMPLE = "curl -H 'Authorization: x' https://<host>/";

/** An origin as kagent's EgressPolicy takes it: https, DNS labels (the last starts with a letter, so no IP address), an optional port. */
const HTTPS_ORIGIN = /^https:\/\/([a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?\.)*[a-z]([-a-z0-9]{0,61}[a-z0-9])?(:\d{1,5})?$/;
/** RFC 7230 token. */
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Headers the gateway or the HTTP stack owns: a credential can not be sent as one of these. */
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'cookie', 'set-cookie', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate']);
export const MAX_HEADER_LENGTH = 100;
export const MAX_PREFIX_LENGTH = 64;

/** What a credential type sends when the person types no header or prefix (Header Auth: its own header, resolved on the server). */
export function routeDefaults(type: string): { header?: string; prefix: string } {
  return type === 'core.httpBearerAuth' ? { header: 'Authorization', prefix: 'Bearer ' } : { prefix: '' };
}

/** Why a header name can't be used, or undefined. */
export function headerProblem(header: string): string | undefined {
  if (!header || header.length > MAX_HEADER_LENGTH || !HEADER_TOKEN.test(header)) return `“${header.slice(0, 40)}” is not a header name (letters, digits and dashes)`;
  if (FORBIDDEN_HEADERS.has(header.toLowerCase())) return `the ${header} header can’t carry a credential`;
  return undefined;
}

/** Why one host can't be used, or undefined. */
export function hostProblem(host: string): string | undefined {
  if (host.includes('*')) return `${host}: no wildcards, list each host`;
  if (!/^https:\/\//i.test(host)) return `${host || '(empty)'}: only https origins, like https://api.example.com`;
  let origin: string;
  try {
    origin = new URL(host).origin;
  } catch {
    return `${host}: not a URL`;
  }
  // Anything but the bare origin (a path, query, userinfo, the default port, upper case): the gateway matches origins.
  if (origin !== host) return `${host}: write the origin only, like ${HTTPS_ORIGIN.test(origin) ? origin : 'https://api.example.com'} (no path, query, user or default port)`;
  if (!HTTPS_ORIGIN.test(host)) return `${host}: a DNS name is needed, not an IP address`;
  return undefined;
}

/** A problem with one route as typed (hosts, header, prefix), or undefined. `index` is 0-based; messages count from 1. */
export function routeProblem(route: KagentSecretRoute, index: number): string | undefined {
  const at = `Route ${index + 1}`;
  if (!route.hosts.length) return `${at}: add at least one host`;
  if (route.hosts.length > ROUTE_LIMITS.hostsPerRoute) return `${at}: at most ${ROUTE_LIMITS.hostsPerRoute} hosts`;
  for (const host of route.hosts) {
    const problem = hostProblem(host);
    if (problem) return `${at}: ${problem}`;
  }
  if (route.header !== undefined) {
    const problem = headerProblem(route.header);
    if (problem) return `${at}: ${problem}`;
  }
  if (route.prefix !== undefined && (route.prefix.length > MAX_PREFIX_LENGTH || /[\u0000-\u001f\u007f]/.test(route.prefix))) return `${at}: the prefix is up to ${MAX_PREFIX_LENGTH} characters with no line breaks`;
  return undefined;
}

/** A problem with the whole list: its size, and a host named by two routes (the gateway has one header per host). */
export function routesProblem(routes: KagentSecretRoute[]): string | undefined {
  if (routes.length > ROUTE_LIMITS.routes) return `At most ${ROUTE_LIMITS.routes} routes per agent`;
  const seen = new Map<string, number>();
  for (const [index, route] of routes.entries()) {
    const problem = routeProblem(route, index);
    if (problem) return problem;
    for (const host of route.hosts) {
      const first = seen.get(host);
      if (first !== undefined) return `Route ${index + 1}: ${host} is already in Route ${first + 1}`;
      seen.set(host, index);
    }
  }
  return undefined;
}

/** A route as the editor holds it while the person works: the credential may not be chosen yet. */
export interface KagentRouteDraft extends Omit<KagentSecretRoute, 'credential'> {
  credential?: CredentialRef;
}

/** Why a draft can't be sent yet (no credential, or a rule of `routeProblem`), or undefined. */
export function draftProblem(draft: KagentRouteDraft, index: number): string | undefined {
  if (!draft.credential) return `Route ${index + 1}: choose a credential`;
  return routeProblem({ ...draft, credential: draft.credential }, index);
}

/** The first problem of a list of drafts: each draft's own, then the list's (a host in two routes, too many routes). */
export function draftsProblem(drafts: KagentRouteDraft[]): string | undefined {
  for (const [index, draft] of drafts.entries()) {
    const problem = draftProblem(draft, index);
    if (problem) return problem;
  }
  return routesProblem(drafts as KagentSecretRoute[]);
}
