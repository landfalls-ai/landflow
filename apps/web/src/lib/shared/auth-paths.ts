/**
 * The public allow-list: the paths that answer without a session or an API key. Everything else (every page and
 * every /api route) needs one. Used by the proxy (src/proxy.ts), the server-side guard (lib/server/auth/guard.ts)
 * and the client (pages without the sidebar). No runtime imports: the proxy loads it.
 *
 * Add a public endpoint here, nowhere else. Routes that are public still authenticate their callers their own way
 * (webhook auth, form and MCP trigger auth, the instance MCP token, plugin binary tokens, the registry secret).
 */

/** The session cookie (HttpOnly, SameSite=Lax; Secure behind https). */
export const SESSION_COOKIE = 'landflow_session';
/** Header carrying an API key (`Authorization: Bearer lf_…` works too). */
export const API_KEY_HEADER = 'x-landflow-api-key';
/** API keys start with this. */
export const API_KEY_PREFIX = 'lf_';
/** The proxy passes the requested path (and query) to pages in this request header. */
export const PATH_HEADER = 'x-landflow-path';

/** Sign-in pages: no session needed, and no sidebar. */
export const AUTH_PAGES = ['/login', '/setup', '/invite', '/forgot-password', '/reset-password'] as const;

/** Public pages besides the sign-in pages (hosted chat), shown without the sidebar too. */
export const PUBLIC_PAGES = ['/chat'] as const;

/** Public API routes and route-handler paths (a prefix matches itself and everything below it). */
export const PUBLIC_ROUTES = [
  '/api/health',
  // Sign-in, setup, invites, password resets and OIDC (but /api/auth/me needs a session: see isPublicPath).
  '/api/auth',
  // SAML 2.0: SP-initiated login, the SP metadata, the ACS (signed responses) and single logout.
  '/api/auth/saml/login',
  '/api/auth/saml/metadata',
  '/api/auth/saml/acs',
  '/api/auth/saml/logout',
  // Triggers, each with its own auth: webhooks (webhook authentication), hosted forms, waits, MCP Server Triggers.
  '/api/webhook',
  '/form',
  '/api/waiting',
  '/mcp',
  // The instance MCP server: its own token (Settings → MCP).
  '/api/mcp',
  // OAuth2 credential callback (the provider redirects the browser here).
  '/api/oauth2/callback',
  // Plugins announce themselves and heartbeat here (optionally with LANDFLOW_REGISTRY_SECRET).
  '/api/plugins/announce',
  // Slack Events API and Interactivity (agent channels, approval buttons): verified with the app's signing secret.
  '/api/slack',
  // SCIM 2.0 provisioning (Okta, Entra ID): a bearer API key with the `scim` scope, checked by the routes.
  '/scim/v2',
] as const;

/** `/api/auth` routes that need a signed-in user. */
const PRIVATE_AUTH_ROUTES = ['/api/auth/me'];

/** True when `path` is `prefix` or below it (`/api/mcp` matches `/api/mcp` and `/api/mcp/x`, not `/api/mcpx`). */
export function underPath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

const STATIC_FILE = /\/[^/]+\.(?:svg|png|jpe?g|gif|webp|avif|ico|txt|xml|webmanifest|woff2?|ttf|otf|css|js|map)$/i;

/** Next.js internals and files from `public/` (anything outside /api with a file extension). */
export function isStaticAsset(path: string): boolean {
  return path.startsWith('/_next/') || path === '/favicon.ico' || (!path.startsWith('/api/') && STATIC_FILE.test(path));
}

/** Sign-in pages and public pages: rendered without the sidebar. */
export function isChromelessPage(path: string): boolean {
  return [...AUTH_PAGES, ...PUBLIC_PAGES].some((page) => underPath(path, page));
}

export interface PublicPathOptions {
  /** The request's `Authorization: Bearer` token, if any: `/api/binary` is public for plugin tokens (not `lf_` keys). */
  bearer?: string;
  /** LANDFLOW_METRICS_PUBLIC=true: Prometheus can scrape /api/metrics without a key. */
  metricsPublic?: boolean;
}

/** Whether `path` (a pathname, no query) answers without a session or API key. */
export function isPublicPath(path: string, options: PublicPathOptions = {}): boolean {
  if (isStaticAsset(path)) return true;
  if (isChromelessPage(path)) return true;
  if (PRIVATE_AUTH_ROUTES.some((route) => underPath(path, route))) return false;
  if (PUBLIC_ROUTES.some((route) => underPath(path, route))) return true;
  // Plugins read and write files with the per-call token the host gave them; the route verifies it.
  if (underPath(path, '/api/binary') && options.bearer && !options.bearer.startsWith(API_KEY_PREFIX)) return true;
  if (options.metricsPublic && path === '/api/metrics') return true;
  return false;
}

/** A safe place to go after signing in: a same-origin path (not `//host` or a URL), else `/`. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  if (AUTH_PAGES.some((page) => underPath(next.split(/[?#]/)[0], page))) return '/';
  return next;
}
