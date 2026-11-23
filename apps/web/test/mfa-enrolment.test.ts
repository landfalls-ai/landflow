/**
 * C16 / P15a: adding and removing your own factors and the policy that asks for one. LANDFLOW_MFA_REQUIRED (`off` by
 * default, `admins`, `all`): a covered local session without a factor reaches only the enrolment routes (403
 * `mfa_enrolment_required` elsewhere); SSO sessions, API keys and members outside the mode are never asked; the routes
 * are session-only; removing a factor and new recovery codes need a second-factor check from the last five minutes.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { call, request } from './mfa-helpers';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-mfa-enrol-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const UNSET = ['LANDFLOW_OWNER_EMAIL', 'LANDFLOW_OWNER_PASSWORD', 'LANDFLOW_SMTP_HOST', 'LANDFLOW_LOGIN_MAX_ATTEMPTS', 'LANDFLOW_MFA_REQUIRED', 'LANDFLOW_LOCAL_SIGN_IN'];
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
for (const key of UNSET) delete process.env[key];

const auth = await import('@/lib/server/auth');
const { guardRequest } = await import('@/lib/server/auth/guard');
const { routePolicy } = await import('@/lib/server/auth/policy');
const { authDb } = await import('@/lib/server/auth/db');
const totp = await import('@/lib/server/auth/mfa/totp');
const { SECRET_KEY } = await import('@/lib/server/telemetry/config');
const { queryEvents } = await import('@/lib/server/audit/store');
const { catalogEntry } = await import('@/lib/server/config/catalog');
const meRoute = await import('@/app/api/me/mfa/route');
const totpRoute = await import('@/app/api/me/mfa/totp/route');
const confirmRoute = await import('@/app/api/me/mfa/totp/[id]/confirm/route');
const factorRoute = await import('@/app/api/me/mfa/[id]/route');
const stepUpRoute = await import('@/app/api/me/mfa/step-up/route');
const codesRoute = await import('@/app/api/me/mfa/recovery-codes/route');
const workflowsRoute = await import('@/app/api/workflows/route');

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
const newUser = (role: 'owner' | 'admin' | 'member') => auth.createUser({ email: `e${++n}@example.test`, name: `E${n}`, role, password: PASSWORD });
const guard = (path: string, session: string, method = 'GET') => guardRequest(request(path, { method, session }));
const later = () => vi.setSystemTime(Date.now() + 60_000);
const codeFor = (secret: string) => (later(), totp.totpAt(secret, totp.stepAt()));

/** Add and confirm an authenticator app through the routes, as the signed-in person. */
async function enrol(session: string) {
  const started = await call(totpRoute.POST, '/api/me/mfa/totp', { session, body: { password: PASSWORD } });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const confirmed = await call(confirmRoute.POST, `/api/me/mfa/totp/${started.body.factorId}/confirm`, { session, body: { code: codeFor(started.body.secret) } }, { id: started.body.factorId });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  return { factorId: started.body.factorId as string, secret: started.body.secret as string, codes: confirmed.body.recoveryCodes as string[] | undefined };
}

