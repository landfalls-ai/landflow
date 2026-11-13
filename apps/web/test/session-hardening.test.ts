/**
 * Session and sign-in hardening (P24): a password change signs the other sessions out and keeps yours, an idle session
 * expires (LANDFLOW_SESSION_IDLE_HOURS), a cookie-authenticated change with no Origin but a cross-site Sec-Fetch-Site is
 * refused, and LANDFLOW_LOCAL_SIGN_IN=owner|off limits password sign-in. The test bypass is off.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-session-hardening-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
for (const key of ['LANDFLOW_OWNER_EMAIL', 'LANDFLOW_OWNER_PASSWORD', 'LANDFLOW_SESSION_IDLE_HOURS', 'LANDFLOW_LOCAL_SIGN_IN', 'LANDFLOW_LOGIN_MAX_ATTEMPTS']) delete process.env[key];

const auth = await import('@/lib/server/auth');
const { authDb } = await import('@/lib/server/auth/db');
const { tokenHash } = await import('@/lib/server/auth/passwords');
const { guardRequest } = await import('@/lib/server/auth/guard');
const { queryEvents } = await import('@/lib/server/audit/store');
const setupRoute = await import('@/app/api/auth/setup/route');
const loginRoute = await import('@/app/api/auth/login/route');
const meRoute = await import('@/app/api/auth/me/route');
const statusRoute = await import('@/app/api/auth/status/route');
const resetRoute = await import('@/app/api/auth/password/reset/route');
const forgotRoute = await import('@/app/api/auth/password/forgot/route');

beforeAll(() => auth.disableTestAuth());
afterAll(() => {
  auth.enableTestAuth();
  for (const key of ['LANDFLOW_DATA_DIR', 'LANDFLOW_REGISTRY_GRPC_PORT', 'LANDFLOW_SCAN_ON_START', 'LANDFLOW_PLUGINS', 'LANDFLOW_SESSION_IDLE_HOURS', 'LANDFLOW_LOCAL_SIGN_IN']) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const BASE = 'http://localhost:3000';
let ip = 0;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.1.0.${++ip}`, ...headers }, body: JSON.stringify(body) });
const tokenOf = (response: Response) => decodeURIComponent(response.headers.getSetCookie().find((c) => c.startsWith('landflow_session='))!.split(';')[0].slice('landflow_session='.length));
const signIn = (email: string, password: string) => loginRoute.POST(post('/api/auth/login', { email, password }));

const OWNER = { name: 'Olive', email: 'olive@example.com', password: 'owner-password-1' };
let ownerSession = '';

describe('session hardening', () => {
  it('sets up the owner', async () => {
    const created = await setupRoute.POST(post('/api/auth/setup', OWNER));
    expect(created.status).toBe(201);
    ownerSession = tokenOf(created);
  });

  it('a password change revokes the other sessions and keeps the current one', async () => {
    const other = tokenOf(await signIn(OWNER.email, OWNER.password));
    const changed = await meRoute.PATCH(
      new Request(`${BASE}/api/auth/me`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: `landflow_session=${ownerSession}`, origin: BASE },
        body: JSON.stringify({ currentPassword: OWNER.password, newPassword: 'owner-password-2' }),
      }),
    );
    expect(changed.status).toBe(200);
    expect(auth.sessionUser(ownerSession)).toBeDefined();
    expect(auth.sessionUser(other)).toBeUndefined();
    const event = queryEvents({ action: ['auth.password_change'] }).events[0];
    expect(event.details).toMatchObject({ reason: 'self', sessionsRevoked: 1 });
    OWNER.password = 'owner-password-2';
  });

  it('expires an idle session when an idle limit is set, and leaves it alone otherwise', async () => {
    const token = tokenOf(await signIn(OWNER.email, OWNER.password));
    const back = (hours: number) => {
      const row = authDb().get<Record<string, string>>('SELECT * FROM sessions WHERE id = ?', tokenHash(token))!;
      authDb().upsert('sessions', { ...row, last_seen_at: new Date(Date.now() - hours * 3_600_000).toISOString() });
    };
    back(100);
    expect(auth.sessionUser(token)).toBeDefined(); // development: no idle limit
    process.env.LANDFLOW_SESSION_IDLE_HOURS = '72';
    back(100);
    expect(auth.sessionUser(token)).toBeUndefined();
    expect(authDb().get('SELECT id FROM sessions WHERE id = ?', tokenHash(token))).toBeUndefined();
    const fresh = tokenOf(await signIn(OWNER.email, OWNER.password));
    expect(auth.sessionUser(fresh)).toBeDefined();
    delete process.env.LANDFLOW_SESSION_IDLE_HOURS;
  });

  it('idle sessions expire by default in production (72 h) when the variable is unset', async () => {
    const previous = process.env.LANDFLOW_PROFILE;
    process.env.LANDFLOW_PROFILE = 'production';
    try {
      const token = tokenOf(await signIn(OWNER.email, OWNER.password));
      const back = (hours: number) => {
        const row = authDb().get<Record<string, string>>('SELECT * FROM sessions WHERE id = ?', tokenHash(token))!;
        authDb().upsert('sessions', { ...row, last_seen_at: new Date(Date.now() - hours * 3_600_000).toISOString() });
      };
      back(60);
      expect(auth.sessionUser(token)).toBeDefined();
      back(80);
      expect(auth.sessionUser(token)).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.LANDFLOW_PROFILE;
      else process.env.LANDFLOW_PROFILE = previous;
    }
  });

  it('refuses a cookie-authenticated change with no Origin and a cross-site Sec-Fetch-Site', () => {
    const attempt = (headers: Record<string, string>) => guardRequest(new Request(`${BASE}/api/workflows`, { method: 'POST', headers: { cookie: `landflow_session=${ownerSession}`, ...headers } }));
    const refused = attempt({ 'sec-fetch-site': 'cross-site' });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.response.status).toBe(403);
    for (const site of ['same-origin', 'same-site', 'none']) expect(attempt({ 'sec-fetch-site': site }).ok, site).toBe(true);
    expect(attempt({}).ok).toBe(true);
    const nullOrigin = guardRequest(new Request(`${BASE}/api/workflows`, { method: 'POST', headers: { cookie: `landflow_session=${ownerSession}`, origin: 'null' } }));
    expect(nullOrigin.ok).toBe(false);
  });

  it('LANDFLOW_LOCAL_SIGN_IN=owner lets only the owner use a password; off lets no one', async () => {
    const { createUser } = await import('@/lib/server/auth/users');
    await createUser({ name: 'Mia', email: 'mia@example.com', password: 'member-password-1', role: 'member' });
    process.env.LANDFLOW_LOCAL_SIGN_IN = 'owner';
    expect((await statusRoute.GET(new Request(`${BASE}/api/auth/status`))).status).toBe(200);
    expect((await signIn(OWNER.email, OWNER.password)).status).toBe(200);
    const member = await signIn('mia@example.com', 'member-password-1');
    expect(member.status).toBe(403);
    expect(member.headers.getSetCookie()).toHaveLength(0);
    process.env.LANDFLOW_LOCAL_SIGN_IN = 'off';
    expect((await signIn(OWNER.email, OWNER.password)).status).toBe(403);
    expect((await (await statusRoute.GET(new Request(`${BASE}/api/auth/status`))).json()).localSignIn).toBe('off');
    expect((await signIn(OWNER.email, 'wrong-password')).status).toBe(401);
    delete process.env.LANDFLOW_LOCAL_SIGN_IN;
    expect((await signIn('mia@example.com', 'member-password-1')).status).toBe(200);
  });

  it('password reset follows LANDFLOW_LOCAL_SIGN_IN: no session where the mode refuses the password', async () => {
    const resetFor = (email: string, password: string) => {
      const user = auth.findUserByEmail(email)!;
      const { token } = auth.createResetToken(user);
      return resetRoute.POST(post('/api/auth/password/reset', { token, password }));
    };
    process.env.LANDFLOW_LOCAL_SIGN_IN = 'off';
    const off = await resetFor(OWNER.email, 'owner-password-3');
    expect(off.status).toBe(403);
    expect(off.headers.getSetCookie()).toHaveLength(0);
    process.env.LANDFLOW_LOCAL_SIGN_IN = 'owner';
    const member = await resetFor('mia@example.com', 'member-password-2');
    expect(member.status).toBe(403);
    expect(member.headers.getSetCookie()).toHaveLength(0);
    const owner = await resetFor(OWNER.email, 'owner-password-3');
    expect(owner.status).toBe(200);
    expect(owner.headers.getSetCookie().some((c) => c.startsWith('landflow_session='))).toBe(true);
    OWNER.password = 'owner-password-3';
    delete process.env.LANDFLOW_LOCAL_SIGN_IN;
    expect((await resetFor('mia@example.com', 'member-password-2')).status).toBe(200);
    expect(forgotRoute.POST).toBeTypeOf('function');
  });
});
