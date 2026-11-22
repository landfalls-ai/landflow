/**
 * C16 / P15b: passkeys as a second factor. A software authenticator (test/fake-authenticator.ts) registers through the
 * routes (password asked, challenge single-use and bound to the person and purpose, at most ten, ids unique) and
 * answers the sign-in second step (`password+webauthn`) and the step-up. The signature counter only moves forward (a
 * zero-counter authenticator stays allowed); a lower or repeated one refuses the sign-in and flags the key for good.
 * A wrong origin or relying party, a replayed assertion and another person's key are refused. Nothing secret reaches the audit log.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeAuthenticator } from './fake-authenticator';
import { call, sessionCookie } from './mfa-helpers';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-mfa-webauthn-'));
const ORIGIN = 'https://landflow.example.test:8443';
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: `${ORIGIN}/` };
const UNSET = ['LANDFLOW_OWNER_EMAIL', 'LANDFLOW_OWNER_PASSWORD', 'LANDFLOW_SMTP_HOST', 'LANDFLOW_LOGIN_MAX_ATTEMPTS', 'LANDFLOW_MFA_REQUIRED', 'LANDFLOW_LOCAL_SIGN_IN'];
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
for (const key of UNSET) delete process.env[key];

const auth = await import('@/lib/server/auth');
const { authDb } = await import('@/lib/server/auth/db');
const { tokenHash } = await import('@/lib/server/auth/passwords');
const { guardRequest } = await import('@/lib/server/auth/guard');
const { queryEvents } = await import('@/lib/server/audit/store');
const factors = await import('@/lib/server/auth/mfa/factors');
const totp = await import('@/lib/server/auth/mfa/totp');
const loginRoute = await import('@/app/api/auth/login/route');
const verifyRoute = await import('@/app/api/auth/mfa/verify/route');
const signInOptionsRoute = await import('@/app/api/auth/mfa/options/route');
const optionsRoute = await import('@/app/api/me/mfa/passkeys/options/route');
const passkeysRoute = await import('@/app/api/me/mfa/passkeys/route');
const meRoute = await import('@/app/api/me/mfa/route');
const factorRoute = await import('@/app/api/me/mfa/[id]/route');
const stepUpRoute = await import('@/app/api/me/mfa/step-up/route');
const { request } = await import('./mfa-helpers');
const policy = await import('@/lib/server/auth/policy');
const webauthn = await import('@/lib/server/auth/mfa/webauthn');

beforeAll(() => {
  auth.disableTestAuth();
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterAll(() => {
  vi.useRealTimers();
  auth.enableTestAuth();
  for (const key of [...Object.keys(ENV), ...UNSET]) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const PASSWORD = 'a-long-password-1';
let n = 0;
const newUser = (role: 'owner' | 'admin' | 'member' = 'member') => auth.createUser({ email: `w${++n}@example.test`, name: `W${n}`, role, password: PASSWORD });
const device = () => new FakeAuthenticator(ORIGIN, 'landflow.example.test');
const sessionOf = (user: Awaited<ReturnType<typeof newUser>>) => auth.createSession(user, 'password').token;

/** Register `authenticator` through the routes, as the signed-in person. */
async function register(session: string, authenticator: FakeAuthenticator, name = 'Laptop') {
  const started = await call(optionsRoute.POST, '/api/me/mfa/passkeys/options', { session, body: { purpose: 'register', password: PASSWORD } });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const done = await call(passkeysRoute.POST, '/api/me/mfa/passkeys', { session, body: { challenge: started.body.challenge, name, response: authenticator.create(started.body.options) } });
  return { started, done };
}

/** A password sign-in's challenge, and the options a passkey answers it with. */
async function signInOptions(email: string) {
  const first = await call(loginRoute.POST, '/api/auth/login', { body: { email, password: PASSWORD } });
  expect(first.status).toBe(202);
  const options = await call(signInOptionsRoute.POST, '/api/auth/mfa/options', { body: { challenge: first.body.challenge } });
  return { first, options };
}
const verify = (challenge: string, response: unknown) => call(verifyRoute.POST, '/api/auth/mfa/verify', { body: { challenge, method: 'webauthn', response } });
const methodOf = (token: string) => authDb().get<{ method: string; mfa_verified_at: string | null }>('SELECT method, mfa_verified_at FROM sessions WHERE id = ?', tokenHash(token));
const factorRow = (id: string) => authDb().get<Record<string, unknown>>('SELECT * FROM user_mfa_factors WHERE id = ?', id);

