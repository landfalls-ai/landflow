/**
 * Sign-in and access control: owner setup, password sign-in and sign-out, scrypt hashes, sessions (hashed, expiring),
 * sign-in rate limits, invites and password resets (through a fake mail transport), the route guard and its public
 * allow-list, the proxy, roles, API keys (scopes, expiry, session-only routes), the registry secret and who
 * created/changed a workflow. The test bypass is off here: every request carries real credentials or none.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-auth-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const UNSET = ['LANDFLOW_OWNER_EMAIL', 'LANDFLOW_OWNER_PASSWORD', 'LANDFLOW_SMTP_HOST', 'LANDFLOW_PUBLIC_URL', 'LANDFLOW_SECURE_COOKIES', 'LANDFLOW_REGISTRY_SECRET', 'LANDFLOW_METRICS_PUBLIC', 'LANDFLOW_OIDC_ISSUER', 'LANDFLOW_LOGIN_MAX_ATTEMPTS'];
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
for (const key of UNSET) delete process.env[key];

const auth = await import('@/lib/server/auth');
const { hashPassword, verifyPassword, tokenHash } = await import('@/lib/server/auth/passwords');
const { authDb } = await import('@/lib/server/auth/db');
const { RateLimiter } = await import('@/lib/server/auth/rate-limit');
const { setMailTransport } = await import('@/lib/server/auth/mail');
const { guardRequest } = await import('@/lib/server/auth/guard');
const { isPublicPath, safeNext } = await import('@/lib/shared/auth-paths');
const { can, canManageUser, hasScope } = await import('@/lib/shared/auth');
const { proxy } = await import('@/proxy');
const { queryEvents } = await import('@/lib/server/audit/store');

const statusRoute = await import('@/app/api/auth/status/route');
const setupRoute = await import('@/app/api/auth/setup/route');
const loginRoute = await import('@/app/api/auth/login/route');
const logoutRoute = await import('@/app/api/auth/logout/route');
const meRoute = await import('@/app/api/auth/me/route');
const inviteTokenRoute = await import('@/app/api/auth/invites/[token]/route');
const forgotRoute = await import('@/app/api/auth/password/forgot/route');
const resetRoute = await import('@/app/api/auth/password/reset/route');
const usersRoute = await import('@/app/api/users/route');
const invitesRoute = await import('@/app/api/users/invites/route');
const inviteIdRoute = await import('@/app/api/users/invites/[id]/route');
const userRoute = await import('@/app/api/users/[id]/route');
const userResetRoute = await import('@/app/api/users/[id]/password-reset/route');
const apiKeysRoute = await import('@/app/api/api-keys/route');
const apiKeyRoute = await import('@/app/api/api-keys/[id]/route');
const workflowsRoute = await import('@/app/api/workflows/route');
const workflowRoute = await import('@/app/api/workflows/[id]/route');
const healthRoute = await import('@/app/api/health/route');
const securityRoute = await import('@/app/api/settings/security/route');

beforeAll(() => auth.disableTestAuth());
afterAll(() => {
  auth.enableTestAuth();
  setMailTransport(undefined);
  for (const key of [...Object.keys(ENV), ...UNSET]) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

// ---- helpers -----------------------------------------------------------------------------------------------

const BASE = 'http://localhost:3000';
type Route = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Options = { method?: string; body?: unknown; session?: string; key?: string; bearer?: string; headers?: Record<string, string>; ip?: string };

/** Each test file request comes from its own address unless one is given, so the per-IP form limit doesn't trip. */
let ipCounter = 0;
function request(path: string, options: Options = {}): Request {
  const headers: Record<string, string> = { 'x-forwarded-for': options.ip ?? `10.0.0.${(ipCounter++ % 250) + 1}`, ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.session) headers.cookie = `landflow_session=${options.session}`;
  if (options.key) headers['x-landflow-api-key'] = options.key;
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  return new Request(`${BASE}${path}`, { method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'), headers, ...(options.body !== undefined && { body: JSON.stringify(options.body) }) });
}

async function call(route: unknown, path: string, options: Options = {}, params?: Record<string, string>) {
  const response = await (route as Route)(request(path, options), params && { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as Record<string, any>, response };
}

/** The session token in a response's Set-Cookie, and the cookie's attributes. */
function sessionCookie(response: Response): { token: string; attributes: string } | undefined {
  const line = response.headers.getSetCookie().find((c) => c.startsWith('landflow_session='));
  if (!line) return undefined;
  const [pair, ...rest] = line.split(';');
  return { token: decodeURIComponent(pair.slice('landflow_session='.length)), attributes: rest.join(';').toLowerCase() };
}

const OWNER = { name: 'Olive Owner', email: 'Olive@Example.com', password: 'owner-password-1' };
let ownerSession = '';
let ownerId = '';

async function signIn(email: string, password: string): Promise<string> {
  const result = await call(loginRoute.POST, '/api/auth/login', { body: { email, password } });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return sessionCookie(result.response)!.token;
}

/** Invite `email` as `role` (owner's session) and accept it: the new user's id and session. */
async function addUser(email: string, role: 'admin' | 'member', name = email.split('@')[0]) {
  const invited = await call(invitesRoute.POST, '/api/users/invites', { body: { email, role }, session: ownerSession });
  expect(invited.status, JSON.stringify(invited.body)).toBe(201);
  const token = String(invited.body.link).split('/invite/')[1];
  const accepted = await call(inviteTokenRoute.POST, `/api/auth/invites/${token}`, { body: { name, password: `${name}-password` } }, { token });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
  return { id: accepted.body.user.id as string, session: sessionCookie(accepted.response)!.token, password: `${name}-password` };
}

// ---- tests -------------------------------------------------------------------------------------------------

describe('passwords (scrypt)', () => {
  it('hashes with a per-user salt and verifies', async () => {
    const one = await hashPassword('correct horse');
    const two = await hashPassword('correct horse');
    expect(one).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=_-]+\$[A-Za-z0-9+/=_-]+$/);
    expect(one).not.toBe(two);
    expect(one).not.toContain('correct horse');
    expect(await verifyPassword('correct horse', one)).toBe(true);
    expect(await verifyPassword('correct horse', two)).toBe(true);
    expect(await verifyPassword('wrong horse', one)).toBe(false);
    expect(await verifyPassword('correct horse', 'scrypt$garbage')).toBe(false);
    expect(await verifyPassword('correct horse', undefined)).toBe(false);
  });
});

describe('owner setup', () => {
  it('starts in setup: the API refuses everyone and says setup is needed', async () => {
    expect((await call(statusRoute.GET, '/api/auth/status')).body).toMatchObject({ setupRequired: true, smtp: false });
    const blocked = await call(workflowsRoute.GET, '/api/workflows');
    expect(blocked.status).toBe(401);
    expect(blocked.body).toMatchObject({ setupRequired: true });
    expect(blocked.response.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('validates, creates the owner, signs them in with an HttpOnly SameSite=Lax cookie, then refuses a second setup', async () => {
    expect((await call(setupRoute.POST, '/api/auth/setup', { body: { ...OWNER, password: 'short' } })).status).toBe(400);
    expect((await call(setupRoute.POST, '/api/auth/setup', { body: { ...OWNER, email: 'not-an-email' } })).status).toBe(400);

    const created = await call(setupRoute.POST, '/api/auth/setup', { body: OWNER });
    expect(created.status).toBe(201);
    expect(created.body.user).toMatchObject({ name: 'Olive Owner', email: 'olive@example.com', role: 'owner', hasPassword: true });
    const cookie = sessionCookie(created.response)!;
    expect(cookie.attributes).toContain('httponly');
    expect(cookie.attributes).toContain('samesite=lax');
    expect(cookie.attributes).toContain('path=/');
    expect(cookie.attributes).not.toContain('secure');
    ownerSession = cookie.token;
    ownerId = created.body.user.id;

    expect((await call(statusRoute.GET, '/api/auth/status')).body.setupRequired).toBe(false);
    const again = await call(setupRoute.POST, '/api/auth/setup', { body: { ...OWNER, email: 'second@example.com' } });
    expect(again.status).toBe(409);
  });
});

describe('sign-in, sessions and sign-out', () => {
  it('signs in with the right password (any email case), not the wrong one or an unknown email', async () => {
    expect((await call(loginRoute.POST, '/api/auth/login', { body: { email: 'olive@example.com', password: 'nope-nope' } })).status).toBe(401);
    const unknown = await call(loginRoute.POST, '/api/auth/login', { body: { email: 'nobody@example.com', password: 'whatever1' } });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe('Wrong email or password');
    const token = await signIn('  OLIVE@example.COM ', OWNER.password);
    const me = await call(meRoute.GET, '/api/auth/me', { session: token });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ user: { id: ownerId, role: 'owner' }, via: 'session' });
  });

  it('marks the cookie Secure behind https', async () => {
    const result = await call(loginRoute.POST, '/api/auth/login', { body: { email: OWNER.email, password: OWNER.password }, headers: { 'x-forwarded-proto': 'https' } });
    expect(sessionCookie(result.response)!.attributes).toContain('secure');
  });

  it('keeps only a hash of the session token, with an expiry', async () => {
    const token = await signIn(OWNER.email, OWNER.password);
    const rows = authDb().all<{ id: string; expires_at: string }>('SELECT id, expires_at FROM sessions');
    expect(rows.some((row) => row.id === tokenHash(token))).toBe(true);
    expect(rows.some((row) => JSON.stringify(row).includes(token))).toBe(false);
    const row = rows.find((r) => r.id === tokenHash(token))!;
    const hours = (Date.parse(row.expires_at) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(335);
    expect(hours).toBeLessThanOrEqual(336);
  });

  it('expires sessions', async () => {
    const user = auth.getUser(ownerId)!;
    const { token, expiresAt } = auth.createSession(user, 'password');
    expect(auth.sessionUser(token)?.user.id).toBe(ownerId);
    expect(auth.sessionUser(token, expiresAt.getTime() + 1)).toBeUndefined();
    expect(auth.sessionUser(token)).toBeUndefined();
    expect(auth.sessionUser('made-up-token')).toBeUndefined();
  });

  it('signs out: clears the cookie and ends the session', async () => {
    const token = await signIn(OWNER.email, OWNER.password);
    const out = await call(logoutRoute.POST, '/api/auth/logout', { method: 'POST', session: token });
    expect(out.status).toBe(200);
    const cleared = sessionCookie(out.response)!;
    expect(cleared.token).toBe('');
    expect(cleared.attributes).toContain('max-age=0');
    expect((await call(meRoute.GET, '/api/auth/me', { session: token })).status).toBe(401);
    expect((await call(meRoute.GET, '/api/auth/me', { session: ownerSession })).status).toBe(200);
  });

  it('changes your own name and password (the current password is checked)', async () => {
    const token = await signIn(OWNER.email, OWNER.password);
    expect((await call(meRoute.PATCH, '/api/auth/me', { method: 'PATCH', session: token, body: { currentPassword: 'wrong', newPassword: 'new-owner-password' } })).status).toBe(403);
    const changed = await call(meRoute.PATCH, '/api/auth/me', { method: 'PATCH', session: token, body: { name: 'Olive O.', currentPassword: OWNER.password, newPassword: 'new-owner-password' } });
    expect(changed.status).toBe(200);
    expect(changed.body.user.name).toBe('Olive O.');
    expect((await call(loginRoute.POST, '/api/auth/login', { body: { email: OWNER.email, password: OWNER.password } })).status).toBe(401);
    await signIn(OWNER.email, 'new-owner-password');
    await call(meRoute.PATCH, '/api/auth/me', { method: 'PATCH', session: token, body: { name: 'Olive Owner', currentPassword: 'new-owner-password', newPassword: OWNER.password } });
    // A password change ends the user's other sessions (session-hardening.test.ts), so the shared owner session needs a new one.
    expect((await call(meRoute.GET, '/api/auth/me', { session: ownerSession })).status).toBe(401);
    ownerSession = await signIn(OWNER.email, OWNER.password);
  });
});

describe('sign-in rate limits', () => {
  it('blocks an email after 10 failed attempts, even with the right password, and says when to retry', async () => {
    const email = 'limited@example.com';
    await auth.createUser({ email, name: 'Limited', role: 'member', password: 'limited-password' });
    for (let i = 0; i < 10; i++) {
      expect((await call(loginRoute.POST, '/api/auth/login', { body: { email, password: `wrong-${i}` }, ip: `192.0.2.${i}` })).status).toBe(401);
    }
    const blocked = await call(loginRoute.POST, '/api/auth/login', { body: { email, password: 'limited-password' }, ip: '192.0.2.200' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.retryAfter).toBeGreaterThan(0);
    // Other accounts are unaffected.
    await signIn(OWNER.email, OWNER.password);
  });

  it('blocks an address after 30 failed attempts across emails', async () => {
    const ip = '198.51.100.7';
    for (let i = 0; i < 30; i++) await call(loginRoute.POST, '/api/auth/login', { body: { email: `spray-${i}@example.com`, password: 'guess-guess' }, ip });
    expect((await call(loginRoute.POST, '/api/auth/login', { body: { email: OWNER.email, password: OWNER.password }, ip })).status).toBe(429);
  });

  it('a successful sign-in clears the email’s failures; the window slides', async () => {
    const limiter = new RateLimiter(2, 1000);
    limiter.hit('a', 0);
    limiter.hit('a', 100);
    expect(limiter.check('a', 200)).toEqual({ ok: false, retryAfter: 1 });
    expect(limiter.check('a', 1001).ok).toBe(true);
    limiter.hit('b', 0);
    limiter.hit('b', 0);
    limiter.reset('b');
    expect(limiter.check('b', 1).ok).toBe(true);
  });
});

describe('invites', () => {
  const sent: { to: string; subject: string; text: string; from: string }[] = [];
  afterEach(() => setMailTransport(undefined));

  it('without SMTP: returns a link to copy; the invitee picks a name and password and is signed in', async () => {
    const invited = await call(invitesRoute.POST, '/api/users/invites', { body: { email: 'Mia@Example.com', role: 'member' }, session: ownerSession });
    expect(invited.status).toBe(201);
    expect(invited.body).toMatchObject({ emailed: false, invite: { email: 'mia@example.com', role: 'member', invitedBy: 'Olive Owner' } });
    expect(invited.body.link).toMatch(/^http:\/\/localhost:3000\/invite\/[A-Za-z0-9_-]{30,}$/);
    const token = invited.body.link.split('/invite/')[1];

    const listed = await call(usersRoute.GET, '/api/users', { session: ownerSession });
    expect(listed.body.invites.map((i: { email: string }) => i.email)).toContain('mia@example.com');

    const info = await call(inviteTokenRoute.GET, `/api/auth/invites/${token}`, {}, { token });
    expect(info.body).toMatchObject({ email: 'mia@example.com', role: 'member', invitedBy: 'Olive Owner' });
    expect((await call(inviteTokenRoute.POST, `/api/auth/invites/${token}`, { body: { name: 'Mia', password: 'short' } }, { token })).status).toBe(400);
    const accepted = await call(inviteTokenRoute.POST, `/api/auth/invites/${token}`, { body: { name: 'Mia', password: 'mia-password' } }, { token });
    expect(accepted.status).toBe(201);
    expect(accepted.body.user).toMatchObject({ email: 'mia@example.com', role: 'member', name: 'Mia' });
    expect(sessionCookie(accepted.response)?.token).toBeTruthy();

    // Used once.
    expect((await call(inviteTokenRoute.GET, `/api/auth/invites/${token}`, {}, { token })).status).toBe(404);
    expect((await call(inviteTokenRoute.POST, `/api/auth/invites/${token}`, { body: { name: 'Again', password: 'again-password' } }, { token })).status).toBe(404);
    // An existing account can't be invited again.
    expect((await call(invitesRoute.POST, '/api/users/invites', { body: { email: 'mia@example.com' }, session: ownerSession })).status).toBe(409);
  });

  it('with email: sends the link (and LANDFLOW_PUBLIC_URL sets its origin)', async () => {
    setMailTransport({ send: async (message) => void sent.push(message) });
    process.env.LANDFLOW_PUBLIC_URL = 'https://flows.example.com/';
    try {
      const invited = await call(invitesRoute.POST, '/api/users/invites', { body: { email: 'noah@example.com', role: 'admin' }, session: ownerSession });
      expect(invited.status).toBe(201);
      expect(invited.body.emailed).toBe(true);
      expect(invited.body.link).toMatch(/^https:\/\/flows\.example\.com\/invite\//);
      const message = sent.at(-1)!;
      expect(message.to).toBe('noah@example.com');
      expect(message.subject).toMatch(/invited/i);
      expect(message.text).toContain(invited.body.link);
    } finally {
      delete process.env.LANDFLOW_PUBLIC_URL;
    }
  });

  it('reports a failed send and still returns the link', async () => {
    setMailTransport({ send: async () => Promise.reject(new Error('connection refused')) });
    const invited = await call(invitesRoute.POST, '/api/users/invites', { body: { email: 'olga@example.com' }, session: ownerSession });
    expect(invited.body).toMatchObject({ emailed: false, emailError: 'connection refused' });
    expect(invited.body.link).toContain('/invite/');
  });

  it('revokes an invite, and expired invites stop working', async () => {
    const invited = await call(invitesRoute.POST, '/api/users/invites', { body: { email: 'revoked@example.com' }, session: ownerSession });
    const token = invited.body.link.split('/invite/')[1];
    expect((await call(inviteIdRoute.DELETE, `/api/users/invites/${invited.body.invite.id}`, { method: 'DELETE', session: ownerSession }, { id: invited.body.invite.id })).status).toBe(200);
    expect((await call(inviteTokenRoute.GET, `/api/auth/invites/${token}`, {}, { token })).status).toBe(404);

    const { token: later } = auth.createInvite('later@example.com', 'member', ownerId);
    expect(auth.findToken('invite', later)).toBeDefined();
    expect(auth.findToken('invite', later, Date.now() + auth.INVITE_TTL_MS + 1000)).toBeUndefined();
  });
});

describe('password resets', () => {
  const sent: { to: string; text: string }[] = [];
  afterEach(() => setMailTransport(undefined));

  it('forgot password needs email; with it, sends a one-hour link and says the same for unknown emails', async () => {
    expect((await call(forgotRoute.POST, '/api/auth/password/forgot', { body: { email: 'mia@example.com' } })).status).toBe(503);
    setMailTransport({ send: async (message) => void sent.push(message) });
    const unknown = await call(forgotRoute.POST, '/api/auth/password/forgot', { body: { email: 'ghost@example.com' } });
    expect(unknown.status).toBe(200);
    expect(sent).toHaveLength(0);
    const known = await call(forgotRoute.POST, '/api/auth/password/forgot', { body: { email: 'MIA@example.com' } });
    expect(known.body.message).toBe(unknown.body.message);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('mia@example.com');
    const token = /\/reset-password\/([A-Za-z0-9_-]+)/.exec(sent[0].text)![1];
    expect(auth.findToken('reset', token, Date.now() + auth.RESET_TTL_MS + 1000)).toBeUndefined();

    const old = await signIn('mia@example.com', 'mia-password');
    expect((await call(resetRoute.GET, `/api/auth/password/reset?token=${token}`)).body).toMatchObject({ email: 'mia@example.com', name: 'Mia' });
    // Opened in a browser that is still signed in: a reset, not also a password change.
    const changes = queryEvents({ action: ['auth.password_change'] }).events.length;
    const reset = await call(resetRoute.POST, '/api/auth/password/reset', { body: { token, password: 'mia-new-password' }, session: old });
    expect(reset.status).toBe(200);
    expect(queryEvents({ action: ['auth.password_change'] }).events).toHaveLength(changes);
    expect(queryEvents({ action: ['auth.password_reset'] }, { limit: 1 }).events[0]).toMatchObject({ target: { type: 'user', name: 'mia@example.com' } });
    expect(sessionCookie(reset.response)?.token).toBeTruthy();
    // Other sessions end; the old password stops working; the link works once.
    expect((await call(meRoute.GET, '/api/auth/me', { session: old })).status).toBe(401);
    expect((await call(loginRoute.POST, '/api/auth/login', { body: { email: 'mia@example.com', password: 'mia-password' } })).status).toBe(401);
    await signIn('mia@example.com', 'mia-new-password');
    expect((await call(resetRoute.POST, '/api/auth/password/reset', { body: { token, password: 'third-password' } })).status).toBe(404);
  });

  it('production without LANDFLOW_PUBLIC_URL: the same 503 for known and unknown emails, and no token or invite made', async () => {
    setMailTransport({ send: async (message) => void sent.push(message) });
    const sentBefore = sent.length;
    const invitesBefore = auth.listInvites().length;
    process.env.LANDFLOW_PROFILE = 'production';
    try {
      const known = await call(forgotRoute.POST, '/api/auth/password/forgot', { body: { email: 'mia@example.com' } });
      const unknown = await call(forgotRoute.POST, '/api/auth/password/forgot', { body: { email: 'ghost@example.com' } });
      expect(known.status).toBe(503);
      expect(unknown.status).toBe(503);
      expect(known.body).toEqual(unknown.body);
      const invited = await call(invitesRoute.POST, '/api/users/invites', { body: { email: 'nobody-yet@example.com' }, session: ownerSession });
      expect(invited.status).toBe(503);
      expect(invited.body.error).toContain('LANDFLOW_PUBLIC_URL');
    } finally {
      delete process.env.LANDFLOW_PROFILE;
    }
    expect(sent).toHaveLength(sentBefore);
    expect(auth.listInvites()).toHaveLength(invitesBefore);
  });

  it('admins make reset links for others (a link to copy without SMTP)', async () => {
    const mia = auth.findUserByEmail('mia@example.com')!;
    const made = await call(userResetRoute.POST, `/api/users/${mia.id}/password-reset`, { method: 'POST', session: ownerSession }, { id: mia.id });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ emailed: false });
    expect(made.body.link).toContain('/reset-password/');
    // Nobody resets the owner's password this way.
    expect((await call(userResetRoute.POST, `/api/users/${ownerId}/password-reset`, { method: 'POST', session: ownerSession }, { id: ownerId })).status).toBe(403);
  });
});

describe('roles', () => {
  it('can(): owners and admins manage; members build and run', () => {
    const owner = { role: 'owner' as const };
    const admin = { role: 'admin' as const };
    const member = { role: 'member' as const };
    for (const action of ['users:manage', 'settings:manage', 'credentials:share', 'mcp:manage', 'plugins:manage', 'variables:manage', 'workflows:takeover', 'apiKeys:admin'] as const) {
      expect(can(owner, action)).toBe(true);
      expect(can(admin, action)).toBe(true);
      expect(can(member, action)).toBe(false);
    }
    expect(can(null, 'users:manage')).toBe(false);
  });

  it('canManageUser(): nobody touches the owner or makes another; only the owner manages admins; not yourself', () => {
    const owner = { id: 'o', role: 'owner' as const };
    const admin = { id: 'a', role: 'admin' as const };
    const admin2 = { id: 'a2', role: 'admin' as const };
    const member = { id: 'm', role: 'member' as const };
    expect(canManageUser(owner, member, { kind: 'role', role: 'admin' })).toBe(true);
    expect(canManageUser(owner, admin, { kind: 'remove' })).toBe(true);
    expect(canManageUser(owner, member, { kind: 'role', role: 'owner' })).toBe(false);
    expect(canManageUser(admin, owner, { kind: 'remove' })).toBe(false);
    expect(canManageUser(admin, member, { kind: 'remove' })).toBe(true);
    expect(canManageUser(admin, member, { kind: 'role', role: 'admin' })).toBe(false);
    expect(canManageUser(admin, admin2, { kind: 'role', role: 'member' })).toBe(false);
    expect(canManageUser(admin, admin, { kind: 'remove' })).toBe(false);
    expect(canManageUser(member, member, { kind: 'remove' })).toBe(false);
  });

  it('json-render is the owner’s to switch: members are refused, admins can change other settings but not it', async () => {
    const settingsRoute = await import('@/app/api/settings/route');
    const member = await addUser('jr-max@example.com', 'member', 'JrMax');
    const admin = await addUser('jr-ada@example.com', 'admin', 'JrAda');
    const patch = (session: string, body: unknown) => call(settingsRoute.PATCH, '/api/settings', { method: 'PATCH', body, session });
    expect((await call(settingsRoute.GET, '/api/settings', { session: member.session })).body.jsonRender).toBe(false);
    expect((await patch(member.session, { jsonRender: true })).status).toBe(403);
    expect((await patch(admin.session, { jsonRender: true })).status).toBe(403);
    expect((await patch(admin.session, { timezone: 'UTC' })).status).toBe(200);
    expect((await patch(ownerSession, { jsonRender: true })).body.jsonRender).toBe(true);
    expect((await call(settingsRoute.GET, '/api/settings', { session: member.session })).body.jsonRender).toBe(true);
    expect((await patch(ownerSession, { jsonRender: null })).body.jsonRender).toBe(false);
  });

  it('members can’t manage users, settings or variables; admins can’t invite admins; the owner can', async () => {
    const member = await addUser('max@example.com', 'member', 'Max');
    const admin = await addUser('ada@example.com', 'admin', 'Ada');

    expect((await call(invitesRoute.POST, '/api/users/invites', { body: { email: 'x@example.com' }, session: member.session })).status).toBe(403);
    expect((await call(securityRoute.GET, '/api/settings/security', { session: member.session })).status).toBe(403);
    const variables = await import('@/app/api/variables/route');
    expect((await call(variables.POST, '/api/variables', { body: { key: 'K', value: 'v' }, session: member.session })).status).toBe(403);
    // Members still see who is on the instance, but not invites.
    const listed = await call(usersRoute.GET, '/api/users', { session: member.session });
    expect(listed.status).toBe(200);
    expect(listed.body.invites).toBeUndefined();

    expect((await call(invitesRoute.POST, '/api/users/invites', { body: { email: 'boss@example.com', role: 'admin' }, session: admin.session })).status).toBe(403);
    expect((await call(invitesRoute.POST, '/api/users/invites', { body: { email: 'helper@example.com', role: 'member' }, session: admin.session })).status).toBe(201);
    expect((await call(securityRoute.GET, '/api/settings/security', { session: admin.session })).status).toBe(200);

    // Admins can't change the owner or promote to admin; the owner can.
    expect((await call(userRoute.PATCH, `/api/users/${ownerId}`, { method: 'PATCH', body: { role: 'member' }, session: admin.session }, { id: ownerId })).status).toBe(403);
    expect((await call(userRoute.PATCH, `/api/users/${member.id}`, { method: 'PATCH', body: { role: 'admin' }, session: admin.session }, { id: member.id })).status).toBe(403);
    const promoted = await call(userRoute.PATCH, `/api/users/${member.id}`, { method: 'PATCH', body: { role: 'admin' }, session: ownerSession }, { id: member.id });
    expect(promoted.body.user.role).toBe('admin');
    // The session follows the role straight away.
    expect((await call(securityRoute.GET, '/api/settings/security', { session: member.session })).status).toBe(200);
    await call(userRoute.PATCH, `/api/users/${member.id}`, { method: 'PATCH', body: { role: 'member' }, session: ownerSession }, { id: member.id });
    expect((await call(userRoute.PATCH, `/api/users/${member.id}`, { method: 'PATCH', body: { role: 'owner' }, session: ownerSession }, { id: member.id })).status).toBe(400);
  });

  it('removing a user ends their sessions and deletes their API keys', async () => {
    const temp = await addUser('temp@example.com', 'member', 'Temp');
    const key = await call(apiKeysRoute.POST, '/api/api-keys', { body: { label: 'temp', scopes: ['workflows:read'] }, session: temp.session });
    expect((await call(workflowsRoute.GET, '/api/workflows', { bearer: key.body.token })).status).toBe(200);
    expect((await call(userRoute.DELETE, `/api/users/${temp.id}`, { method: 'DELETE', session: temp.session }, { id: temp.id })).status).toBe(403);
    expect((await call(userRoute.DELETE, `/api/users/${temp.id}`, { method: 'DELETE', session: ownerSession }, { id: temp.id })).status).toBe(200);
    expect((await call(meRoute.GET, '/api/auth/me', { session: temp.session })).status).toBe(401);
    expect((await call(workflowsRoute.GET, '/api/workflows', { bearer: key.body.token })).status).toBe(401);
    expect((await call(userRoute.DELETE, `/api/users/${ownerId}`, { method: 'DELETE', session: ownerSession }, { id: ownerId })).status).toBe(403);
  });
});

describe('API keys', () => {
  let member: { id: string; session: string };
  beforeAll(async () => {
    member = { id: auth.findUserByEmail('max@example.com')!.id, session: await signIn('max@example.com', 'Max-password') };
  });

  it('creates a key shown once (stored hashed), lists it without the secret, and revokes it', async () => {
    const created = await call(apiKeysRoute.POST, '/api/api-keys', { body: { label: 'CI', scopes: ['workflows:read'], expiresInDays: 30 }, session: member.session });
    expect(created.status).toBe(201);
    const token = created.body.token as string;
    expect(token).toMatch(/^lf_[A-Za-z0-9_-]{30,}$/);
    expect(token.startsWith('lf_mcp_')).toBe(false);
    expect(created.body.key).toMatchObject({ label: 'CI', scopes: ['workflows:read'], hint: token.slice(-4) });
    expect(Date.parse(created.body.key.expiresAt) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    const rows = authDb().all<Record<string, unknown>>('SELECT * FROM api_keys');
    expect(rows.some((row) => JSON.stringify(row).includes(token))).toBe(false);

    const listed = await call(apiKeysRoute.GET, '/api/api-keys', { session: member.session });
    expect(JSON.stringify(listed.body)).not.toContain(token);
    expect(listed.body.keys.map((k: { label: string }) => k.label)).toContain('CI');

    expect((await call(workflowsRoute.GET, '/api/workflows', { bearer: token })).status).toBe(200);
    const id = created.body.key.id;
    expect((await call(apiKeyRoute.DELETE, `/api/api-keys/${id}`, { method: 'DELETE', session: member.session }, { id })).status).toBe(200);
    expect((await call(workflowsRoute.GET, '/api/workflows', { bearer: token })).status).toBe(401);
  });

  it('enforces scopes, with Authorization: Bearer or X-Landflow-API-Key', async () => {
    const read = (await call(apiKeysRoute.POST, '/api/api-keys', { body: { label: 'read', scopes: ['workflows:read'] }, session: member.session })).body.token;
    const write = (await call(apiKeysRoute.POST, '/api/api-keys', { body: { label: 'write', scopes: ['workflows:write'] }, session: member.session })).body.token;
    const runOnly = (await call(apiKeysRoute.POST, '/api/api-keys', { body: { label: 'run', scopes: ['run'] }, session: member.session })).body.token;
    const workflow = { name: 'Keyed', nodes: [], connections: [] };

    expect((await call(workflowsRoute.GET, '/api/workflows', { key: read })).status).toBe(200);
    const denied = await call(workflowsRoute.POST, '/api/workflows', { body: workflow, bearer: read });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ scope: 'workflows:write' });
    expect((await call(workflowsRoute.POST, '/api/workflows', { body: workflow, bearer: write })).status).toBe(201);
    expect((await call(workflowsRoute.GET, '/api/workflows', { bearer: runOnly })).status).toBe(403);
    // `admin` includes every scope; the key acts as its user (who is signed in, through the key).
    const me = await call(meRoute.GET, '/api/auth/me', { bearer: read });
    expect(me.body).toMatchObject({ user: { id: member.id }, via: 'api-key', apiKey: { scopes: ['workflows:read'] } });
    expect(hasScope(['admin'], 'executions:write')).toBe(true);
  });

  it('API keys can’t manage API keys; members can’t make admin keys; an admin key is still limited by its user’s role', async () => {
    const key = (await call(apiKeysRoute.POST, '/api/api-keys', { body: { label: 'k', scopes: ['workflows:read'] }, session: member.session })).body.token;
    expect((await call(apiKeysRoute.GET, '/api/api-keys', { bearer: key })).status).toBe(403);
    expect((await call(apiKeysRoute.POST, '/api/api-keys', { body: { label: 'x', scopes: ['admin'] }, session: member.session })).status).toBe(403);

    const ownerAdminKey = (await call(apiKeysRoute.POST, '/api/api-keys', { body: { label: 'owner admin', scopes: ['admin'] }, session: ownerSession })).body.token;
    expect((await call(securityRoute.GET, '/api/settings/security', { bearer: ownerAdminKey })).status).toBe(200);
    expect((await call(usersRoute.GET, '/api/users', { bearer: ownerAdminKey })).body.invites).toBeDefined();
  });

  it('expired, unknown and malformed keys get 401 (no fallback to the cookie); the MCP token isn’t an API key', async () => {
    const user = auth.getUser(member.id)!;
    const { token } = auth.createApiKey(user, { label: 'old', scopes: ['workflows:read'], expiresAt: new Date(Date.now() - 1000).toISOString() });
    const expired = await call(workflowsRoute.GET, '/api/workflows', { bearer: token });
    expect(expired.status).toBe(401);
    expect(expired.body.error).toMatch(/expired/);
    expect((await call(workflowsRoute.GET, '/api/workflows', { bearer: 'lf_not-a-real-key' })).status).toBe(401);
    expect((await call(workflowsRoute.GET, '/api/workflows', { key: 'lf_not-a-real-key', session: member.session })).status).toBe(401);
    // A Bearer token that isn't `lf_…` (or is the MCP token) isn't read as a key: no credentials → 401.
    expect((await call(workflowsRoute.GET, '/api/workflows', { bearer: 'lf_mcp_abc' })).status).toBe(401);
    expect((await call(workflowsRoute.GET, '/api/workflows', { bearer: 'lf_mcp_abc', session: member.session })).status).toBe(200);
  });
});

describe('route guard and public allow-list', () => {
  const PUBLIC = [
    '/api/health',
    '/api/auth/status',
    '/api/auth/login',
    '/api/auth/setup',
    '/api/auth/logout',
    '/api/auth/invites/abc',
    '/api/auth/password/forgot',
    '/api/auth/oidc/login',
    '/api/auth/oidc/callback',
    '/api/webhook/abc/hook',
    '/form/abc',
    '/api/waiting/ex_1',
    '/mcp/some-path',
    '/api/mcp',
    '/api/oauth2/callback',
    '/api/plugins/announce',
    '/login',
    '/setup',
    '/invite/abc',
    '/forgot-password',
    '/reset-password/abc',
    '/chat/abc',
    '/_next/static/chunk.js',
    '/favicon.ico',
    '/logo.svg',
  ];
  const PRIVATE = [
    '/',
    '/workflows',
    '/settings',
    '/api/workflows',
    '/api/workflows/wf_1',
    '/api/executions',
    '/api/events',
    '/api/credentials',
    '/api/variables',
    '/api/users',
    '/api/api-keys',
    '/api/auth/me',
    '/api/settings',
    '/api/plugins',
    '/api/plugins/x/enable',
    '/api/metrics',
    '/api/binary/abc',
    '/api/openapi.json',
    '/api/mcpx',
    '/api/healthz',
    '/formx',
    '/api/oauth2/start',
    '/api/workflows/a.js',
  ];

  it('isPublicPath: public paths stay public, everything else needs credentials', () => {
    for (const path of PUBLIC) expect(isPublicPath(path), path).toBe(true);
    for (const path of PRIVATE) expect(isPublicPath(path), path).toBe(false);
    // Plugins fetch files with their per-call token; an API key there is checked like anywhere else.
    expect(isPublicPath('/api/binary/abc', { bearer: 'plugin-call-token' })).toBe(true);
    expect(isPublicPath('/api/binary/abc', { bearer: 'lf_key' })).toBe(false);
    expect(isPublicPath('/api/metrics', { metricsPublic: true })).toBe(true);
  });

  it('the guard lets public routes through and answers 401 for the rest', () => {
    for (const path of PUBLIC.filter((p) => p.startsWith('/api/'))) expect(guardRequest(new Request(`${BASE}${path}`)).ok, path).toBe(true);
    for (const path of PRIVATE) {
      const result = guardRequest(new Request(`${BASE}${path}`, { method: 'POST' }));
      expect(result.ok, path).toBe(false);
      if (!result.ok) expect(result.response.status, path).toBe(401);
    }
  });

  it('real routes: health is public; workflows need a session or key', async () => {
    expect((await call(healthRoute.GET, '/api/health')).status).toBe(200);
    expect((await call(workflowsRoute.GET, '/api/workflows')).status).toBe(401);
    expect((await call(workflowsRoute.GET, '/api/workflows', { session: 'forged' })).status).toBe(401);
    expect((await call(workflowsRoute.GET, '/api/workflows', { session: ownerSession })).status).toBe(200);
  });

  it('refuses cookie-authenticated changes from another site', async () => {
    const workflow = { name: 'Cross', nodes: [], connections: [] };
    expect((await call(workflowsRoute.POST, '/api/workflows', { body: workflow, session: ownerSession, headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await call(workflowsRoute.POST, '/api/workflows', { body: workflow, session: ownerSession, headers: { origin: BASE } })).status).toBe(201);
  });

  it('metrics: needs credentials unless LANDFLOW_METRICS_PUBLIC=true', () => {
    expect(guardRequest(new Request(`${BASE}/api/metrics`)).ok).toBe(false);
    process.env.LANDFLOW_METRICS_PUBLIC = 'true';
    try {
      expect(guardRequest(new Request(`${BASE}/api/metrics`)).ok).toBe(true);
    } finally {
      delete process.env.LANDFLOW_METRICS_PUBLIC;
    }
  });

  it('plugin announce: open, or with LANDFLOW_REGISTRY_SECRET set, only with the secret', () => {
    const announce = (headers: Record<string, string> = {}) => guardRequest(new Request(`${BASE}/api/plugins/announce`, { method: 'POST', headers })).ok;
    expect(announce()).toBe(true);
    process.env.LANDFLOW_REGISTRY_SECRET = 'registry-s3cret';
    try {
      expect(announce()).toBe(false);
      expect(announce({ 'x-landflow-registry-secret': 'wrong' })).toBe(false);
      expect(announce({ 'x-landflow-registry-secret': 'registry-s3cret' })).toBe(true);
      expect(announce({ authorization: 'Bearer registry-s3cret' })).toBe(true);
    } finally {
      delete process.env.LANDFLOW_REGISTRY_SECRET;
    }
  });

  it('the proxy: pages redirect to sign-in with ?next, API routes get 401, public paths and credentials pass', () => {
    const run = (path: string, headers: Record<string, string> = {}) => proxy(new NextRequest(`${BASE}${path}`, { headers }));
    const page = run('/workflows/wf_1?tab=x');
    expect(page.status).toBe(307);
    expect(page.headers.get('location')).toBe(`${BASE}/login?next=${encodeURIComponent('/workflows/wf_1?tab=x')}`);
    expect(run('/').headers.get('location')).toBe(`${BASE}/login`);
    expect(run('/api/workflows').status).toBe(401);
    for (const path of ['/login', '/api/health', '/api/webhook/x', '/chat/x', '/form/x']) expect(run(path).headers.get('x-middleware-next'), path).toBe('1');
    // Pages get the requested path; API routes don't (it would land in webhook items' headers).
    expect(run('/form/x?a=1').headers.get('x-middleware-request-x-landflow-path')).toBe('/form/x?a=1');
    expect(run('/api/webhook/x', { 'x-landflow-path': '/spoofed' }).headers.get('x-middleware-request-x-landflow-path')).toBeNull();
    expect(run('/workflows', { cookie: 'landflow_session=abc' }).headers.get('x-middleware-next')).toBe('1');
    expect(run('/api/workflows', { authorization: 'Bearer lf_abc' }).headers.get('x-middleware-next')).toBe('1');
    expect(run('/api/workflows', { 'x-landflow-api-key': 'lf_abc' }).headers.get('x-middleware-next')).toBe('1');
  });

  it('safeNext keeps sign-in redirects on this site', () => {
    expect(safeNext('/workflows/wf_1?x=1')).toBe('/workflows/wf_1?x=1');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('/login')).toBe('/');
    expect(safeNext(null)).toBe('/');
  });
});

describe('who created and changed a workflow', () => {
  it('records createdBy and updatedBy from the session (and API keys)', async () => {
    const created = await call(workflowsRoute.POST, '/api/workflows', { body: { name: 'Owned', nodes: [], connections: [] }, session: ownerSession });
    expect(created.body.workflow).toMatchObject({ createdBy: ownerId, updatedBy: ownerId });
    const id = created.body.workflow.id;
    const max = auth.findUserByEmail('max@example.com')!;
    // Projects: the owner's workflow is in their personal project; Max edits it once it is shared with him.
    const projects = await import('@/lib/server/projects');
    projects.addShare('workflow', id, projects.ensurePersonalProject(max.id)!, 'editor');
    const key = (await call(apiKeysRoute.POST, '/api/api-keys', { body: { label: 'w', scopes: ['workflows:write'] }, session: await signIn('max@example.com', 'Max-password') })).body.token;
    const updated = await call(workflowRoute.PUT, `/api/workflows/${id}`, { method: 'PUT', body: { name: 'Owned (edited)', nodes: [], connections: [], createdBy: 'usr_forged' }, bearer: key }, { id });
    expect(updated.status).toBe(200);
    expect(updated.body.workflow).toMatchObject({ createdBy: ownerId, updatedBy: max.id });
  });
});

describe('plugin registry secret over gRPC', () => {
  it('refuses registry calls without LANDFLOW_REGISTRY_SECRET once it is set', async () => {
    const { createServer } = await import('node:net');
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port: free } = probe.address() as { port: number };
        probe.close(() => resolve(free));
      });
    });
    const { startRegistryGrpcServer } = await import('@/lib/server/plugins/registry-grpc');
    const { grpc, loadLandflowProto, unary } = await import('@landflow/protocol/grpc');
    process.env.LANDFLOW_REGISTRY_GRPC_PORT = String(port);
    process.env.LANDFLOW_REGISTRY_SECRET = 'grpc-s3cret';
    const server = await startRegistryGrpcServer();
    const client = new (loadLandflowProto().RegistryService)(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
    try {
      const withdraw = (metadata?: Record<string, string>) => unary<object, { ok: boolean }>(client, 'Withdraw', { endpoint: 'http://127.0.0.1:1', pluginId: 'x' }, 3000, metadata);
      await expect(withdraw()).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
      await expect(withdraw({ 'x-landflow-registry-secret': 'wrong' })).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
      expect(await withdraw({ 'x-landflow-registry-secret': 'grpc-s3cret' })).toMatchObject({ ok: false });
    } finally {
      client.close();
      server?.forceShutdown();
      process.env.LANDFLOW_REGISTRY_GRPC_PORT = 'off';
      delete process.env.LANDFLOW_REGISTRY_SECRET;
    }
  });
});