describe('the policy', () => {
  it('defaults to off: nobody is asked, in any role', async () => {
    const owner = await newUser('owner');
    const { token } = auth.createSession(owner, 'password');
    expect(guard('/api/workflows', token).ok).toBe(true);
  });

  it('under admins an admin without a factor can only enrol; a member is not covered; under all a member is', async () => {
    const admin = await newUser('admin');
    const member = await newUser('member');
    const adminSession = auth.createSession(admin, 'password').token;
    const memberSession = auth.createSession(member, 'password').token;
    // The session existed before the mode was switched on.
    process.env.LANDFLOW_MFA_REQUIRED = 'admins';
    const refused = guard('/api/workflows', adminSession);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.response.status).toBe(403);
      expect(await refused.response.json()).toMatchObject({ code: 'mfa_enrolment_required' });
    }
    expect(guard('/api/auth/me', adminSession).ok).toBe(true);
    expect(guard('/api/me/mfa', adminSession).ok).toBe(true);
    expect(guard('/api/me/mfa/totp', adminSession, 'POST').ok).toBe(true);
    expect(guard('/api/workflows', memberSession).ok).toBe(true);

    process.env.LANDFLOW_MFA_REQUIRED = 'all';
    expect(guard('/api/workflows', memberSession).ok).toBe(false);

    // After confirming a factor the session works.
    process.env.LANDFLOW_MFA_REQUIRED = 'admins';
    await enrol(adminSession);
    expect(guard('/api/workflows', adminSession).ok).toBe(true);
    expect(((await call(workflowsRoute.GET, '/api/workflows', { session: adminSession })).status)).toBe(200);
    delete process.env.LANDFLOW_MFA_REQUIRED;
  });

  it('never asks a single sign-on session, and never an API key', async () => {
    const owner = await newUser('admin');
    process.env.LANDFLOW_MFA_REQUIRED = 'all';
    const sso = auth.createSession(owner, 'oidc').token;
    expect(guard('/api/workflows', sso).ok).toBe(true);
    const saml = auth.createSession(owner, 'saml').token;
    expect(guard('/api/workflows', saml).ok).toBe(true);
    const { token } = auth.createApiKey(owner, { label: 'CI', scopes: ['admin'] });
    expect(guardRequest(request('/api/workflows', { key: token })).ok).toBe(true);
    // And an API key can't reach the factor routes at all.
    const viaKey = guardRequest(request('/api/me/mfa', { key: token }));
    expect(viaKey.ok).toBe(false);
    if (!viaKey.ok) expect(viaKey.response.status).toBe(403);
    delete process.env.LANDFLOW_MFA_REQUIRED;
  });

  it('has a policy entry for the routes, and the catalog names the variable', async () => {
    expect(routePolicy('GET', '/api/me/mfa')).toMatchObject({ scope: 'any', sessionOnly: true });
    expect(routePolicy('DELETE', '/api/me/mfa/abc')).toMatchObject({ scope: 'any', sessionOnly: true });
    expect(catalogEntry('LANDFLOW_MFA_REQUIRED')).toMatchObject({ group: 'auth', default: '`off`' });
  });

  it('redacts recovery codes and challenges by key name', () => {
    expect(SECRET_KEY.test('recoveryCodes')).toBe(true);
    expect(SECRET_KEY.test('challenge')).toBe(true);
  });
});