describe('the software authenticator', () => {
  it('makes a response @simplewebauthn/server accepts for the origin it was told', async () => {
    const { generateRegistrationOptions, verifyRegistrationResponse } = await import('@simplewebauthn/server');
    const key = device();
    const options = await generateRegistrationOptions({ rpName: 'x', rpID: 'landflow.example.test', userName: 'a@b.c', attestationType: 'none' });
    const verified = await verifyRegistrationResponse({ response: key.create(options), expectedChallenge: options.challenge, expectedOrigin: ORIGIN, expectedRPID: 'landflow.example.test', requireUserVerification: false });
    expect(verified.verified).toBe(true);
    expect(verified.registrationInfo?.credential.id).toBe(key.id);
  });
});

describe('registering a passkey', () => {
  it('asks for the password, then makes a confirmed factor named by the person and the first one brings recovery codes', async () => {
    const user = await newUser();
    const session = sessionOf(user);
    const wrong = await call(optionsRoute.POST, '/api/me/mfa/passkeys/options', { session, body: { purpose: 'register', password: 'not-it-not-it-1' } });
    expect(wrong.status).toBe(403);
    const missing = await call(optionsRoute.POST, '/api/me/mfa/passkeys/options', { session, body: { purpose: 'register' } });
    expect(missing.status).toBe(400);

    const key = device();
    const { started, done } = await register(session, key, 'Laptop');
    // Options come from the configured public URL: relying party id is its host, attestation none, verification preferred.
    expect(started.body.options.rp.id).toBe('landflow.example.test');
    expect(started.body.options.attestation).toBe('none');
    expect(started.body.options.authenticatorSelection.userVerification).toBe('preferred');
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body.factor).toMatchObject({ kind: 'webauthn', name: 'Laptop', confirmed: true });
    expect(done.body.recoveryCodes).toHaveLength(10);
    expect(factors.methodsFor(user.id)).toEqual(['webauthn', 'recovery']);
    expect(factorRow(done.body.factor.id)).toMatchObject({ credential_id: key.id, counter: 0 });
    const state = await call(meRoute.GET, '/api/me/mfa', { session });
    expect(JSON.stringify(state.body)).not.toContain(key.id);
    expect(state.body.factors).toHaveLength(1);
  });

  it('lets a second passkey in (without new codes), lists the first in excludeCredentials, and refuses the same authenticator twice', async () => {
    const user = await newUser();
    const session = sessionOf(user);
    const one = device();
    await register(session, one, 'One');
    const second = await call(optionsRoute.POST, '/api/me/mfa/passkeys/options', { session, body: { purpose: 'register', password: PASSWORD } });
    expect(second.body.options.excludeCredentials.map((c: { id: string }) => c.id)).toEqual([one.id]);
    const two = device();
    const ok = await call(passkeysRoute.POST, '/api/me/mfa/passkeys', { session, body: { challenge: second.body.challenge, name: 'Two', response: two.create(second.body.options) } });
    expect(ok.status).toBe(201);
    expect(ok.body.recoveryCodes).toBeUndefined();
    // The same credential again (for this person or anyone) is a conflict.
    const other = await newUser();
    const otherSession = sessionOf(other);
    const dup = await call(optionsRoute.POST, '/api/me/mfa/passkeys/options', { session: otherSession, body: { purpose: 'register', password: PASSWORD } });
    const refused = await call(passkeysRoute.POST, '/api/me/mfa/passkeys', { session: otherSession, body: { challenge: dup.body.challenge, name: 'Copy', response: one.create(dup.body.options) } });
    expect(refused.status).toBe(409);
  });

  it('stops at ten passkeys with a 409', async () => {
    const user = await newUser();
    const session = sessionOf(user);
    for (let i = 0; i < 10; i++) expect((await register(session, device(), `Key ${i}`)).done.status).toBe(201);
    const eleventh = await call(optionsRoute.POST, '/api/me/mfa/passkeys/options', { session, body: { purpose: 'register', password: PASSWORD } });
    expect(eleventh.status).toBe(409);
  });

  it('works once: a challenge that was used, another person’s, a wrong origin and a wrong relying party all refuse', async () => {
    const user = await newUser();
    const session = sessionOf(user);
    const key = device();
    const { started, done } = await register(session, key);
    expect(done.status).toBe(201);
    // Used.
    const again = await call(passkeysRoute.POST, '/api/me/mfa/passkeys', { session, body: { challenge: started.body.challenge, name: 'Again', response: device().create(started.body.options) } });
    expect(again.status).toBe(400);

    const other = await newUser();
    const otherStart = await call(optionsRoute.POST, '/api/me/mfa/passkeys/options', { session: sessionOf(other), body: { purpose: 'register', password: PASSWORD } });
    // Somebody else's challenge presented by this person's session.
    const stolen = await call(passkeysRoute.POST, '/api/me/mfa/passkeys', { session, body: { challenge: otherStart.body.challenge, name: 'Stolen', response: device().create(otherStart.body.options) } });
    expect(stolen.status).toBe(400);

    for (const over of [{ origin: 'https://evil.example.test' }, { rpId: 'evil.example.test' }]) {
      const start = await call(optionsRoute.POST, '/api/me/mfa/passkeys/options', { session, body: { purpose: 'register', password: PASSWORD } });
      const bad = await call(passkeysRoute.POST, '/api/me/mfa/passkeys', { session, body: { challenge: start.body.challenge, name: 'Bad', response: device().create(start.body.options, over) } });
      expect(bad.status).toBe(400);
    }
    expect(factors.listFactors(user.id).filter((f) => f.kind === 'webauthn')).toHaveLength(1);
  });

  it('is open to a session that may only enrol (the policy asks for a factor), and is session-only', async () => {
    const user = await newUser('admin');
    const session = sessionOf(user);
    process.env.LANDFLOW_MFA_REQUIRED = 'admins';
    try {
      expect(guardRequest(request('/api/me/mfa/passkeys/options', { method: 'POST', session })).ok).toBe(true);
      expect(guardRequest(request('/api/me/mfa/passkeys', { method: 'POST', session })).ok).toBe(true);
      expect(guardRequest(request('/api/workflows', { session })).ok).toBe(false);
      expect((await register(session, device())).done.status).toBe(201);
      expect(guardRequest(request('/api/workflows', { session })).ok).toBe(true);
      const { token } = auth.createApiKey(user, { label: 'CI', scopes: ['admin'] });
      expect(guardRequest(request('/api/me/mfa/passkeys/options', { method: 'POST', key: token })).ok).toBe(false);
    } finally {
      delete process.env.LANDFLOW_MFA_REQUIRED;
    }
  });
});

