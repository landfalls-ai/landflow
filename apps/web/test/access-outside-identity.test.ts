/**
 * C36-A: signing in without a Landflow account (docs/access-requests.md#signing-in-without-an-account): the email link (single use,
 * 15 minutes, hashed, enumeration-safe, every limit), the requester session (cookie flags, idle and absolute expiry, re-checks), the
 * CSRF rules of public writes, that the session opens nothing of Landflow's, and the admin settings and Block.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });
const ENV = {
  LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-outside-identity-')),
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_PUBLIC_URL: 'http://landflow.test',
  LANDFLOW_TRUSTED_PROXIES: '1',
};
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const auth = await import('@/lib/server/auth');
const { createSession } = await import('@/lib/server/auth/sessions');
const { database } = await import('@/lib/server/db');
const { setMailTransport } = await import('@/lib/server/auth/mail');
const { guardRequest } = await import('@/lib/server/auth/guard');
const { queryEvents } = await import('@/lib/server/audit/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const settings = await import('@/lib/server/access/outside/settings');
const identity = await import('@/lib/server/access/outside/identity');
const sessions = await import('@/lib/server/access/outside/sessions');
const limits = await import('@/lib/server/access/outside/limits');
const store = await import('@/lib/server/access/outside/store');
const { routePolicy } = await import('@/lib/server/auth/policy');
const configRoute = await import('@/app/request-access/api/config/route');
const emailRoute = await import('@/app/request-access/api/sign-in/email/route');
const verifyRoute = await import('@/app/request-access/api/sign-in/verify/route');
const signOutRoute = await import('@/app/request-access/api/sign-out/route');
const sessionRoute = await import('@/app/request-access/api/session/route');
const googleRoute = await import('@/app/request-access/api/sign-in/google/route');
const adminSettingsRoute = await import('@/app/api/access/outside/route');
const adminRequestersRoute = await import('@/app/api/access/outside/requesters/route');
const blockRoute = await import('@/app/api/access/outside/requesters/[id]/block/route');
const unblockRoute = await import('@/app/api/access/outside/requesters/[id]/unblock/route');
const accessRequestsRoute = await import('@/app/api/access/requests/route');
const meRoute = await import('@/app/api/auth/me/route');

registry.registerBuiltin(corePlugin);
const owner = await auth.createOwner({ email: 'owner@landflow.test', name: 'Olive Owner', password: 'password-123' });
const admin = await auth.createUser({ email: 'admin@landflow.test', name: 'Ada Admin', role: 'admin' });
const member = await auth.createUser({ email: 'mia@landflow.test', name: 'Mia Member', role: 'member' });
const partnerUser = await auth.createUser({ email: 'gus@partner.test', name: 'Gus Partner', role: 'member' });

const BASE = 'http://landflow.test';
const mails: Array<{ to: string; subject: string; text: string }> = [];
const captureMail = () => setMailTransport({ async send(message) { mails.push({ to: message.to, subject: message.subject, text: message.text }); } });
let ipSeq = 0;
const nextIp = () => `10.20.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

type Handler = (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>;
const send = (route: Handler, path: string, options: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string>; ip?: string; params?: Record<string, string> } = {}) =>
  route(
    new Request(`${BASE}${path}`, {
      method: options.method ?? 'POST',
      headers: { origin: BASE, 'content-type': 'application/json', 'x-forwarded-for': options.ip ?? nextIp(), ...(options.cookie && { cookie: options.cookie }), ...options.headers },
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
    }),
    { params: Promise.resolve(options.params ?? {}) },
  );
const jsonOf = async (response: Response) => {
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
};
const setCookie = (response: Response, name: string) => response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
const cookieValue = (response: Response, name: string) => setCookie(response, name)?.split(';')[0].slice(name.length + 1);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const audited = (action: string) => queryEvents({ action: [action] }, { limit: 200 }).events;
const tokenOf = (mail: { text: string }) => /#t=([A-Za-z0-9_-]+)/.exec(mail.text)?.[1] ?? '';
const configure = (patch: Parameters<typeof settings.saveOutsideSettings>[1]) => settings.saveOutsideSettings(owner, patch);

/** Ask for a link (the route) and wait for its mail. */
const askLink = async (email: string, ip?: string) => {
  const response = await send(emailRoute.POST as Handler, '/request-access/api/sign-in/email', { body: { email }, ip });
  await identity.mailSettled();
  return response;
};
/** Sign a person in the whole way: ask, take the mailed token, verify. Returns the cookie header. */
const signIn = async (email: string, ip?: string) => {
  // Signing in many times in one test would hit the per-address limit; that limit has its own test.
  limits.resetOutsideLimits();
  const before = mails.length;
  await askLink(email, ip);
  const mail = mails.slice(before).find((m) => m.to === email);
  expect(mail, `a link mail for ${email}`).toBeDefined();
  const response = await send(verifyRoute.POST as Handler, '/request-access/api/sign-in/verify', { body: { token: tokenOf(mail!) } });
  expect(response.status).toBe(200);
  return { cookie: `landflow_requester=${cookieValue(response, 'landflow_requester')}`, response };
};

beforeAll(() => {
  auth.disableTestAuth();
  captureMail();
});
afterAll(() => {
  auth.enableTestAuth();
  setMailTransport(undefined);
});
beforeEach(() => {
  mails.length = 0;
  limits.resetOutsideLimits();
  database().all<{ id: string }>('SELECT id FROM access_outside_sessions').forEach((s) => database().delete('access_outside_sessions', { id: s.id }));
  database().all<{ id: string }>('SELECT id FROM access_outside_links').forEach((l) => database().delete('access_outside_links', { id: l.id }));
  database().all<{ id: string }>('SELECT id FROM access_outside_requesters').forEach((r) => database().delete('access_outside_requesters', { id: r.id }));
  database().upsert('settings', { key: settings.OUTSIDE_SETTINGS_KEY, value: JSON.stringify({ enabled: true, domains: ['partner.test'], google: { enabled: false } }) });
});

