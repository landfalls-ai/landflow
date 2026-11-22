/**
 * C16 review fixes: an enrol-only session (a covered account with no second factor yet) is not a signed-in person on the
 * public routes that read the session cookie themselves: the MCP endpoint, the hosted waiting form (where a session
 * would skip the signed link) and the health probe's counts. Also: the admin reset route and the factor routes refuse API
 * keys, and an authenticator app needs the account's password to start (a stolen session can't enrol its own).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Workflow } from '@landflow/engine';
import { call, request } from './mfa-helpers';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-mfa-public-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://localhost:3000', LANDFLOW_RESUME_SIGNATURES: 'required' };
const UNSET = ['LANDFLOW_OWNER_EMAIL', 'LANDFLOW_OWNER_PASSWORD', 'LANDFLOW_MFA_REQUIRED', 'LANDFLOW_LOGIN_MAX_ATTEMPTS'];
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
for (const key of UNSET) delete process.env[key];

const auth = await import('@/lib/server/auth');
const { guardRequest } = await import('@/lib/server/auth/guard');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { database } = await import('@/lib/server/db');
const { waits } = await import('@/lib/server/waits');
const identity = await import('@/lib/server/mcp/identity');
const formRoute = await import('@/app/form/[...path]/route');
const formWaitingRoute = await import('@/app/form/waiting/[id]/route');
const healthRoute = await import('@/app/api/health/route');
const totpRoute = await import('@/app/api/me/mfa/totp/route');
const resetRoute = await import('@/app/api/users/[id]/mfa/route');
registry.registerBuiltin(corePlugin);

beforeAll(() => auth.disableTestAuth());
afterAll(() => {
  waits.stop();
  auth.enableTestAuth();
  for (const key of [...Object.keys(ENV), ...UNSET]) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const PASSWORD = 'a-long-password-1';
let n = 0;
const newUser = (role: 'owner' | 'admin' | 'member') => auth.createUser({ email: `p${++n}@example.test`, name: `P${n}`, role, password: PASSWORD });
const params = <T>(value: T) => ({ params: Promise.resolve(value) });

describe('an enrol-only session on the public routes that read the cookie', () => {
  it('does not skip the resume signature of a waiting form', async () => {
    const admin = await newUser('admin');
    const normal = auth.createSession(admin, 'password').token;
    store.saveWorkflow({
      id: 'wf_mfa_form',
      name: 'wf_mfa_form',
      active: true,
      nodes: [
        { id: 'Form', name: 'Form', type: 'core.formTrigger', typeVersion: 1, position: [0, 0], parameters: { path: 'mfa-form', formTitle: 'Sign up', formFields: { values: [{ fieldLabel: 'Name', fieldType: 'text' }] } } },
        { id: 'Details', name: 'Details', type: 'core.form', typeVersion: 1, position: [200, 0], parameters: { operation: 'page', formTitle: 'Details', formFields: { values: [{ fieldLabel: 'Email', fieldType: 'text' }] } } },
      ],
      connections: [{ id: 'e0', type: 'main', source: 'Form', target: 'Details', sourceIndex: 0, targetIndex: 0 }],
    } as unknown as Workflow);
    const body = new URLSearchParams({ f0: 'Ada' });
    const first = await formRoute.POST(new Request('http://localhost:3000/form/mfa-form', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } }), params({ path: ['mfa-form'] }));
    expect(first.status).toBe(303);
    const id = first.headers.get('location')!.split('/').at(-1)!.split('?')[0];
    const bare = `/form/waiting/${id}`;
    // Nobody: the unsigned address is refused. A signed-in admin passes without the signature.
    expect((await formWaitingRoute.GET(request(bare), params({ id }))).status).toBe(403);
    expect((await formWaitingRoute.GET(request(bare, { session: normal }), params({ id }))).status).toBe(200);
    // Now the policy covers admins, who have no factor: the same session is no one here.
    process.env.LANDFLOW_MFA_REQUIRED = 'admins';
    expect((await formWaitingRoute.GET(request(bare, { session: normal }), params({ id }))).status).toBe(403);
    delete process.env.LANDFLOW_MFA_REQUIRED;
  });

  it('is refused by the MCP endpoint (403), while a full session is accepted', async () => {
    const admin = await newUser('admin');
    const session = auth.createSession(admin, 'password').token;
    const ask = () => identity.authenticateMcpRequest(request('/api/mcp', { session }), { pluginId: '' });
    expect(await ask()).toMatchObject({ kind: 'session' });
    process.env.LANDFLOW_MFA_REQUIRED = 'admins';
    await expect(ask()).rejects.toMatchObject({ status: 403 });
    delete process.env.LANDFLOW_MFA_REQUIRED;
  });

  it('gets no counts from the health probe', async () => {
    const admin = await newUser('admin');
    const session = auth.createSession(admin, 'password').token;
    const probe = async () => (await healthRoute.GET(request('/api/health', { session }))).json() as Promise<Record<string, unknown>>;
    expect(await probe()).toHaveProperty('plugins');
    process.env.LANDFLOW_MFA_REQUIRED = 'admins';
    expect(await probe()).toEqual({ status: 'ok' });
    delete process.env.LANDFLOW_MFA_REQUIRED;
  });
});

describe('who may reach the factor routes', () => {
  it('refuses an admin API key on the reset route (session only), though the role would allow it', async () => {
    const admin = await newUser('admin');
    const member = await newUser('member');
    const { token } = auth.createApiKey(admin, { label: 'CI', scopes: ['admin'] });
    const refused = guardRequest(request(`/api/users/${member.id}/mfa`, { method: 'DELETE', key: token }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.response.status).toBe(403);
    const viaKey = await call(resetRoute.DELETE, `/api/users/${member.id}/mfa`, { method: 'DELETE', key: token }, { id: member.id });
    expect(viaKey.status).toBe(403);
  });

  it('needs the account’s password to start an authenticator app', async () => {
    const user = await newUser('member');
    const session = auth.createSession(user, 'password').token;
    const count = () => Number(database().get<{ n: number }>('SELECT COUNT(*) AS n FROM user_mfa_factors WHERE user_id = ?', user.id)?.n);
    const none = await call(totpRoute.POST, '/api/me/mfa/totp', { session, method: 'POST', body: {} });
    expect(none.status).toBe(400);
    const wrong = await call(totpRoute.POST, '/api/me/mfa/totp', { session, body: { password: 'not-the-password' } });
    expect(wrong.status).toBe(403);
    expect(count()).toBe(0);
    const right = await call(totpRoute.POST, '/api/me/mfa/totp', { session, body: { password: PASSWORD } });
    expect(right.status).toBe(201);
    expect(count()).toBe(1);
  });
});