describe('signing in with a passkey', () => {
  async function enrolled() {
    const user = await newUser();
    const key = device();
    const { done } = await register(sessionOf(user), key);
    expect(done.status).toBe(201);
    return { user, key, factorId: done.body.factor.id as string };
  }

  it('lists webauthn among the methods, gives options for the challenge, and a signed assertion makes a `password+webauthn` session', async () => {
    const { user, key } = await enrolled();
    const { first, options } = await signInOptions(user.email);
    expect(first.body.methods).toEqual(['webauthn', 'recovery']);
    expect(options.status, JSON.stringify(options.body)).toBe(200);
    expect(options.body.options.rpId).toBe('landflow.example.test');
    expect(options.body.options.userVerification).toBe('preferred');
    expect(options.body.options.allowCredentials.map((c: { id: string }) => c.id)).toEqual([key.id]);

    const done = await verify(first.body.challenge, key.get(options.body.options));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const token = sessionCookie(done.response)!;
    expect(methodOf(token)).toMatchObject({ method: 'password+webauthn' });
    expect(methodOf(token)?.mfa_verified_at).toBeTruthy();
    expect(done.body.user.email).toBe(user.email);
  });

  it('answers a challenge once: the same assertion, and the same challenge, do not work a second time', async () => {
    const { user, key } = await enrolled();
    const { first, options } = await signInOptions(user.email);
    const assertion = key.get(options.body.options);
    expect((await verify(first.body.challenge, assertion)).status).toBe(200);
    expect((await verify(first.body.challenge, assertion)).status).toBe(401);

    // A replay of the assertion against a fresh challenge fails on the challenge it was not signed for, and a spent webauthn challenge is not reusable even before the sign-in ends.
    const next = await signInOptions(user.email);
    expect((await verify(next.first.body.challenge, assertion)).status).toBe(401);
    const second = await call(signInOptionsRoute.POST, '/api/auth/mfa/options', { body: { challenge: next.first.body.challenge } });
    const good = key.get(second.body.options);
    expect((await verify(next.first.body.challenge, good)).status).toBe(200);
  });

  it('refuses a wrong origin, a wrong relying party, an assertion without options, and another person’s key', async () => {
    const { user, key } = await enrolled();
    for (const over of [{ origin: 'https://evil.example.test' }, { rpId: 'evil.example.test' }]) {
      const { first, options } = await signInOptions(user.email);
      expect((await verify(first.body.challenge, key.get(options.body.options, over))).status).toBe(401);
    }
    // No options asked for: nothing to answer.
    const bare = await call(loginRoute.POST, '/api/auth/login', { body: { email: user.email, password: PASSWORD } });
    expect((await verify(bare.body.challenge, key.get({ challenge: 'AAAA' }))).status).toBe(401);
    // Somebody else's authenticator.
    const { first, options } = await signInOptions(user.email);
    const stranger = device();
    expect((await verify(first.body.challenge, stranger.get(options.body.options))).status).toBe(401);
  });

  it('refuses options for a challenge that is not live, or for a user with no passkey', async () => {
    expect((await call(signInOptionsRoute.POST, '/api/auth/mfa/options', { body: { challenge: 'x'.repeat(43) } })).status).toBe(401);
    const user = await newUser();
    const started = factors.startTotp(user);
    await factors.confirmTotp(user, started.factorId, totp.totpAt(started.secret, totp.stepAt()));
    const login = await call(loginRoute.POST, '/api/auth/login', { body: { email: user.email, password: PASSWORD } });
    expect(login.body.methods).not.toContain('webauthn');
    expect((await call(signInOptionsRoute.POST, '/api/auth/mfa/options', { body: { challenge: login.body.challenge } })).status).toBe(409);
  });

  it('counts wrong answers against the challenge: five end it', async () => {
    const { user, key } = await enrolled();
    const { first } = await signInOptions(user.email);
    for (let i = 0; i < 5; i++) {
      const options = await call(signInOptionsRoute.POST, '/api/auth/mfa/options', { body: { challenge: first.body.challenge } });
      if (options.status !== 200) break;
      expect((await verify(first.body.challenge, key.get(options.body.options, { origin: 'https://evil.example.test' }))).status).toBe(401);
    }
    const options = await call(signInOptionsRoute.POST, '/api/auth/mfa/options', { body: { challenge: first.body.challenge } });
    expect(options.status).toBe(401);
  });
});

