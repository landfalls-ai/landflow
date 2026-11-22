/**
 * C16 / P15a: the sign-in second step. A correct password for a user with a factor answers 202 with a single-use
 * challenge and no cookie; POST /api/auth/mfa/verify makes the session (`password+totp`, `password+recovery`). A reused,
 * expired or burnt challenge, a replayed code and the sign-in limits all refuse; a reset link doesn't skip the factor;
 * no secret, code or challenge reaches the audit log; users without a factor sign in as before.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { call, sessionCookie } from './mfa-helpers';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-mfa-signin-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://localhost:3000' };
const UNSET = ['LANDFLOW_OWNER_EMAIL', 'LANDFLOW_OWNER_PASSWORD', 'LANDFLOW_SMTP_HOST', 'LANDFLOW_LOGIN_MAX_ATTEMPTS', 'LANDFLOW_MFA_REQUIRED', 'LANDFLOW_LOCAL_SIGN_IN'];
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
for (const key of UNSET) delete process.env[key];

const auth = await import('@/lib/server/auth');
const factors = await import('@/lib/server/auth/mfa/factors');
const totp = await import('@/lib/server/auth/mfa/totp');
const { authDb } = await import('@/lib/server/auth/db');
const { tokenHash } = await import('@/lib/server/auth/passwords');
const { setMailTransport } = await import('@/lib/server/auth/mail');
const { queryEvents } = await import('@/lib/server/audit/store');
const { createResetToken } = await import('@/lib/server/auth/tokens');
const loginRoute = await import('@/app/api/auth/login/route');
const verifyRoute = await import('@/app/api/auth/mfa/verify/route');
const resetRoute = await import('@/app/api/auth/password/reset/route');

const sent: Array<{ to: string; subject: string; text: string }> = [];
beforeAll(() => {
  auth.disableTestAuth();
  vi.useFakeTimers({ toFake: ['Date'] });
  setMailTransport({ send: async (message) => void sent.push(message) });
});
afterAll(() => {
  vi.useRealTimers();
  auth.enableTestAuth();
  setMailTransport(undefined);
  for (const key of [...Object.keys(ENV), ...UNSET]) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});
beforeEach(() => {
  sent.length = 0;
});
afterEach(() => {});

const PASSWORD = 'a-long-password-1';
let counter = 0;

/** A user with an authenticator app (and recovery codes) already confirmed. */
async function enrolled() {
  const user = await auth.createUser({ email: `u${++counter}@example.test`, name: `User ${counter}`, role: counter === 1 ? 'owner' : 'member', password: PASSWORD });
  const started = factors.startTotp(user);
  const confirmed = await factors.confirmTotp(user, started.factorId, totp.totpAt(started.secret, totp.stepAt()));
  expect(confirmed.ok).toBe(true);
  return { user, secret: started.secret, codes: confirmed.recoveryCodes! };
}

/** The code for a step nobody has used yet: two steps on from the last. */
function freshCode(secret: string): string {
  vi.setSystemTime(Date.now() + 60_000);
  return totp.totpAt(secret, totp.stepAt());
}

const login = (email: string, password = PASSWORD) => call(loginRoute.POST, '/api/auth/login', { body: { email, password } });
const verify = (challenge: string, method: 'totp' | 'recovery', code: string) => call(verifyRoute.POST, '/api/auth/mfa/verify', { body: { challenge, method, code } });
const sessionMethod = (token: string) => authDb().get<{ method: string; mfa_verified_at: string | null }>('SELECT method, mfa_verified_at FROM sessions WHERE id = ?', tokenHash(token));

