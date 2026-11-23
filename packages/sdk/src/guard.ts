/**
 * An opt-in guard for a plugin's HTTP face, for plugins that can start real work on the machine they run on (the deck
 * plugin). Without it any web page can POST `text/plain` to `http://127.0.0.1:<port>/…/execute` (a "simple" cross-site
 * request needs no preflight) and run a node. With it, a POST route and the MCP mount refuse:
 *   - any request carrying an `Origin` header (a browser's cross-origin call, or a DNS-rebinding page),
 *   - `Sec-Fetch-Site` other than `none`,
 *   - a body that is not `application/json`,
 *   - a call without the token the host derives from `LANDFLOW_TRANSPORT_SECRET` (else `LANDFLOW_REGISTRY_SECRET`).
 * The token is an HMAC of the shared secret, never the secret itself, so a plugin or a log never holds the raw value.
 * Discovery and health (GET) stay readable. The host sends the header on every HTTP call when it holds a secret.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const GUARD_HEADER = 'x-landflow-plugin-token';

export interface HttpGuard {
  /** What `x-landflow-plugin-token` must carry: `pluginHttpToken(secret)`. */
  token: string;
}

/**
 * The header value both sides compute from the shared secret and the plugin's id: the host derives it for the plugin it is
 * calling and the plugin checks it against its own id, so one plugin that receives its token cannot replay it to another.
 */
export function pluginHttpToken(secret: string, pluginId: string): string {
  return createHmac('sha256', secret).update(`landflow.plugin.http/v1|${pluginId}`).digest('hex');
}

/** The shared secret from the environment, as the broker faces read it (docs/transports.md). */
export function transportSecretFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.LANDFLOW_TRANSPORT_SECRET || env.LANDFLOW_REGISTRY_SECRET || undefined;
}

const refuse = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

/** A refusal response, or undefined when the request may go on. `needsJson` is false for GET (the MCP mount's streams). */
export function checkGuard(request: Request, guard: HttpGuard, needsJson = true): Response | undefined {
  if (request.headers.has('origin')) return refuse(403, 'Browser requests are refused by this plugin');
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'none') return refuse(403, 'Cross-site requests are refused by this plugin');
  const given = request.headers.get(GUARD_HEADER) ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(guard.token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return refuse(401, `Missing or wrong ${GUARD_HEADER}: start the host and this plugin with the same LANDFLOW_TRANSPORT_SECRET`);
  if (needsJson && !(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return refuse(415, 'Content-Type must be application/json');
  return undefined;
}