describe('the signature counter', () => {
  async function signIn(email: string, key: FakeAuthenticator, over: { counter?: number } = {}) {
    const { first, options } = await signInOptions(email);
    return verify(first.body.challenge, key.get(options.body.options, over));
  }

  it('moves forward with every use and is stored', async () => {
    const user = await newUser();
    const key = device();
    const { done } = await register(sessionOf(user), key);
    expect((await signIn(user.email, key)).status).toBe(200);
    expect((await signIn(user.email, key)).status).toBe(200);
    expect(factorRow(done.body.factor.id)).toMatchObject({ counter: 2 });
    expect(factorRow(done.body.factor.id)?.last_used_at).toBeTruthy();
  });

  it('refuses a lower counter, flags the key, audits `auth.mfa_flagged` with ids only, and keeps refusing it', async () => {
    const user = await newUser();
    const key = device();
    const { done } = await register(sessionOf(user), key);
    const id = done.body.factor.id as string;
    expect((await signIn(user.email, key, { counter: 10 })).status).toBe(200);
    // A clone that reports 5.
    expect((await signIn(user.email, key, { counter: 5 })).status).toBe(401);
    expect(factorRow(id)?.flagged_at).toBeTruthy();
    expect(factorRow(id)).toMatchObject({ counter: 10 });
    const flagged = queryEvents({ action: ['auth.mfa_flagged'] }).events.filter((e) => e.target?.id === user.id);
    expect(flagged).toHaveLength(1);
    const text = JSON.stringify(flagged);
    for (const secret of [key.id, 'publicKey', 'challenge']) expect(text).not.toContain(secret);
    // The passkey is no longer offered: no options, and an assertion for an earlier challenge is refused too.
    const flaggedTry = await signInOptions(user.email);
    expect(flaggedTry.options.status).toBe(409);
    expect((await verify(flaggedTry.first.body.challenge, key.get({ challenge: 'AAAA', rpId: 'landflow.example.test' }, { counter: 11 }))).status).toBe(401);
    const login = await call(loginRoute.POST, '/api/auth/login', { body: { email: user.email, password: PASSWORD } });
    expect(login.body.methods).toEqual(['recovery']);
    const state = await call(meRoute.GET, '/api/me/mfa', { session: sessionOf(user) });
    expect(state.body.factors[0]).toMatchObject({ kind: 'webauthn', flagged: true });
  });

  it('treats a repeated non-zero counter as a clone too', async () => {
    const user = await newUser();
    const key = device();
    const { done } = await register(sessionOf(user), key);
    expect((await signIn(user.email, key, { counter: 7 })).status).toBe(200);
    expect((await signIn(user.email, key, { counter: 7 })).status).toBe(401);
    expect(factorRow(done.body.factor.id)?.flagged_at).toBeTruthy();
  });

  it('allows an authenticator that never counts (always 0) and refuses a drop to 0 after it counted', async () => {
    const user = await newUser();
    const flat = device();
    flat.countsUp = false;
    await register(sessionOf(user), flat);
    for (let i = 0; i < 3; i++) expect((await signIn(user.email, flat)).status).toBe(200);

    const counting = await newUser();
    const key = device();
    await register(sessionOf(counting), key);
    expect((await signIn(counting.email, key, { counter: 4 })).status).toBe(200);
    expect((await signIn(counting.email, key, { counter: 0 })).status).toBe(401);
  });
});

