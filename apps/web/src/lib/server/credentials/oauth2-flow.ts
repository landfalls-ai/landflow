/**
 * The Connect flow of OAuth2 credentials, for the routes:
 *
 *   GET  /api/credentials/:id/oauth2/authorize  (signed-in) → 302 to the provider, with the flow's cookie
 *   GET  /api/oauth2/callback                   (public)    → verify state and cookie, exchange the code, save the token
 *   POST /api/credentials/:id/oauth2/token      (signed-in) → client credentials grant, or a refresh now
 *
 * The callback answers with a small page that tells the credential dialog (postMessage to its opener and a
 * BroadcastChannel, see lib/shared/oauth2.ts) and closes the popup.
 */
import type { JsonObject } from '@landflow/protocol';
import { OAUTH2_CALLBACK_PATH, OAUTH2_MESSAGE_CHANNEL, type OAuth2CallbackMessage } from '../../shared/oauth2';
import type { CredentialDetail } from '../../shared/types';
import { redactText } from '../secrets/redact';
import { logger } from '../telemetry/logger';
import {
  accountOf,
  authorizationUrl,
  clientCredentialsToken,
  exchangeCode,
  fetchUserInfo,
  jwtClaims,
  newNonce,
  OAuth2Error,
  pkceChallenge,
  pkceVerifier,
  signState,
  stateCookieName,
  STATE_TTL_MS,
  toStoredToken,
  verifyState,
} from './oauth2';
import { prepareMcpAuthorization } from '../mcp/oauth';
import { mcpUrlBlocked } from '../governance/policy';
import { CredentialError, credentials, resolveOAuth2Secrets } from './vault';
import { publicUrl, publicUrlConfigured } from '../config';

const stateKey = () => credentials.deriveKey('oauth2.state');
const pkceKey = () => credentials.deriveKey('oauth2.pkce');

/**
 * The redirect URL to register with providers: LANDFLOW_OAUTH2_REDIRECT_URL, else LANDFLOW_PUBLIC_URL's callback,
 * else the callback on the origin the request came to (the browser's, so the flow's cookie comes back with it).
 */
export function oauth2RedirectUrl(request?: Request): string {
  const configured = process.env.LANDFLOW_OAUTH2_REDIRECT_URL?.trim();
  if (configured) return configured;
  const base = publicUrlConfigured() || !request ? publicUrl() : new URL(request.url).origin;
  return `${base.replace(/\/+$/, '')}${OAUTH2_CALLBACK_PATH}`;
}

const secure = (request: Request) => new URL(request.url).protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';

function cookie(name: string, value: string, maxAge: number, request: Request): string {
  return `${name}=${value}; Path=${OAUTH2_CALLBACK_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure(request) ? '; Secure' : ''}`;
}

/**
 * Start a Connect flow: where to send the browser, and the cookie that ties the callback to it. The client fields may
 * read `$secrets` (here, at the code exchange, refreshes and client credentials grants: `resolveOAuth2Secrets`).
 */
