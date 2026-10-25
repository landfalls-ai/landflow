/**
 * A fake OAuth2 provider on 127.0.0.1 for the OAuth2 credential tests: an authorization endpoint that "consents"
 * at once (302 back with a code), a token endpoint (authorization code with PKCE checks, refresh tokens with
 * rotation, client credentials, Basic or body client auth), a user info endpoint and a protected resource that
 * answers 401 to tokens it doesn't know. Every token request is recorded.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TokenRequest {
  params: Record<string, string>;
  /** Client id and secret from the Basic header, when it was used. */
  basic?: { id: string; secret: string };
}

export interface FakeOAuth2Options {
  clientId?: string;
  clientSecret?: string;
  /** expires_in of issued access tokens (seconds); undefined = none. */
  expiresIn?: number;
  /** Issue a new refresh token on every refresh (default true). */
  rotateRefreshTokens?: boolean;
}

export interface FakeOAuth2 {
  url: string;
  options: Required<Pick<FakeOAuth2Options, 'clientId' | 'clientSecret'>> & FakeOAuth2Options;
  tokenRequests: TokenRequest[];
  resourceCalls: Array<{ token: string; ok: boolean }>;
  /** The last authorization request's query. */
  lastAuthorize?: URLSearchParams;
  /** Access tokens the resource accepts. */
  validAccess: Set<string>;
  validRefresh: Set<string>;
  /** Make every issued access token unknown (as if the provider expired them early). */
  revokeAccess(): void;
  /** Make every refresh token unknown (invalid_grant). */
  revokeRefresh(): void;
  close(): Promise<void>;
}

const body = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });

export async function startFakeOAuth2(options: FakeOAuth2Options = {}): Promise<FakeOAuth2> {
  const opts = { clientId: 'client-1', clientSecret: 'secret-1', rotateRefreshTokens: true, ...options };
  const codes = new Map<string, { redirectUri: string; challenge?: string; scope?: string }>();
  let counter = 0;
  const fake: FakeOAuth2 = {
    url: '',
    options: opts,
    tokenRequests: [],
    resourceCalls: [],
    validAccess: new Set(),
    validRefresh: new Set(),
    revokeAccess: () => fake.validAccess.clear(),
    revokeRefresh: () => fake.validRefresh.clear(),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  const issue = (scope?: string) => {
    counter++;
    const access = `at-${counter}-${Math.random().toString(36).slice(2)}`;
    fake.validAccess.add(access);
    return { access_token: access, token_type: 'Bearer', ...(opts.expiresIn !== undefined && { expires_in: opts.expiresIn }), ...(scope && { scope }) };
  };
  const newRefresh = () => {
    const refresh = `rt-${counter}-${Math.random().toString(36).slice(2)}`;
    fake.validRefresh.add(refresh);
    return refresh;
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === '/authorize') {
      fake.lastAuthorize = url.searchParams;
      const code = `code-${++counter}`;
      codes.set(code, { redirectUri: url.searchParams.get('redirect_uri') ?? '', challenge: url.searchParams.get('code_challenge') ?? undefined, scope: url.searchParams.get('scope') ?? undefined });
      const back = new URL(url.searchParams.get('redirect_uri') ?? 'http://invalid');
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.toString() });
      res.end();
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const params = Object.fromEntries(new URLSearchParams(await body(req)));
      const header = req.headers.authorization;
      let basic: TokenRequest['basic'];
      if (header?.startsWith('Basic ')) {
        const [id, secret] = Buffer.from(header.slice(6), 'base64').toString().split(':').map(decodeURIComponent);
        basic = { id, secret };
      }
      fake.tokenRequests.push({ params, ...(basic && { basic }) });
      const clientId = basic?.id ?? params.client_id;
      const clientSecret = basic?.secret ?? params.client_secret;
      if (clientId !== opts.clientId) return send(401, { error: 'invalid_client', error_description: 'Unknown client' });
      if (params.grant_type === 'authorization_code') {
        const code = codes.get(params.code);
        if (!code) return send(400, { error: 'invalid_grant', error_description: 'Unknown code' });
        codes.delete(params.code);
        if (code.redirectUri !== params.redirect_uri) return send(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        if (code.challenge) {
          const challenge = createHash('sha256').update(params.code_verifier ?? '').digest('base64url');
          if (challenge !== code.challenge) return send(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        } else if (clientSecret !== opts.clientSecret) return send(401, { error: 'invalid_client' });
        const idToken = `e30.${Buffer.from(JSON.stringify({ sub: 'u1', preferred_username: 'alice', email: 'alice@example.test' })).toString('base64url')}.sig`;
        return send(200, { ...issue(code.scope), refresh_token: newRefresh(), id_token: idToken });
      }
      if (clientSecret !== opts.clientSecret) return send(401, { error: 'invalid_client' });
      if (params.grant_type === 'refresh_token') {
        if (!fake.validRefresh.has(params.refresh_token)) return send(400, { error: 'invalid_grant', error_description: 'Token is not active' });
        const answer: Record<string, unknown> = issue();
        if (opts.rotateRefreshTokens) {
          fake.validRefresh.delete(params.refresh_token);
          answer.refresh_token = newRefresh();
        }
        return send(200, answer);
      }
      if (params.grant_type === 'client_credentials') return send(200, issue(params.scope));
      return send(400, { error: 'unsupported_grant_type' });
    }
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (url.pathname === '/userinfo') return fake.validAccess.has(token) ? send(200, { preferred_username: 'alice' }) : send(401, { error: 'invalid_token' });
    if (url.pathname === '/resource') {
      const ok = fake.validAccess.has(token);
      fake.resourceCalls.push({ token, ok });
      return ok ? send(200, { hello: 'world' }) : send(401, { error: 'invalid_token' });
    }
    send(404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