describe('your factors', () => {
  it('starts, confirms (with recovery codes once), lists without a secret and audits it', async () => {
    const user = await newUser('member');
    const session = auth.createSession(user, 'password').token;
    const started = await call(totpRoute.POST, '/api/me/mfa/totp', { session, body: { password: PASSWORD } });
    expect(started.body.qr).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(started.body.otpauthUrl).toContain(started.body.secret);

    const wrong = await call(confirmRoute.POST, `/api/me/mfa/totp/${started.body.factorId}/confirm`, { session, body: { code: '000000' } }, { id: started.body.factorId });
    expect(wrong.status).toBe(400);
    const confirmed = await call(confirmRoute.POST, `/api/me/mfa/totp/${started.body.factorId}/confirm`, { session, body: { code: codeFor(started.body.secret) } }, { id: started.body.factorId });
    expect(confirmed.body.recoveryCodes).toHaveLength(10);

    const state = await call(meRoute.GET, '/api/me/mfa', { session });
    expect(state.body).toMatchObject({ recoveryCodesLeft: 10, mode: 'off', covered: false, enrolmentRequired: false, recentlyVerified: true, canEnrol: true });
    expect(state.body.factors).toHaveLength(1);
    expect(JSON.stringify(state.body)).not.toContain(started.body.secret);
    expect(queryEvents({ action: ['auth.mfa_added'] }).events.some((e) => e.target?.id === user.id)).toBe(true);
    // A second authenticator app is refused while one is there.
    expect((await call(totpRoute.POST, '/api/me/mfa/totp', { session, body: { password: PASSWORD } })).status).toBe(409);
  });

  it('refuses to remove a factor without a recent check, then removes it after a step-up and drops the codes', async () => {
    const user = await newUser('member');
    const session = auth.createSession(user, 'password').token;
    const { factorId, secret } = await enrol(session);
    vi.setSystemTime(Date.now() + 6 * 60_000);
    const refused = await call(factorRoute.DELETE, `/api/me/mfa/${factorId}`, { session, method: 'DELETE' }, { id: factorId });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('mfa_step_up_required');

    expect((await call(stepUpRoute.POST, '/api/me/mfa/step-up', { session, body: { method: 'totp', code: '000000' } })).status).toBe(401);
    const up = await call(stepUpRoute.POST, '/api/me/mfa/step-up', { session, body: { method: 'totp', code: codeFor(secret) } });
    expect(up.status).toBe(200);
    expect((await call(factorRoute.DELETE, `/api/me/mfa/${factorId}`, { session, method: 'DELETE' }, { id: factorId })).status).toBe(200);
    expect(authDb().get('SELECT 1 FROM user_recovery_codes WHERE user_id = ?', user.id)).toBeUndefined();
    expect((await call(meRoute.GET, '/api/me/mfa', { session })).body.factors).toEqual([]);
    expect(queryEvents({ action: ['auth.mfa_removed'] }).events.some((e) => e.target?.id === user.id)).toBe(true);
  });

  it('keeps the last factor of an admin while the policy covers them (409)', async () => {
    const admin = await newUser('admin');
    const session = auth.createSession(admin, 'password').token;
    process.env.LANDFLOW_MFA_REQUIRED = 'admins';
    const { factorId } = await enrol(session);
    const refused = await call(factorRoute.DELETE, `/api/me/mfa/${factorId}`, { session, method: 'DELETE' }, { id: factorId });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('mfa_required_by_policy');
    delete process.env.LANDFLOW_MFA_REQUIRED;
  });

  it('makes a new set of recovery codes after a step-up, and the old set stops working', async () => {
    const user = await newUser('member');
    const session = auth.createSession(user, 'password').token;
    const { secret, codes } = await enrol(session);
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect((await call(codesRoute.POST, '/api/me/mfa/recovery-codes', { session, method: 'POST', body: {} })).status).toBe(403);
    expect((await call(stepUpRoute.POST, '/api/me/mfa/step-up', { session, body: { method: 'totp', code: codeFor(secret) } })).status).toBe(200);
    const fresh = await call(codesRoute.POST, '/api/me/mfa/recovery-codes', { session, method: 'POST', body: {} });
    expect(fresh.status).toBe(200);
    expect(fresh.body.recoveryCodes).toHaveLength(10);
    const { useRecoveryCode } = await import('@/lib/server/auth/mfa/recovery');
    expect(await useRecoveryCode(user.id, codes![0])).toEqual({ ok: false });
    expect(await useRecoveryCode(user.id, fresh.body.recoveryCodes[0])).toMatchObject({ ok: true });
    expect(queryEvents({ action: ['auth.mfa_recovery_regenerated'] }).events.length).toBeGreaterThan(0);
  });

  it('does not let an account without a password enrol (single sign-on accounts use their provider)', async () => {
    const sso = await auth.createUser({ email: `sso${++n}@example.test`, name: 'Sso', role: 'member', oidc: { issuer: 'https://idp.test', subject: 'abc' } });
    const session = auth.createSession(sso, 'oidc').token;
    expect((await call(totpRoute.POST, '/api/me/mfa/totp', { session, body: { password: PASSWORD } })).status).toBe(409);
    expect((await call(meRoute.GET, '/api/me/mfa', { session })).body.canEnrol).toBe(false);
  });
});
