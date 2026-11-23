/**
 * Secret routes of a Claude Code agent on kagent (docs/a2a.md, "Secret routes"): the vault side. A route names a Landflow
 * credential (Bearer Auth or Header Auth) and hosts; resolving one checks the rules, that the credential exists and that the
 * agent's project may use it, and reads the value to write to the cluster Secret (./manifests.ts `routeObjects`). The value
 * goes nowhere else: the keyed hash below is what Landflow keeps to see a change without reading the Secret.
 */
import { createHmac } from 'node:crypto';
import { headerProblem, ROUTE_TYPE_LABELS, routeDefaults, routeProblem, routesProblem, type KagentSecretRoute, ROUTE_CREDENTIAL_TYPES } from '../../shared/kagent-routes';
import { isProduction } from '../config/profile';
import { credentials } from '../credentials/vault';
import { credentialUsableBy } from '../projects/access';
import { homeProjectId } from '../projects/store';
import { KagentError } from './errors';
import type { ResolvedRoute } from './manifests';

const HASH_LABEL = 'kagent.routes';
const TYPES = `${ROUTE_TYPE_LABELS['core.httpBearerAuth']} and ${ROUTE_TYPE_LABELS['core.httpHeaderAuth']}`;
/** Names a sandbox could reach only inside a cluster or a LAN: a route to one in production would hand the credential to an internal service. */
const INTERNAL_HOST = /^(localhost|[^.]+|.*\.(local|localhost|internal|intranet|lan|home|home\.arpa|corp|svc|cluster\.local|svc\.cluster\.local))$/i;

/** One route's own problems plus the one production adds: a single-label or internal host. */
export function serverRouteProblem(route: KagentSecretRoute, index: number, production = isProduction()): string | undefined {
  const problem = routeProblem(route, index);
  if (problem || !production) return problem;
  for (const host of route.hosts) {
    if (INTERNAL_HOST.test(new URL(host).hostname)) return `Route ${index + 1}: ${host}: internal hosts can’t get a credential in production`;
  }
  return undefined;
}

/** The whole list's problems: each route's, then the list's (size, a host in two routes). */
export function serverRoutesProblem(routes: KagentSecretRoute[], production = isProduction()): string | undefined {
  for (const [index, route] of routes.entries()) {
    const problem = serverRouteProblem(route, index, production);
    if (problem) return problem;
  }
  return routesProblem(routes);
}

/** What a credential sends by default, and its value: Bearer Auth `token`, Header Auth `name` and `value`. */
async function readCredential(ref: { id: string; name: string }, type: string): Promise<{ header?: string; value: string }> {
  const data = await credentials.dataWithSecrets(ref, type);
  if (type === 'core.httpBearerAuth') return { value: typeof data.token === 'string' ? data.token : '' };
  return { header: typeof data.name === 'string' ? data.name.trim() : '', value: typeof data.value === 'string' ? data.value : '' };
}

// eslint-disable-next-line no-control-regex
const HAS_CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The routes with their values, in the order given (keys `r0`, `r1`…). Strict: the first route that can't be used throws a
 * KagentError that names it and its credential. `lenient` leaves such a route with an empty value and says which it was
 * (the refresh: a credential deleted since the deploy empties its key and shows the route as broken).
 */