describe('the second step', () => {
  it('answers 202 with a challenge and no cookie, then a session `password+totp` for the current code', async () => {
    const { user, secret } = await enrolled();
    const first = await login(user.email);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ mfaRequired: true, methods: ['totp', 'recovery'] });
    expect(typeof first.body.challenge).toBe('string');
    expect(first.response.headers.getSetCookie()).toEqual([]);
    expect(first.body.user).toBeUndefined();

    const done = await verify(first.body.challenge, 'totp', freshCode(secret));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const token = sessionCookie(done.response)!;
    expect(sessionMethod(token)).toMatchObject({ method: 'password+totp' });
    expect(sessionMethod(token)?.mfa_verified_at).toBeTruthy();
    expect(done.body.user.email).toBe(user.email);
  });

  it('signs a user without a factor in as before', async () => {
    const plain = await auth.createUser({ email: 'plain@example.test', name: 'Plain', role: 'member', password: PASSWORD });
    const result = await login(plain.email);
    expect(result.status).toBe(200);
    expect(sessionMethod(sessionCookie(result.response)!)).toMatchObject({ method: 'password' });
  });

  it('answers a wrong password exactly as it does for a user without a factor (no hint of a factor)', async () => {
    const { user } = await enrolled();
    const wrong = await login(user.email, 'not-the-password');
    const unknown = await login('nobody@example.test', 'not-the-password');
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('refuses a challenge that was used, one that is six minutes old, and one with a bad token', async () => {
    const { user, secret } = await enrolled();
    const challenge = (await login(user.email)).body.challenge as string;
    expect((await verify(challenge, 'totp', freshCode(secret))).status).toBe(200);
    const again = await verify(challenge, 'totp', freshCode(secret));
    expect(again.status).toBe(401);
    expect(again.body.error).toMatch(/Sign in again/);

    const old = (await login(user.email)).body.challenge as string;
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect((await verify(old, 'totp', totp.totpAt(secret, totp.stepAt()))).status).toBe(401);
    expect((await verify('x'.repeat(43), 'totp', '123456')).status).toBe(401);
  });

  it('refuses a code that was used already (replay) and audits the failure with ids only', async () => {
    const { user, secret } = await enrolled();
    const code = freshCode(secret);
    const one = (await login(user.email)).body.challenge as string;
    expect((await verify(one, 'totp', code)).status).toBe(200);
    const two = (await login(user.email)).body.challenge as string;
    const replay = await verify(two, 'totp', code);
    expect(replay.status).toBe(401);
    const failed = queryEvents({ action: ['auth.sign_in_failed'] }).events.filter((e) => e.target?.id === user.id);
    expect(failed.length).toBeGreaterThan(0);
    const text = JSON.stringify(failed);
    expect(text).toContain('"reason":"mfa"');
    for (const secretText of [code, secret, two, one]) expect(text).not.toContain(secretText);
  });

  it('burns a challenge after five wrong codes', async () => {
    const { user, secret } = await enrolled();
    const challenge = (await login(user.email)).body.challenge as string;
    for (let i = 0; i < 4; i++) expect((await verify(challenge, 'totp', '000000')).status).toBe(401);
    const fifth = await verify(challenge, 'totp', '000000');
    expect(fifth.body.error).toMatch(/Sign in again/);
    expect((await verify(challenge, 'totp', freshCode(secret))).status).toBe(401);
  });

  it('takes a recovery code once, says how many are left, emails the person and records it', async () => {
    const { user, codes } = await enrolled();
    const challenge = (await login(user.email)).body.challenge as string;
    const done = await verify(challenge, 'recovery', codes[0].toLowerCase());
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.recoveryCodesLeft).toBe(9);
    expect(sessionMethod(sessionCookie(done.response)!)).toMatchObject({ method: 'password+recovery' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: user.email });
    expect(sent[0].text).toContain('9 left');
    expect(sent[0].text).not.toContain(codes[0]);
    expect(queryEvents({ action: ['auth.mfa_recovery_used'] }).events.some((e) => e.target?.id === user.id)).toBe(true);

    const second = (await login(user.email)).body.challenge as string;
    expect((await verify(second, 'recovery', codes[0])).status).toBe(401);
  });

  it('a password reset link sets the password but the session still needs the second factor', async () => {
    const { user, secret } = await enrolled();
    const { token } = createResetToken(user, user.id);
    const reset = await call(resetRoute.POST, '/api/auth/password/reset', { body: { token, password: 'a-new-password-2' } });
    expect(reset.status).toBe(202);
    expect(reset.response.headers.getSetCookie()).toEqual([]);
    const done = await verify(reset.body.challenge, 'totp', freshCode(secret));
    expect(done.status).toBe(200);
    const row = queryEvents({ action: ['auth.sign_in'] }).events.find((e) => e.target?.id === user.id && String(e.details?.via) === 'reset');
    expect(row).toBeDefined();
  });

  it('counts wrong codes against the sign-in limits: 429 after ten for one email', async () => {
    const { user } = await enrolled();
    let last = 0;
    for (let round = 0; round < 3 && last !== 429; round++) {
      const challenge = (await login(user.email)).body?.challenge as string | undefined;
      if (!challenge) {
        last = 429;
        break;
      }
      for (let i = 0; i < 5; i++) last = (await verify(challenge, 'totp', '000000')).status;
    }
    expect(last).toBe(429);
    const blocked = await login(user.email);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toHaveProperty('retryAfter');
  });
});