describe('the step-up and removing a passkey', () => {
  it('a passkey answers the step-up (for removing a factor), and a stranger’s or a spent challenge does not', async () => {
    const user = await newUser();
    const session = sessionOf(user);
    const key = device();
    const other = device();
    const { done } = await register(session, key);
    await register(session, other, 'Phone');
    const id = done.body.factor.id as string;

    // Needs a check first.
    expect((await call(factorRoute.DELETE, `/api/me/mfa/${id}`, { session, method: 'DELETE' }, { id })).status).toBe(403);

    const start = await call(optionsRoute.POST, '/api/me/mfa/passkeys/options', { session, body: { purpose: 'step-up' } });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const stranger = await call(stepUpRoute.POST, '/api/me/mfa/step-up', { session, body: { method: 'webauthn', challenge: start.body.challenge, response: device().get(start.body.options) } });
    expect(stranger.status).toBe(401);
    // The failed try spent that challenge; a new one is needed.
    const second = await call(optionsRoute.POST, '/api/me/mfa/passkeys/options', { session, body: { purpose: 'step-up' } });
    const ok = await call(stepUpRoute.POST, '/api/me/mfa/step-up', { session, body: { method: 'webauthn', challenge: second.body.challenge, response: key.get(second.body.options) } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const replay = await call(stepUpRoute.POST, '/api/me/mfa/step-up', { session, body: { method: 'webauthn', challenge: second.body.challenge, response: key.get(second.body.options) } });
    expect(replay.status).toBe(401);

    expect((await call(factorRoute.DELETE, `/api/me/mfa/${id}`, { session, method: 'DELETE' }, { id })).status).toBe(200);
    expect(factorRow(id)).toBeUndefined();
    expect(factors.methodsFor(user.id)).toContain('webauthn');
  });

  it('a register challenge is no step-up, and a sign-in challenge is no registration', async () => {
    const user = await newUser();
    const session = sessionOf(user);
    const key = device();
    await register(session, key);
    const start = await call(optionsRoute.POST, '/api/me/mfa/passkeys/options', { session, body: { purpose: 'register', password: PASSWORD } });
    const asStepUp = await call(stepUpRoute.POST, '/api/me/mfa/step-up', { session, body: { method: 'webauthn', challenge: start.body.challenge, response: key.get({ challenge: start.body.options.challenge, rpId: 'landflow.example.test' }) } });
    expect(asStepUp.status).toBe(401);
    const { first, options } = await signInOptions(user.email);
    const asRegister = await call(passkeysRoute.POST, '/api/me/mfa/passkeys', { session, body: { challenge: first.body.challenge, name: 'X', response: device().create({ challenge: options.body.options.challenge, rp: { id: 'landflow.example.test' } }) } });
    expect(asRegister.status).toBe(400);
  });

  it('removing the last factor drops the recovery codes, like any factor', async () => {
    const user = await newUser();
    const session = sessionOf(user);
    const key = device();
    const { done } = await register(session, key);
    const start = await call(optionsRoute.POST, '/api/me/mfa/passkeys/options', { session, body: { purpose: 'step-up' } });
    expect((await call(stepUpRoute.POST, '/api/me/mfa/step-up', { session, body: { method: 'webauthn', challenge: start.body.challenge, response: key.get(start.body.options) } })).status).toBe(200);
    const id = done.body.factor.id as string;
    expect((await call(factorRoute.DELETE, `/api/me/mfa/${id}`, { session, method: 'DELETE' }, { id })).status).toBe(200);
    expect(factors.methodsFor(user.id)).toEqual([]);
  });
});

describe('what reaches the audit log', () => {
  it('records adding a passkey with its kind and id and nothing from the credential or the challenge', async () => {
    const user = await newUser();
    const session = sessionOf(user);
    const key = device();
    const { started, done } = await register(session, key, 'Audit me');
    const added = queryEvents({ action: ['auth.mfa_added'] }).events.filter((e) => e.target?.id === user.id);
    expect(added.length).toBeGreaterThan(0);
    const text = JSON.stringify(added);
    expect(text).toContain('webauthn');
    for (const secret of [key.id, started.body.challenge, started.body.options.challenge, session]) expect(text).not.toContain(secret);
    expect(done.body.factor.id).toBeTruthy();
  });
});

describe('review fixes', () => {
  async function enrolledKey(role: 'owner' | 'admin' | 'member' = 'member') {
    const user = await newUser(role);
    const key = device();
    const { done } = await register(sessionOf(user), key);
    expect(done.status).toBe(201);
    return { user, key, factorId: done.body.factor.id as string };
  }

  it('lets the fifth answer through when it is right (four wrong ones before it)', async () => {
    const { user, key } = await enrolledKey();
    const { first } = await signInOptions(user.email);
    for (let i = 0; i < 4; i++) {
      const options = await call(signInOptionsRoute.POST, '/api/auth/mfa/options', { body: { challenge: first.body.challenge } });
      expect((await verify(first.body.challenge, key.get(options.body.options, { origin: 'https://evil.example.test' }))).status).toBe(401);
    }
    const options = await call(signInOptionsRoute.POST, '/api/auth/mfa/options', { body: { challenge: first.body.challenge } });
    expect(options.status).toBe(200);
    expect((await verify(first.body.challenge, key.get(options.body.options))).status).toBe(200);
  });

  it('does not count a flagged passkey as a factor: the policy asks to enrol, the last usable one stays, the flagged one can go', async () => {
    const { user, key, factorId } = await enrolledKey('admin');
    // Flag it: a clone's lower counter.
    const first = await signInOptions(user.email);
    expect((await verify(first.first.body.challenge, key.get(first.options.body.options, { counter: 10 }))).status).toBe(200);
    const second = await signInOptions(user.email);
    expect((await verify(second.first.body.challenge, key.get(second.options.body.options, { counter: 5 }))).status).toBe(401);
    expect(factorRow(factorId)?.flagged_at).toBeTruthy();
    process.env.LANDFLOW_MFA_REQUIRED = 'admins';
    try {
      expect(policy.enrolmentRequired(user, 'password')).toBe(true);
      // Add a usable one; the policy is satisfied; removing it is refused while the flagged one stays; the flagged one goes freely.
      const session = sessionOf(user);
      const good = device();
      const added = await register(session, good, 'Good');
      expect(added.done.status).toBe(201);
      expect(policy.enrolmentRequired(user, 'password')).toBe(false);
      const start = await call(optionsRoute.POST, '/api/me/mfa/passkeys/options', { session, body: { purpose: 'step-up' } });
      expect((await call(stepUpRoute.POST, '/api/me/mfa/step-up', { session, body: { method: 'webauthn', challenge: start.body.challenge, response: good.get(start.body.options) } })).status).toBe(200);
      const goodId = added.done.body.factor.id as string;
      const refused = await call(factorRoute.DELETE, `/api/me/mfa/${goodId}`, { session, method: 'DELETE' }, { id: goodId });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('mfa_required_by_policy');
      expect((await call(factorRoute.DELETE, `/api/me/mfa/${factorId}`, { session, method: 'DELETE' }, { id: factorId })).status).toBe(200);
    } finally {
      delete process.env.LANDFLOW_MFA_REQUIRED;
    }
  });

  it('still asks a user whose only passkey is flagged for a second step, with the recovery codes as the way', async () => {
    const { user, key } = await enrolledKey();
    const a = await signInOptions(user.email);
    await verify(a.first.body.challenge, key.get(a.options.body.options, { counter: 10 }));
    const b = await signInOptions(user.email);
    await verify(b.first.body.challenge, key.get(b.options.body.options, { counter: 5 }));
    const login = await call(loginRoute.POST, '/api/auth/login', { body: { email: user.email, password: PASSWORD } });
    expect(login.status).toBe(202);
    expect(login.body.methods).toEqual(['recovery']);
  });

  it('adds up to ten passkeys and one set of recovery codes even when finishes run in parallel', async () => {
    const fresh = await newUser();
    const begin = async (u: typeof fresh) => {
      const started = await webauthn.registrationOptions(u);
      return { token: started.challenge, response: device().create(started.options) };
    };
    const [a, b] = await Promise.all([begin(fresh), begin(fresh)]);
    const done = await Promise.all([webauthn.finishRegistration(fresh, a.token, 'A', a.response), webauthn.finishRegistration(fresh, b.token, 'B', b.response)]);
    expect(done.filter((r) => r.recoveryCodes).length).toBe(1);

    const full = await newUser();
    const session = sessionOf(full);
    for (let i = 0; i < 9; i++) expect((await register(session, device(), `K${i}`)).done.status).toBe(201);
    const [c, d] = await Promise.all([begin(full), begin(full)]);
    const results = await Promise.allSettled([webauthn.finishRegistration(full, c.token, 'C', c.response), webauthn.finishRegistration(full, d.token, 'D', d.response)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(factors.listFactors(full.id).filter((f) => f.kind === 'webauthn')).toHaveLength(10);
  });

  it('answers 409 to register options outside development when LANDFLOW_PUBLIC_URL is not set', async () => {
    const user = await newUser();
    const session = sessionOf(user);
    const url = process.env.LANDFLOW_PUBLIC_URL;
    delete process.env.LANDFLOW_PUBLIC_URL;
    process.env.LANDFLOW_PROFILE = 'production';
    try {
      const refused = await call(optionsRoute.POST, '/api/me/mfa/passkeys/options', { session, body: { purpose: 'register', password: PASSWORD } });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatch(/LANDFLOW_PUBLIC_URL/);
      process.env.LANDFLOW_PROFILE = 'development';
      expect((await call(optionsRoute.POST, '/api/me/mfa/passkeys/options', { session, body: { purpose: 'register', password: PASSWORD } })).status).toBe(200);
    } finally {
      delete process.env.LANDFLOW_PROFILE;
      process.env.LANDFLOW_PUBLIC_URL = url;
    }
  });
});