export async function resolveRoutes(agentId: string, routes: KagentSecretRoute[], options: { lenient: true }): Promise<{ routes: ResolvedRoute[]; broken: Array<{ index: number; credentialName: string; reason: string }> }>;
export async function resolveRoutes(agentId: string, routes: KagentSecretRoute[]): Promise<ResolvedRoute[]>;
export async function resolveRoutes(agentId: string, routes: KagentSecretRoute[], options?: { lenient: true }): Promise<ResolvedRoute[] | { routes: ResolvedRoute[]; broken: Array<{ index: number; credentialName: string; reason: string }> }> {
  // Strict: the first problem fails the deploy. Lenient (the refresh): a route that no longer passes is marked broken below.
  const problem = options ? undefined : serverRoutesProblem(routes);
  if (problem) throw new KagentError(problem);
  const project = homeProjectId('agent', agentId);
  const out: ResolvedRoute[] = [];
  const broken: Array<{ index: number; credentialName: string; reason: string }> = [];
  for (const [index, route] of routes.entries()) {
    const at = `Route ${index + 1}`;
    const stored = credentials.get(route.credential.id);
    const name = stored?.name ?? route.credential.name;
    const fail = (reason: string) => {
      if (!options) throw new KagentError(`${at}: ${reason}`);
      broken.push({ index, credentialName: name, reason });
      out.push({ key: `r${index}`, header: route.header ?? routeDefaults('core.httpBearerAuth').header!, prefix: route.prefix ?? '', hosts: route.hosts, value: '', credentialId: route.credential.id, credentialName: name });
    };
    const rule = options ? serverRouteProblem(route, index) : undefined;
    if (rule) {
      fail(rule.replace(/^Route \d+: /, ''));
      continue;
    }
    if (!stored) {
      fail(`the credential “${name}” was deleted: choose another`);
      continue;
    }
    if (!(ROUTE_CREDENTIAL_TYPES as readonly string[]).includes(stored.type)) {
      fail(`the credential “${name}” is a ${stored.type}: only ${TYPES} hold one header value`);
      continue;
    }
    if (!credentialUsableBy(stored.id, project)) {
      fail(`the credential “${name}” isn’t one this agent’s project may use: share it with the project, or choose another`);
      continue;
    }
    let read: { header?: string; value: string };
    try {
      read = await readCredential({ id: stored.id, name }, stored.type);
    } catch (error) {
      fail(`the credential “${name}” couldn’t be read: ${(error as Error).message}`);
      continue;
    }
    const defaults = routeDefaults(stored.type);
    const header = route.header ?? defaults.header ?? read.header ?? '';
    const headerFault = headerProblem(header);
    if (headerFault) {
      fail(`the credential “${name}” sends ${headerFault}`);
      continue;
    }
    if (!read.value || HAS_CONTROL.test(read.value)) {
      fail(`the credential “${name}” has ${read.value ? 'a value with a line break' : 'no value'}`);
      continue;
    }
    out.push({ key: `r${index}`, header, prefix: route.prefix ?? defaults.prefix, hosts: route.hosts, value: read.value, credentialId: stored.id, credentialName: name });
  }
  return options ? { routes: out, broken } : out;
}

/** The route as the deployment records it: the credential's name as the vault has it, header and prefix filled in. No value. */
export const recordedRoute = (route: ResolvedRoute): KagentSecretRoute => ({ credential: { id: route.credentialId, name: route.credentialName }, hosts: route.hosts, header: route.header, ...(route.prefix && { prefix: route.prefix }) });

/** What is hashed: each route as the gateway uses it, in a fixed order (so reordering the list changes nothing; keys are not part of it). */
const canonical = (routes: ResolvedRoute[]) =>
  JSON.stringify(
    routes
      .map((r) => JSON.stringify([r.header, r.prefix, [...r.hosts].sort(), r.value]))
      .sort(),
  );
const hmac = (key: Buffer, routes: ResolvedRoute[]) => createHmac('sha256', key).update(canonical(routes)).digest('hex');

/** HMAC-SHA-256 (hex) of the routes with a key derived from the vault's, so a hash can't be turned back into a value or tried against guesses without it. */
export const routesHmac = (routes: ResolvedRoute[]): string => hmac(credentials.deriveKey(HASH_LABEL), routes);

/** The hash of each route alone, in order (the refresh compares them one by one). */
export const routeHmacs = (routes: ResolvedRoute[]): string[] => routes.map((route) => routesHmac([route]));

/** Whether `stored` is these routes' hash under any key of the ring: a key rotation since the deploy changes nothing. */
export const routesHashMatches = (routes: ResolvedRoute[], stored: string | undefined): boolean => Boolean(stored) && credentials.deriveKeys(HASH_LABEL).some((key) => hmac(key, routes) === stored);