describe('the feature switch', () => {
  it('is off by default: every route but config answers 404, and config says nothing else', async () => {
    database().delete('settings', { key: settings.OUTSIDE_SETTINGS_KEY });
    expect(settings.outsideSettings()).toEqual({ enabled: false, domains: [], google: { enabled: false } });
    const config = await send(configRoute.GET as Handler, '/request-access/api/config', { method: 'GET' });
    expect(config.status).toBe(200);
    expect(await jsonOf(config)).toEqual({ enabled: false, google: false, email: false });
    for (const [route, path, method] of [
      [emailRoute.POST, '/request-access/api/sign-in/email', 'POST'],
      [verifyRoute.POST, '/request-access/api/sign-in/verify', 'POST'],
      [signOutRoute.POST, '/request-access/api/sign-out', 'POST'],
      [sessionRoute.GET, '/request-access/api/session', 'GET'],
      [googleRoute.GET, '/request-access/api/sign-in/google', 'GET'],
    ] as Array<[Handler, string, string]>) {
      const response = await send(route, path, { method, body: method === 'POST' ? { email: 'a@partner.test', token: 'x' } : undefined });
      expect(response.status, path).toBe(404);
    }
    expect(mails).toHaveLength(0);
  });

  it('says exactly enabled, google and email when on (never a domain)', async () => {
    const body = await jsonOf(await send(configRoute.GET as Handler, '/request-access/api/config', { method: 'GET' }));
    expect(Object.keys(body).sort()).toEqual(['email', 'enabled', 'google']);
    expect(body).toEqual({ enabled: true, google: false, email: true });
    setMailTransport(undefined);
    expect((await jsonOf(await send(configRoute.GET as Handler, '/request-access/api/config', { method: 'GET' }))).email).toBe(false);
    captureMail();
  });
});