export async function startAuthorization(credentialId: string, request: Request, now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<{ url: string; cookie: string }> {
  const redirectUri = oauth2RedirectUrl(request);
  // An MCP server's credential: find the authorization server and a client first (RFC 9728, 8414, 7591: lib/server/mcp/oauth.ts).
  const mcp = credentials.mcpOAuth(credentialId);
  if (mcp) {
    const form = await resolveOAuth2Secrets(mcp.form);
    const blocked = mcpUrlBlocked(mcp.serverUrl);
    if (blocked) throw new OAuth2Error(blocked);
    const meta = await prepareMcpAuthorization({ serverUrl: mcp.serverUrl, clientId: form.clientId, clientSecret: form.clientSecret, scope: form.scope, redirectUri, ...(mcp.meta && { meta: mcp.meta }) }, fetchImpl);
    credentials.saveMcpOAuthMeta(credentialId, meta as unknown as JsonObject);
  }
  const config = await resolveOAuth2Secrets(credentials.oauth2(credentialId).config);
  const nonce = newNonce();
  const state = signState(stateKey(), { c: credentialId, n: nonce, r: redirectUri, e: now + STATE_TTL_MS });
  const codeChallenge = config.grantType === 'pkce' ? pkceChallenge(pkceVerifier(pkceKey(), nonce)) : undefined;
  return { url: authorizationUrl(config, { redirectUri, state, ...(codeChallenge && { codeChallenge }) }), cookie: cookie(stateCookieName(nonce), '1', STATE_TTL_MS / 1000, request) };
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

export interface CallbackResult {
  message: OAuth2CallbackMessage;
  /** Expire the flow's cookie. */
  clearCookie?: string;
}

/** Finish a Connect flow from the provider's redirect. Never throws: failures become the page's message. */
export async function completeAuthorization(request: Request, fetchImpl?: typeof fetch): Promise<CallbackResult> {
  const params = new URL(request.url).searchParams;
  let credentialId: string | undefined;
  let clearCookie: string | undefined;
  try {
    const state = verifyState(stateKey(), params.get('state'));
    credentialId = state.c;
    const name = stateCookieName(state.n);
    if (readCookie(request, name) !== '1') {
      throw new OAuth2Error('This sign-in was started in another browser (or its cookie expired): connect again from the credential');
    }
    clearCookie = cookie(name, '', 0, request);
    const providerError = params.get('error');
    if (providerError) {
      const description = params.get('error_description');
      throw new OAuth2Error(providerError === 'access_denied' ? `Access was denied${description ? `: ${description}` : ''}` : `The provider answered ${providerError}${description ? `: ${description}` : ''}`, providerError);
    }
    const code = params.get('code');
    if (!code) throw new OAuth2Error('The provider sent no authorization code');
    const { config: saved, token: previous } = credentials.oauth2(credentialId);
    const config = await resolveOAuth2Secrets(saved);
    const codeVerifier = config.grantType === 'pkce' ? pkceVerifier(pkceKey(), state.n) : undefined;
    const response = await exchangeCode(config, { code, redirectUri: state.r, ...(codeVerifier && { codeVerifier }) }, fetchImpl);
    const token = toStoredToken(response, previous);
    const account = accountOf(token, jwtClaims(token.id_token) ? undefined : await fetchUserInfo(config, token.access_token, fetchImpl));
    credentials.saveOAuth2Token(credentialId, token, account);
    logger.info('OAuth2 credential connected', { 'landflow.credential.id': credentialId, 'oauth2.grant': config.grantType });
    return { message: { source: OAUTH2_MESSAGE_CHANNEL, credentialId, ok: true, message: account ? `Connected as ${account}` : 'Connected', ...(account && { account }) }, clearCookie };
  } catch (error) {
    const message = redactText(error instanceof OAuth2Error || error instanceof CredentialError ? error.message : `Connecting failed: ${(error as Error).message}`);
    if (credentialId && !(error instanceof OAuth2Error && error.code === 'access_denied')) {
      try {
        credentials.setOAuth2Error(credentialId, message);
      } catch {
        // The credential is gone.
      }
    }
    logger.warn('OAuth2 connect failed', { ...(credentialId && { 'landflow.credential.id': credentialId }), error: message });
    return { message: { source: OAUTH2_MESSAGE_CHANNEL, ...(credentialId && { credentialId }), ok: false, message }, ...(clearCookie && { clearCookie }) };
  }
}

/**
 * "Get token" / "Refresh now": a client credentials grant, or a refresh with the stored refresh token. Returns the
 * credential with its new status; a failure is recorded on the credential and thrown as a CredentialError.
 */
export async function requestTokenNow(credentialId: string, fetchImpl?: typeof fetch): Promise<CredentialDetail> {
  const { config: saved, token } = credentials.oauth2(credentialId);
  if (saved.grantType === 'clientCredentials') {
    let response: JsonObject;
    try {
      response = await clientCredentialsToken(await resolveOAuth2Secrets(saved), fetchImpl);
    } catch (error) {
      credentials.setOAuth2Error(credentialId, (error as Error).message);
      throw new CredentialError(redactText((error as Error).message));
    }
    const stored = toStoredToken(response, token);
    return credentials.saveOAuth2Token(credentialId, stored, accountOf(stored));
  }
  if (!token) throw new CredentialError('Not connected yet: use Connect to sign in with the provider');
  try {
    if (!(await credentials.refreshOAuth2(credentialId, { force: true, fetch: fetchImpl }))) {
      throw new CredentialError('The provider gave no refresh token, so the token can’t be renewed without signing in again: use Reconnect');
    }
  } catch (error) {
    throw error instanceof CredentialError ? error : new CredentialError((error as Error).message);
  }
  return credentials.get(credentialId)!;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page the popup lands on: it tells the dialog and closes itself (or explains what went wrong). */
export function callbackPage(result: CallbackResult): Response {
  const { message } = result;
  const payload = JSON.stringify(message).replace(/</g, '\\u003c');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${message.ok ? 'Connected' : 'Connection failed'} · Landflow</title>
<style>
  :root { color-scheme: light dark; --fg: #18181b; --muted: #71717a; --bg: #fafafa; --ok: #059669; --bad: #dc2626; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f4f4f5; --muted: #a1a1aa; --bg: #09090b; --ok: #34d399; --bad: #f87171; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; }
  main { max-width: 420px; padding: 24px; text-align: center; }
  h1 { font-size: 16px; margin: 0 0 6px; color: ${message.ok ? 'var(--ok)' : 'var(--bad)'}; }
  p { margin: 0; color: var(--muted); word-break: break-word; }
</style></head>
<body><main><h1>${message.ok ? 'Connected' : 'Connection failed'}</h1><p>${escapeHtml(message.message)}</p><p style="margin-top:12px">${message.ok ? 'This window closes by itself.' : 'Close this window and try again.'}</p></main>
<script>
  const message = ${payload};
  try { if (window.opener) window.opener.postMessage(message, window.location.origin); } catch {}
  try { const channel = new BroadcastChannel(${JSON.stringify(OAUTH2_MESSAGE_CHANNEL)}); channel.postMessage(message); channel.close(); } catch {}
  if (message.ok) setTimeout(() => window.close(), 900);
</script></body></html>`;
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  if (result.clearCookie) headers.append('set-cookie', result.clearCookie);
  return new Response(html, { status: message.ok ? 200 : 400, headers });
}
