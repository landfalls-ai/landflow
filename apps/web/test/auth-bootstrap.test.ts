/**
 * The owner from the environment (Docker, CI, a dev restart): with LANDFLOW_OWNER_EMAIL and LANDFLOW_OWNER_PASSWORD
 * set, the first request's bootstrap creates the owner, so there is no setup page and the owner can sign in. Once a
 * user exists the variables are ignored.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-auth-bootstrap-'));
const ENV: Record<string, string> = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_OWNER_EMAIL: ' Admin@Landflow.Test ',
  LANDFLOW_OWNER_PASSWORD: 'env-owner-password',
  LANDFLOW_OWNER_NAME: 'Env Owner',
};
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const auth = await import('@/lib/server/auth');
const { bootstrapOwnerFromEnv } = await import('@/lib/server/auth/bootstrap');
const statusRoute = await import('@/app/api/auth/status/route');
const loginRoute = await import('@/app/api/auth/login/route');

type Route = (request: Request) => Promise<Response>;
const BASE = 'http://localhost:3000';

afterAll(() => {
  auth.enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe('owner from the environment', () => {
  it('is created on boot: no setup step, and the owner signs in', async () => {
    auth.disableTestAuth();
    const status = await (await (statusRoute.GET as Route)(new Request(`${BASE}/api/auth/status`))).json();
    expect(status.setupRequired).toBe(false);
    const owner = auth.findUserByEmail('admin@landflow.test');
    expect(owner).toMatchObject({ role: 'owner', name: 'Env Owner' });

    const login = await (loginRoute.POST as Route)(
      new Request(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@landflow.test', password: 'env-owner-password' }) }),
    );
    expect(login.status).toBe(200);
    expect((await login.json()).user).toMatchObject({ role: 'owner', email: 'admin@landflow.test' });
  });

  it('is ignored once a user exists (changing the variables changes nothing)', async () => {
    process.env.LANDFLOW_OWNER_EMAIL = 'someone-else@landflow.test';
    process.env.LANDFLOW_OWNER_PASSWORD = 'another-password';
    await bootstrapOwnerFromEnv();
    expect(auth.findUserByEmail('someone-else@landflow.test')).toBeUndefined();
    expect(auth.countUsers()).toBe(1);
  });
});