describe('the email link', () => {
  it('mails an allowed address one link with the token in the fragment, and keeps only its SHA-256 for 15 minutes', async () => {
    const response = await askLink('erin@partner.test');
    expect(response.status).toBe(202);
    expect(await jsonOf(response)).toEqual({ ok: true, message: identity.SIGN_IN_ASKED });
    expect(mails).toHaveLength(1);
    const mail = mails[0];
    expect(mail.to).toBe('erin@partner.test');
    const token = tokenOf(mail);
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(mail.text).toContain(`${BASE}/request-access#t=${token}`);
    expect(mail.text).not.toMatch(/\?[^\s]*t=/);
    const rows = database().all<{ token_hash: string; created_at: string; expires_at: string; used_at: string | null }>('SELECT * FROM access_outside_links');
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(sha(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(Date.parse(rows[0].expires_at) - Date.parse(rows[0].created_at)).toBe(15 * 60_000);
    expect(audited('access.outside.link').some((e) => e.outcome === 'success' && e.details?.email === 'erin@partner.test')).toBe(true);
  });

  it('replaces an older link of the same address: only the newest verifies', async () => {
    await askLink('erin@partner.test');
    await askLink('erin@partner.test');
    expect(mails).toHaveLength(2);
    expect(database().all('SELECT id FROM access_outside_links')).toHaveLength(1);
    const first = await send(verifyRoute.POST as Handler, '/request-access/api/sign-in/verify', { body: { token: tokenOf(mails[0]) } });
    expect(first.status).toBe(400);
    const second = await send(verifyRoute.POST as Handler, '/request-access/api/sign-in/verify', { body: { token: tokenOf(mails[1]) } });
    expect(second.status).toBe(200);
  });

  it('answers every ask the same, whatever the address and whatever the limits', async () => {
    await configure({ enabled: true, domains: ['partner.test'] });
    const blocked = (await signIn('blocked@partner.test')).response;
    expect(blocked.status).toBe(200);
    await blockRequesterByEmail('blocked@partner.test');
    mails.length = 0;
    const answers = [];
    for (const email of ['erin@partner.test', 'mallory@other.test', 'erin+x@partner.test', 'blocked@partner.test', 'gus@partner.test', 'nobody@gmail.com']) {
      const response = await askLink(email);
      answers.push({ email, status: response.status, body: await jsonOf(response) });
    }
    for (const answer of answers) expect({ status: answer.status, body: answer.body }, answer.email).toEqual({ status: 202, body: { ok: true, message: identity.SIGN_IN_ASKED } });
    // Only the allowed address got a link; the Landflow user got a pointer to Landflow's own page, with no token.
    expect(mails.map((m) => m.to).sort()).toEqual(['erin@partner.test', 'gus@partner.test']);
    const pointer = mails.find((m) => m.to === 'gus@partner.test')!;
    expect(pointer.text).toContain(`${BASE}/access`);
    expect(pointer.text).not.toContain('#t=');
    expect(database().all('SELECT id FROM access_outside_links WHERE used_at IS NULL')).toHaveLength(1);
    // Each refusal is audited with its reason.
    const reasons = audited('access.outside.link').filter((e) => e.outcome === 'denied').map((e) => e.details?.reason);
    expect(reasons).toEqual(expect.arrayContaining(['domain', 'subaddress', 'blocked', 'landflow_user']));
    expect(reasons.filter((r) => r === 'domain')).toHaveLength(2);
  });

  it('refuses a domain no one listed and a free mail provider, a + address and an address of another subdomain', async () => {
    for (const email of ['x@other.test', 'x@gmail.com', 'x+tag@partner.test', 'x@mail.partner.test', 'x@PARTNER.test.evil.com']) {
      expect((await askLink(email)).status).toBe(202);
    }
    expect(mails).toHaveLength(0);
    // A different spelling of an allowed domain still works.
    await askLink('Erin@PARTNER.test');
    expect(mails.map((m) => m.to)).toEqual(['erin@partner.test']);
  });

  it('sends nothing, and answers the same, without a mail server or a public origin', async () => {
    setMailTransport(undefined);
    const response = await askLink('erin@partner.test');
    expect(response.status).toBe(202);
    expect(database().all('SELECT id FROM access_outside_links')).toHaveLength(0);
    captureMail();
    const result = await identity.requestLink('erin@partner.test', { ip: nextIp() });
    expect(result).toMatchObject({ limited: false, denial: 'mail' });
    expect(mails).toHaveLength(0);
  });

  it('limits one address to 3 links in 15 minutes and 10 a day, and one domain to 200 an hour, answering the same', async () => {
    const t0 = Date.parse('2030-05-01T09:00:00Z');
    const ask = (at: number, email = 'erin@partner.test') => identity.requestLink(email, { ip: nextIp(), origin: BASE, now: at });
    const denialOf = async (at: number, email?: string) => {
      const result = await ask(at, email);
      expect(result.limited).toBe(false);
      return 'denial' in result ? result.denial : undefined;
    };
    for (let i = 0; i < 3; i++) expect(await denialOf(t0 + i * 1000)).toBeUndefined();
    expect(await denialOf(t0 + 5000)).toBe('limit');
    await identity.mailSettled();
    expect(mails).toHaveLength(3);
    // The window slides: 16 minutes later three more are allowed, up to 10 in the day.
    let sent = 3;
    for (let round = 1; round <= 3 && sent < 10; round++) {
      for (let i = 0; i < 3 && sent < 10; i++, sent++) expect(await denialOf(t0 + round * 16 * 60_000 + i * 1000), `link ${sent + 1}`).toBeUndefined();
    }
    expect(sent).toBe(10);
    expect(await denialOf(t0 + 4 * 16 * 60_000)).toBe('limit');
    // A day after the first, the address may ask again.
    expect(await denialOf(t0 + 24 * 3_600_000 + 60_000)).toBeUndefined();
    // The domain: 200 an hour; past it no one at the domain gets a link, and the audit row is written once.
    limits.resetOutsideLimits();
    mails.length = 0;
    const t1 = Date.parse('2030-06-01T09:00:00Z');
    for (let i = 0; i < 200; i++) await limits.outsideLimiters().domain.hit('partner.test', t1 + i);
    const before = audited('access.outside.link').filter((e) => e.details?.scope === 'domain').length;
    expect(await denialOf(t1 + 1000, 'a@partner.test')).toBe('limit');
    expect(await denialOf(t1 + 2000, 'b@partner.test')).toBe('limit');
    expect(audited('access.outside.link').filter((e) => e.details?.scope === 'domain')).toHaveLength(before + 1);
    await identity.mailSettled();
    expect(mails).toHaveLength(0);
    // The route still answers 202 (checked against the same limiter state: the domain is over).
    const response = await askLink('c@partner.test');
    expect(response.status).toBe(202);
    expect(mails).toHaveLength(0);
  });

  it('answers 429 with Retry-After to the 11th ask from one network address in 15 minutes: the one visible limit', async () => {
    const ip = '10.99.0.1';
    for (let i = 0; i < 10; i++) expect((await send(emailRoute.POST as Handler, '/request-access/api/sign-in/email', { body: { email: `p${i}@other.test` }, ip })).status).toBe(202);
    const refused = await send(emailRoute.POST as Handler, '/request-access/api/sign-in/email', { body: { email: 'p11@other.test' }, ip });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another network address is not affected.
    expect((await send(emailRoute.POST as Handler, '/request-access/api/sign-in/email', { body: { email: 'p12@other.test' }, ip: '10.99.0.2' })).status).toBe(202);
  });

  it('answers 400 to an address that is not one, and refuses a body that is not JSON', async () => {
    expect((await send(emailRoute.POST as Handler, '/request-access/api/sign-in/email', { body: { email: 'not-an-address' } })).status).toBe(400);
    expect((await send(emailRoute.POST as Handler, '/request-access/api/sign-in/email', { body: {} })).status).toBe(400);
  });
});

describe('verifying a link', () => {
  it('starts a session, makes the requester, and burns the link', async () => {
    const { cookie, response } = await signIn('erin@partner.test');
    const body = await jsonOf(response);
    expect(body).toEqual({ requester: { email: 'erin@partner.test', name: null, verifiedBy: 'link' } });
    const row = store.requesterRowByKey('erin@partner.test')!;
    expect(row).toMatchObject({ verified_by: 'link', email: 'erin@partner.test', blocked_at: null });
    expect(row.id).toMatch(/^ext_/);
    expect(identity.getOutsideRequester(row.id)).toEqual({ id: row.id, email: 'erin@partner.test', name: null, verifiedBy: 'link', blocked: false });
    expect(identity.outsideRequesterByEmail('ERIN@partner.test')?.id).toBe(row.id);
    expect(audited('access.outside.sign_in').some((e) => e.outcome === 'success' && e.details?.method === 'link' && e.details?.email === 'erin@partner.test')).toBe(true);
    const me = await send(sessionRoute.GET as Handler, '/request-access/api/session', { method: 'GET', cookie });
    expect(me.status).toBe(200);
    expect((await jsonOf(me)).requester).toEqual({ email: 'erin@partner.test', name: null, verifiedBy: 'link' });
    // The same token again, and a made-up one: one sentence.
    const again = await send(verifyRoute.POST as Handler, '/request-access/api/sign-in/verify', { body: { token: tokenOf(mails[0]) } });
    const made = await send(verifyRoute.POST as Handler, '/request-access/api/sign-in/verify', { body: { token: 'made-up-token' } });
    expect(again.status).toBe(400);
    expect(made.status).toBe(400);
    expect((await jsonOf(again)).error).toBe('This link has expired or was already used. Ask for a new one.');
    expect(await jsonOf(made)).toMatchObject({ error: 'This link has expired or was already used. Ask for a new one.', code: 'expired' });
    expect(setCookie(again, 'landflow_requester')).toBeUndefined();
  });

  it('expires after 15 minutes', async () => {
    const t0 = Date.parse('2031-01-01T10:00:00Z');
    await identity.requestLink('erin@partner.test', { ip: nextIp(), origin: BASE, now: t0 });
    await identity.mailSettled();
    const token = tokenOf(mails[0]);
    await expect(identity.verifyLink(token, { ip: nextIp(), now: t0 + 15 * 60_000 + 1000 })).rejects.toMatchObject({ reason: 'expired', status: 400 });
    await identity.requestLink('erin@partner.test', { ip: nextIp(), origin: BASE, now: t0 + 20 * 60_000 });
    await identity.mailSettled();
    const fresh = await identity.verifyLink(tokenOf(mails[1]), { ip: nextIp(), now: t0 + 20 * 60_000 + 14 * 60_000 });
    expect(fresh.requester.email).toBe('erin@partner.test');
  });

  it('lets exactly one of two concurrent clicks sign in', async () => {
    await askLink('erin@partner.test');
    const token = tokenOf(mails[0]);
    const results = await Promise.allSettled([identity.verifyLink(token, { ip: nextIp() }), identity.verifyLink(token, { ip: nextIp() }), identity.verifyLink(token, { ip: nextIp() })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);
    expect(database().all('SELECT id FROM access_outside_sessions')).toHaveLength(1);
    expect(database().all('SELECT id FROM access_outside_requesters')).toHaveLength(1);
  });

  it('refuses an address that became a Landflow user, with 409 and no session', async () => {
    await askLink('late@partner.test');
    const token = tokenOf(mails[0]);
    await auth.createUser({ email: 'late@partner.test', name: 'Late Joiner', role: 'member' });
    const response = await send(verifyRoute.POST as Handler, '/request-access/api/sign-in/verify', { body: { token } });
    expect(response.status).toBe(409);
    expect(await jsonOf(response)).toMatchObject({ code: 'landflow_user', signInUrl: '/access' });
    expect(setCookie(response, 'landflow_requester')).toBeUndefined();
    expect(database().all('SELECT id FROM access_outside_requesters')).toHaveLength(0);
    expect(audited('access.outside.sign_in').some((e) => e.outcome === 'denied' && e.details?.reason === 'landflow_user')).toBe(true);
  });

  it('answers 429 after 20 wrong links from one network address', async () => {
    const ip = '10.98.0.1';
    for (let i = 0; i < 20; i++) expect((await send(verifyRoute.POST as Handler, '/request-access/api/sign-in/verify', { body: { token: `wrong-${i}` }, ip })).status).toBe(400);
    const refused = await send(verifyRoute.POST as Handler, '/request-access/api/sign-in/verify', { body: { token: 'wrong-21' }, ip });
    expect(refused.status).toBe(429);
  });
});

describe('the requester session', () => {
  it('sets a cookie that is HttpOnly, SameSite=Strict, scoped to /request-access and ends in 8 hours', async () => {
    await askLink('erin@partner.test');
    const response = await send(verifyRoute.POST as Handler, '/request-access/api/sign-in/verify', { body: { token: tokenOf(mails[0]) } });
    const line = setCookie(response, 'landflow_requester')!;
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/SameSite=strict/i);
    expect(line).toMatch(/Path=\/request-access(;|$)/);
    expect(line).not.toMatch(/Secure/i);
    const expires = Date.parse(/Expires=([^;]+)/i.exec(line)![1]);
    expect(Math.abs(expires - (Date.now() + 8 * 3_600_000))).toBeLessThan(60_000);
    // The cookie value is not what is stored.
    const value = cookieValue(response, 'landflow_requester')!;
    expect(database().get<{ token_hash: string }>('SELECT token_hash FROM access_outside_sessions')?.token_hash).toBe(sha(value));
    expect(JSON.stringify(database().all('SELECT * FROM access_outside_sessions'))).not.toContain(value);
  });

  it('is Secure behind https', async () => {
    await askLink('erin@partner.test');
    const response = await send(verifyRoute.POST as Handler, '/request-access/api/sign-in/verify', { body: { token: tokenOf(mails[0]) }, headers: { 'x-forwarded-proto': 'https' } });
    expect(setCookie(response, 'landflow_requester')).toMatch(/Secure/i);
  });

  it('ends after 2 hours idle and after 8 hours, and a request a minute apart keeps it alive', async () => {
    const t0 = Date.parse('2032-03-01T08:00:00Z');
    await identity.requestLink('erin@partner.test', { ip: nextIp(), origin: BASE, now: t0 });
    await identity.mailSettled();
    const { session } = await identity.verifyLink(tokenOf(mails[0]), { ip: nextIp(), now: t0 });
    const request = new Request(`${BASE}/request-access/api/session`, { headers: { cookie: `landflow_requester=${session.token}` } });
    expect(await sessions.requesterFromRequest(request, { now: t0 + 90 * 60_000 })).toMatchObject({ email: 'erin@partner.test' });
    // 90 minutes of idleness again (the session was seen at +90): fine; but 2 hours without a request ends it.
    expect(await sessions.requesterFromRequest(request, { now: t0 + 90 * 60_000 + 119 * 60_000 })).not.toBeNull();
    expect(await sessions.requesterFromRequest(request, { now: t0 + 90 * 60_000 + 119 * 60_000 + 121 * 60_000 })).toBeNull();
    expect(database().all('SELECT id FROM access_outside_sessions')).toHaveLength(0);
    // Absolute: busy every hour, still ends at 8 hours.
    await identity.requestLink('erin@partner.test', { ip: nextIp(), origin: BASE, now: t0 });
    await identity.mailSettled();
    const busy = (await identity.verifyLink(tokenOf(mails[1]), { ip: nextIp(), now: t0 })).session.token;
    const busyRequest = new Request(`${BASE}/x`, { headers: { cookie: `landflow_requester=${busy}` } });
    for (let h = 1; h <= 7; h++) expect(await sessions.requesterFromRequest(busyRequest, { now: t0 + h * 3_600_000 }), `hour ${h}`).not.toBeNull();
    expect(await sessions.requesterFromRequest(busyRequest, { now: t0 + 8 * 3_600_000 + 1000 })).toBeNull();
  });

  it('keeps at most 5 sessions of a requester and replaces the browser’s old one at sign-in (no fixation)', async () => {
    const cookies: string[] = [];
    for (let i = 0; i < 6; i++) cookies.push((await signIn('erin@partner.test')).cookie);
    expect(database().all('SELECT id FROM access_outside_sessions')).toHaveLength(5);
    const oldest = await send(sessionRoute.GET as Handler, '/request-access/api/session', { method: 'GET', cookie: cookies[0] });
    const newest = await send(sessionRoute.GET as Handler, '/request-access/api/session', { method: 'GET', cookie: cookies[5] });
    expect(oldest.status).toBe(401);
    expect(newest.status).toBe(200);
    // Signing in again with the old cookie present ends that session and makes a different token.
    await askLink('erin@partner.test');
    const again = await send(verifyRoute.POST as Handler, '/request-access/api/sign-in/verify', { body: { token: tokenOf(mails.at(-1)!) }, cookie: cookies[5] });
    expect(cookieValue(again, 'landflow_requester')).not.toBe(cookies[5].split('=')[1]);
    expect((await send(sessionRoute.GET as Handler, '/request-access/api/session', { method: 'GET', cookie: cookies[5] })).status).toBe(401);
  });

  it('is refused, and deleted, once the feature is off, the domain removed, the person blocked or their address is a Landflow user’s', async () => {
    const check = async (change: () => void | Promise<void>, undo: () => void, email = 'erin@partner.test') => {
      const { cookie } = await signIn(email);
      expect((await send(sessionRoute.GET as Handler, '/request-access/api/session', { method: 'GET', cookie })).status).toBe(200);
      await change();
      const response = await send(sessionRoute.GET as Handler, '/request-access/api/session', { method: 'GET', cookie });
      expect(response.status, 'after the change').toBe(401);
      undo();
      // The row is gone for good, not just hidden.
      expect(database().all('SELECT id FROM access_outside_sessions')).toHaveLength(0);
      return cookie;
    };
    const saved = settings.outsideSettings();
    const off = () => database().upsert('settings', { key: settings.OUTSIDE_SETTINGS_KEY, value: JSON.stringify(saved) });
    // The feature off: 404 for every route, and the session row stays until the next real check; turning on again finds it ended or alive, never extended.
    const { cookie: c1 } = await signIn('erin@partner.test');
    database().upsert('settings', { key: settings.OUTSIDE_SETTINGS_KEY, value: JSON.stringify({ ...saved, enabled: false }) });
    expect((await send(sessionRoute.GET as Handler, '/request-access/api/session', { method: 'GET', cookie: c1 })).status).toBe(404);
    expect(await sessions.requesterFromRequest(new Request(`${BASE}/x`, { headers: { cookie: c1 } }))).toBeNull();
    off();
    expect((await send(sessionRoute.GET as Handler, '/request-access/api/session', { method: 'GET', cookie: c1 })).status).toBe(401);
    expect(database().all('SELECT id FROM access_outside_sessions')).toHaveLength(0);

    await check(
      () => database().upsert('settings', { key: settings.OUTSIDE_SETTINGS_KEY, value: JSON.stringify({ ...saved, domains: ['other.test'] }) }),
      off,
    );
    await check(
      async () => {
        await blockRequesterByEmail('erin@partner.test');
      },
      async () => undefined as never,
    );
    await unblockRequesterByEmail('erin@partner.test');
    await check(
      async () => {
        await auth.createUser({ email: 'neo@partner.test', name: 'Neo Joined', role: 'member' });
      },
      () => undefined,
      'neo@partner.test',
    );
  });

  it('signs out: the session ends, the cookie is cleared, it is audited, and a stale tab can sign out again', async () => {
    const { cookie } = await signIn('erin@partner.test');
    const out = await send(signOutRoute.POST as Handler, '/request-access/api/sign-out', { cookie });
    expect(out.status).toBe(200);
    expect(setCookie(out, 'landflow_requester')).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    expect((await send(sessionRoute.GET as Handler, '/request-access/api/session', { method: 'GET', cookie })).status).toBe(401);
    expect(audited('access.outside.sign_out')).toHaveLength(1);
    expect((await send(signOutRoute.POST as Handler, '/request-access/api/sign-out', { cookie })).status).toBe(200);
    expect(audited('access.outside.sign_out')).toHaveLength(1);
  });

  it('answers 401 signed_out without a session', async () => {
    const response = await send(sessionRoute.GET as Handler, '/request-access/api/session', { method: 'GET' });
    expect(response.status).toBe(401);
    expect(await jsonOf(response)).toMatchObject({ error: 'signed_out' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('writes are same-origin JSON', () => {
  it('refuses a cross-site Origin, a cross-site fetch without Origin, and a form post; passes a same-origin JSON write', async () => {
    const { cookie } = await signIn('erin@partner.test');
    const evil = await send(signOutRoute.POST as Handler, '/request-access/api/sign-out', { cookie, headers: { origin: 'https://evil.test' } });
    expect(evil.status).toBe(403);
    expect(await jsonOf(evil)).toMatchObject({ code: 'cross_site' });
    const nullOrigin = await send(signOutRoute.POST as Handler, '/request-access/api/sign-out', { cookie, headers: { origin: 'null' } });
    expect(nullOrigin.status).toBe(403);
    const noOrigin = new Request(`${BASE}/request-access/api/sign-out`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site', cookie } });
    expect((await (signOutRoute.POST as Handler)(noOrigin)).status).toBe(403);
    const form = new Request(`${BASE}/request-access/api/sign-out`, { method: 'POST', headers: { origin: BASE, 'content-type': 'application/x-www-form-urlencoded', cookie }, body: 'a=b' });
    expect((await (signOutRoute.POST as Handler)(form)).status).toBe(415);
    const plain = new Request(`${BASE}/request-access/api/sign-in/email`, { method: 'POST', headers: { origin: BASE, 'content-type': 'text/plain', 'x-forwarded-for': nextIp() }, body: '{"email":"erin@partner.test"}' });
    expect((await (emailRoute.POST as Handler)(plain)).status).toBe(415);
    // The session survived every refused write.
    expect((await send(sessionRoute.GET as Handler, '/request-access/api/session', { method: 'GET', cookie })).status).toBe(200);
    expect((await send(signOutRoute.POST as Handler, '/request-access/api/sign-out', { cookie })).status).toBe(200);
    // The sign-in writes are protected the same way.
    expect((await send(emailRoute.POST as Handler, '/request-access/api/sign-in/email', { body: { email: 'erin@partner.test' }, headers: { origin: 'https://evil.test' } })).status).toBe(403);
    expect((await send(verifyRoute.POST as Handler, '/request-access/api/sign-in/verify', { body: { token: 'x' }, headers: { origin: 'https://evil.test' } })).status).toBe(403);
  });
});

describe('the requester session opens nothing of Landflow', () => {
  it('is no credential for any Landflow route, and a Landflow session is none here', async () => {
    const { cookie } = await signIn('erin@partner.test');
    // Through the guard: no principal.
    for (const path of ['/api/access/requests', '/api/access/entries', '/api/workflows', '/api/auth/me', '/api/access/outside']) {
      const gate = guardRequest(new Request(`${BASE}${path}`, { headers: { cookie } }));
      expect(gate.ok, path).toBe(false);
      if (!gate.ok) expect(gate.response.status, path).toBe(401);
    }
    // Through the handlers.
    for (const [route, path] of [[accessRequestsRoute.GET, '/api/access/requests'], [meRoute.GET, '/api/auth/me'], [adminSettingsRoute.GET, '/api/access/outside']] as Array<[Handler, string]>) {
      const response = await send(route, path, { method: 'GET', cookie });
      expect(response.status, path).toBe(401);
    }
    // A Landflow session cookie against the requester routes.
    const landflow = createSession(member, 'password');
    const response = await send(sessionRoute.GET as Handler, '/request-access/api/session', { method: 'GET', cookie: `landflow_session=${landflow.token}` });
    expect(response.status).toBe(401);
    // And a Landflow session is not a requester's even with the right-looking name.
    const spoof = await send(sessionRoute.GET as Handler, '/request-access/api/session', { method: 'GET', cookie: `landflow_requester=${landflow.token}` });
    expect(spoof.status).toBe(401);
  });
});

describe('settings and Block (instance admins)', () => {
  const act = (user: typeof owner) => (auth.enableTestAuth(user), undefined);
  const call = async (user: typeof owner, route: Handler, path: string, options: Parameters<typeof send>[2] = {}) => {
    act(user);
    const response = await send(route, path, { method: 'GET', ...options });
    return { status: response.status, body: await jsonOf(response) };
  };
  afterAll(() => auth.disableTestAuth());

  it('every route is session-only', () => {
    for (const [method, path] of [['GET', '/api/access/outside'], ['PUT', '/api/access/outside'], ['GET', '/api/access/outside/requesters'], ['POST', '/api/access/outside/requesters/x/block'], ['POST', '/api/access/outside/requesters/x/unblock']]) {
      expect(routePolicy(method, path), `${method} ${path}`).toMatchObject({ scope: 'any', sessionOnly: true });
    }
  });

  it('refuses a member, reads for an admin, and shows the page link', async () => {
    database().delete('settings', { key: settings.OUTSIDE_SETTINGS_KEY });
    expect((await call(member, adminSettingsRoute.GET as Handler, '/api/access/outside')).status).toBe(403);
    expect((await call(member, adminSettingsRoute.PUT as Handler, '/api/access/outside', { method: 'PUT', body: { enabled: false } })).status).toBe(403);
    expect((await call(member, adminRequestersRoute.GET as Handler, '/api/access/outside/requesters')).status).toBe(403);
    const read = await call(admin, adminSettingsRoute.GET as Handler, '/api/access/outside');
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ enabled: false, domains: [], google: { enabled: false }, pageUrl: `${BASE}/request-access`, redirectUrl: `${BASE}/request-access/api/sign-in/google/callback`, mail: true });
  });

  it('saves with before and after in the audit log, and validates every field', async () => {
    const put = (body: unknown) => call(admin, adminSettingsRoute.PUT as Handler, '/api/access/outside', { method: 'PUT', body });
    database().delete('settings', { key: settings.OUTSIDE_SETTINGS_KEY });
    expect((await put({ enabled: true })).status).toBe(400);
    expect((await put({ domains: ['gmail.com'] })).body).toMatchObject({ field: 'domains' });
    expect((await put({ domains: ['*.partner.test'] })).status).toBe(400);
    expect((await put({ domains: ['10.0.0.1'] })).status).toBe(400);
    expect((await put({ domains: ['localhost'] })).status).toBe(400);
    expect((await put({ domains: ['bob@partner.test'] })).status).toBe(400);
    expect((await put({ domains: Array.from({ length: 51 }, (_, i) => `d${i}.test`) })).status).toBe(400);
    expect((await put({ google: { enabled: true } })).body).toMatchObject({ field: 'google' });
    const plain = credentials.create({ name: 'Not a client', type: 'core.httpBearerAuth', data: { token: 'x-token-1234567890' } });
    expect((await put({ google: { enabled: true, credentialId: plain.id } })).status).toBe(400);
    expect((await put({ google: { enabled: true, credentialId: 'cred_missing' } })).status).toBe(400);
    expect((await put({ unknown: 1 })).status).toBe(400);
    expect(settings.outsideSettings().enabled).toBe(false);
    const saved = await put({ enabled: true, domains: [' Partner.TEST ', 'partner.test', 'sub.example.org'] });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ enabled: true, domains: ['partner.test', 'sub.example.org'] });
    const event = audited('access.outside.settings').at(0)!;
    expect(event.actor).toMatchObject({ id: admin.id });
    expect(JSON.parse(String(event.details?.from))).toMatchObject({ enabled: false });
    expect(JSON.parse(String(event.details?.to))).toMatchObject({ enabled: true, domains: ['partner.test', 'sub.example.org'] });
    // A usable OpenID Connect client is accepted.
    const client = credentials.create({ name: 'Google client', type: 'core.oidcClient', data: { issuer: 'https://accounts.google.com', clientId: 'client-1', clientSecret: 'secret-1' } });
    const withGoogle = await put({ google: { enabled: true, credentialId: client.id } });
    expect(withGoogle.status).toBe(200);
    expect(withGoogle.body.google).toMatchObject({ enabled: true, credentialId: client.id, credentialName: 'Google client' });
    expect(JSON.stringify(withGoogle.body)).not.toContain('secret-1');
    // Switching off keeps the domains.
    expect((await put({ enabled: false })).body).toMatchObject({ enabled: false, domains: ['partner.test', 'sub.example.org'] });
  });

  it('an admin can open an entry to outsiders when creating it (the route keeps outsideMayAsk), an owner cannot', async () => {
    const entriesRoute = await import('@/app/api/access/entries/route');
    const body = (name: string, extra: object = {}) => ({ method: 'POST', body: { name, system: 'manual', target: { instructions: 'By hand' }, durations: [60], approverIds: [admin.id], owners: [admin.id], ...extra } });
    const opened = await call(admin, entriesRoute.POST as Handler, '/api/access/entries', body('Open one', { outsideMayAsk: true }));
    expect(opened.status).toBe(201);
    expect(opened.body.outsideMayAsk).toBe(true);
    expect((await call(admin, entriesRoute.POST as Handler, '/api/access/entries', body('Closed one'))).body.outsideMayAsk).toBe(false);
    expect((await call(member, entriesRoute.POST as Handler, '/api/access/entries', body('Not yours', { outsideMayAsk: true }))).status).toBe(403);
  });

  it('lists requesters for admins, and Block ends sessions, cancels open requests, stops links, and Unblock lets them back', async () => {
    const { cookie } = await signIn('erin@partner.test');
    const requester = store.requesterRowByKey('erin@partner.test')!;
    const stamp = new Date().toISOString();
    database().upsert('access_requests', { id: 'areq_erin', entry_id: 'ae_x', entry_version: 1, entry_snapshot: '{}', requester_id: requester.id, account: null, duration_minutes: 60, reason: 'Needs it', channel: 'form', status: 'pending', approvers: '[]', workflow_id: null, execution_id: null, decisions: null, approved_minutes: null, note: null, question: null, created_at: stamp, updated_at: stamp });
    const list = await call(admin, adminRequestersRoute.GET as Handler, '/api/access/outside/requesters');
    expect(list.status).toBe(200);
    expect(list.body.requesters).toEqual([expect.objectContaining({ id: requester.id, email: 'erin@partner.test', verifiedBy: 'link', blocked: false, openRequests: 1, liveGrants: 0 })]);

    expect((await call(member, blockRoute.POST as Handler, `/api/access/outside/requesters/${requester.id}/block`, { method: 'POST', params: { id: requester.id } })).status).toBe(403);
    const blocked = await call(admin, blockRoute.POST as Handler, `/api/access/outside/requesters/${requester.id}/block`, { method: 'POST', params: { id: requester.id } });
    expect(blocked.status).toBe(200);
    expect(blocked.body).toMatchObject({ blocked: true, openRequests: 0 });
    expect(database().get<{ status: string }>('SELECT status FROM access_requests WHERE id = ?', 'areq_erin')?.status).toBe('cancelled');
    expect(audited('access.outside.block')[0]).toMatchObject({ actor: expect.objectContaining({ id: admin.id }), target: expect.objectContaining({ id: requester.id }) });
    // One path: Block cancels through the library's cancelOpenRequestsOf, which says why in the audit event.
    expect(audited('access.request.cancel').find((e) => e.target?.id === 'areq_erin')?.details).toMatchObject({ reason: 'blocked', to: 'cancelled' });
    auth.disableTestAuth();
    expect((await send(sessionRoute.GET as Handler, '/request-access/api/session', { method: 'GET', cookie })).status).toBe(401);
    expect(database().all('SELECT id FROM access_outside_sessions')).toHaveLength(0);
    // No more links, and the answer does not say why.
    mails.length = 0;
    const ask = await askLink('erin@partner.test');
    expect(ask.status).toBe(202);
    expect(mails).toHaveLength(0);
    expect(identity.getOutsideRequester(requester.id)?.blocked).toBe(true);

    expect((await call(member, unblockRoute.POST as Handler, `/api/access/outside/requesters/${requester.id}/unblock`, { method: 'POST', params: { id: requester.id } })).status).toBe(403);
    const unblocked = await call(admin, unblockRoute.POST as Handler, `/api/access/outside/requesters/${requester.id}/unblock`, { method: 'POST', params: { id: requester.id } });
    expect(unblocked.body).toMatchObject({ blocked: false });
    expect(audited('access.outside.unblock').some((e) => e.target?.id === requester.id)).toBe(true);
    auth.disableTestAuth();
    await askLink('erin@partner.test');
    expect(mails).toHaveLength(1);
    expect((await call(admin, blockRoute.POST as Handler, '/api/access/outside/requesters/ext_nobody/block', { method: 'POST', params: { id: 'ext_nobody' } })).status).toBe(404);
  });
});

describe('housekeeping', () => {
  it('deletes used and expired links and ended sessions, keeping live ones and every requester', async () => {
    const t0 = Date.now();
    await askLink('erin@partner.test');
    const { cookie } = await signIn('dana@partner.test');
    await askLink('live@partner.test');
    // One expired link and one ended session by hand.
    const stamp = new Date(t0 - 3_600_000).toISOString();
    database().upsert('access_outside_links', { id: 'ol_old', token_hash: 'h-old', email_key: 'old@partner.test', email: 'old@partner.test', ip: null, created_at: stamp, expires_at: stamp, used_at: null });
    database().upsert('access_outside_sessions', { id: 'os_old', token_hash: 'h-old-s', requester_id: 'ext_x', method: 'link', created_at: stamp, expires_at: stamp, last_seen_at: stamp, ip: null, user_agent: null });
    const result = sessions.pruneOutside(t0);
    expect(result.links).toBeGreaterThanOrEqual(2);
    expect(result.sessions).toBeGreaterThanOrEqual(1);
    const live = database().all<{ email: string }>('SELECT email FROM access_outside_links').map((l) => l.email);
    expect(live.sort()).toEqual(['erin@partner.test', 'live@partner.test'].sort());
    expect(database().all('SELECT id FROM access_outside_sessions')).toHaveLength(1);
    expect(database().all('SELECT id FROM access_outside_requesters').length).toBe(1);
    expect((await send(sessionRoute.GET as Handler, '/request-access/api/session', { method: 'GET', cookie })).status).toBe(200);
  });
});

/** Block through the library as the owner (the admin route is tested above). */
async function blockRequesterByEmail(email: string) {
  const { blockRequester } = await import('@/lib/server/access/outside/admin');
  await blockRequester(owner, store.requesterRowByKey(email)!.id);
}
async function unblockRequesterByEmail(email: string) {
  const { unblockRequester } = await import('@/lib/server/access/outside/admin');
  unblockRequester(owner, store.requesterRowByKey(email)!.id);
}
void partnerUser;

describe('seams with the request library (C36 integration)', () => {
  it('the session `chat` flag is true only when the access chat is set up and the outside cap is above 0', async () => {
    const { saveAccessSettings, accessSettings } = await import('@/lib/server/access/store');
    const { store: workflows } = await import('@/lib/server/store');
    const { cookie } = await signIn('erin@partner.test');
    const chatFlag = async () => (await jsonOf(await send(sessionRoute.GET as Handler, '/request-access/api/session', { method: 'GET', cookie }))).chat;
    expect(await chatFlag()).toBe(false); // nothing installed
    workflows.saveWorkflow({ id: 'wf_seam_chat', name: 'Access chat', nodes: [{ id: 'chat', name: 'Chat', type: 'core.chatTrigger', typeVersion: 1, position: [0, 0], parameters: {} }], connections: [] } as never);
    saveAccessSettings({ ...accessSettings(), chatWorkflowId: 'wf_seam_chat' });
    expect(await chatFlag()).toBe(true);
    process.env.LANDFLOW_ACCESS_OUTSIDE_CHAT_PER_HOUR = '0';
    try {
      expect(await chatFlag()).toBe(false);
    } finally {
      delete process.env.LANDFLOW_ACCESS_OUTSIDE_CHAT_PER_HOUR;
    }
    saveAccessSettings({ ...accessSettings(), chatWorkflowId: undefined });
    workflows.deleteWorkflow('wf_seam_chat');
  });

  it('answers a thrown AccessError with its status and message, and any other error with a generic 500', async () => {
    const { outsideRoute, outsidePublic } = await import('@/lib/server/access/outside/http');
    const { AccessError } = await import('@/lib/server/access/errors');
    const { cookie } = await signIn('erin@partner.test');
    const refused = outsideRoute(async () => { throw new AccessError('Not for you', 403, { why: 'test' }); });
    const answered = await send(refused as Handler, '/request-access/api/x', { method: 'GET', cookie });
    expect(answered.status).toBe(403);
    expect(await jsonOf(answered)).toMatchObject({ error: 'Not for you' });
    expect(answered.headers.get('cache-control')).toBe('no-store');
    const broken = outsidePublic(async () => { throw new Error('secret internal detail'); });
    const failed = await send(broken as Handler, '/request-access/api/y', { method: 'GET' });
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await jsonOf(failed))).not.toContain('secret internal detail');
    // B's real route: the chat, not set up, is B's AccessError 409 as JSON.
    const chatRoute = await import('@/app/request-access/api/chat/route');
    const chat = await send(chatRoute.POST as Handler, '/request-access/api/chat', { body: { message: 'hi', sessionId: 's1' }, cookie });
    expect(chat.status).toBe(409);
    expect(await jsonOf(chat)).toMatchObject({ error: expect.stringContaining('not set up') });
  });

  it('the hourly access reconcile prunes outside links and sessions', async () => {
    const { reconcileGrants } = await import('@/lib/server/access/sweeper');
    await askLink('erin@partner.test'); // a live link row, then an ended one
    const old = new Date(Date.now() - 3_600_000).toISOString();
    for (const link of database().all<Record<string, string>>('SELECT * FROM access_outside_links')) database().upsert('access_outside_links', { ...link, expires_at: old });
    expect(database().all('SELECT id FROM access_outside_links').length).toBeGreaterThan(0);
    await reconcileGrants();
    expect(database().all('SELECT id FROM access_outside_links')).toHaveLength(0);
  });
});
