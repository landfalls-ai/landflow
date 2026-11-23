/**
 * C31, the owner's routes (`/api/settings/encryption/project-keys`, `…/[projectId]/rotate`): owner only and session only
 * (an admin, a member, no session and an API key are all refused), status/migrate/revert/rotate answers, and audit
 * as the constitution asks: creating a key never makes a save wait on audit, while rotate, migrate and revert refuse
 * with 503 when `LANDFLOW_AUDIT_FAIL_CLOSED=true` and the audit store is down (and change nothing).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-project-keys-routes-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_ENCRYPTION_KEYS: `k1:${'a1'.repeat(32)}`, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
delete process.env.LANDFLOW_ENCRYPTION_KEY;
delete process.env.LANDFLOW_AUDIT_FAIL_CLOSED;

const { credentials } = await import('@/lib/server/credentials/vault');
const projects = await import('@/lib/server/projects/store');
await import('@/lib/server/projects/boot');
const { database } = await import('@/lib/server/db');
const { disableTestAuth, enableTestAuth, TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { routePolicy } = await import('@/lib/server/auth/policy');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const listRoute = await import('@/app/api/settings/encryption/project-keys/route');
const rotateRoute = await import('@/app/api/settings/encryption/project-keys/[projectId]/rotate/route');
registry.registerBuiltin(corePlugin);

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

const url = 'http://localhost/api/settings/encryption/project-keys';
const post = (body: unknown) => listRoute.POST(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const rotate = (projectId: string) => rotateRoute.POST(new Request(`${url}/${projectId}/rotate`, { method: 'POST' }), { params: Promise.resolve({ projectId }) });

const team = projects.createTeamProject({ name: 'Routes' });
function create(secret: string, projectId = team.id): string {
  const id = credentials.newId();
  projects.setHomeProject('credential', id, projectId);
  credentials.create({ name: secret, type: 'core.httpHeaderAuth', data: { name: 'X-Key', value: secret } }, { id });
  return id;
}

let broken: ReturnType<typeof vi.spyOn> | undefined;
function breakAudit() {
  const db = database();
  const real = db.insertNew.bind(db);
  broken = vi.spyOn(db, 'insertNew').mockImplementation(((table: string, row: Record<string, unknown>) => {
    if (table === 'audit_events') throw new Error('database or disk is full');
    return real(table as never, row as never);
  }) as never);
  process.env.LANDFLOW_AUDIT_FAIL_CLOSED = 'true';
}
afterEach(() => {
  broken?.mockRestore();
  broken = undefined;
  delete process.env.LANDFLOW_AUDIT_FAIL_CLOSED;
  enableTestAuth();
});

describe('who may call them', () => {
  it('are session-only settings:manage routes by policy', () => {
    for (const [method, path] of [['GET', '/api/settings/encryption/project-keys'], ['POST', '/api/settings/encryption/project-keys'], ['POST', '/api/settings/encryption/project-keys/prj_x/rotate']] as const) {
      expect(routePolicy(method, path)).toMatchObject({ action: 'settings:manage', sessionOnly: true });
    }
  });

  it('refuse an admin and a member with 403, and a request with no session', async () => {
    for (const role of ['admin', 'member'] as const) {
      enableTestAuth({ ...TEST_OWNER, id: `usr_${role}`, role });
      expect((await listRoute.GET(new Request(url))).status).toBe(403);
      expect((await post({ action: 'migrate' })).status).toBe(403);
      expect((await rotate(team.id)).status).toBe(403);
    }
    disableTestAuth();
    for (const response of [await listRoute.GET(new Request(url)), await post({ action: 'revert' }), await rotate(team.id)]) expect([401, 403]).toContain(response.status);
  });

  it('refuse an API key through the guard (session only)', async () => {
    const { guardRequest } = await import('@/lib/server/auth/guard');
    disableTestAuth();
    const result = guardRequest(new Request(url, { headers: { authorization: 'Bearer lf_not_a_real_key_0123456789abcdef' } }));
    expect(result.ok).toBe(false);
  });
});

describe('what they do', () => {
  it('status lists the project, its version and its credential count; an unknown action is a 400', async () => {
    create('route-secret-12345678');
    const response = await listRoute.GET(new Request(url));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { projects: Array<{ projectId: string; name?: string; active?: number; credentials: number }>; onRing: number };
    expect(body.projects.find((p) => p.projectId === team.id)).toMatchObject({ name: 'Routes', active: 1, credentials: 1 });
    expect(body.onRing).toBe(0);
    expect((await post({ action: 'shred' })).status).toBe(400);
  });

  it('rotate answers the new version; an unknown project is a 404', async () => {
    const response = await rotate(team.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version: 2, resealed: 1, failed: [], done: true });
    expect((await rotate('prj_missing')).status).toBe(404);
  });

  it('revert then migrate round-trips, and each says whether it is done', async () => {
    const id = create('round-trip-secret-1');
    const reverted = await post({ action: 'revert' });
    expect(await reverted.json()).toMatchObject({ onProjectKeys: 0, done: true });
    expect(credentials.sealedWith(id)).toBe('ring:k1');
    const migrated = await post({ action: 'migrate' });
    expect(await migrated.json()).toMatchObject({ failed: [], done: true });
    expect(credentials.sealedWith(id)).toBe(`dek:${team.id}.2`);
  });
});

describe('the off switch', () => {
  it('creating a credential through the route makes no project key while LANDFLOW_PROJECT_KEYS=off', async () => {
    const fresh = projects.createTeamProject({ name: 'Switched off' });
    const route = await import('@/app/api/credentials/route');
    process.env.LANDFLOW_PROJECT_KEYS = 'off';
    try {
      const response = await route.POST(new Request(`http://localhost/api/credentials?projectId=${fresh.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Off', type: 'core.httpHeaderAuth', data: { name: 'X-Key', value: 'off-secret-12345678' } }) }));
      expect(response.status).toBe(201);
      const { credential } = (await response.json()) as { credential: { id: string } };
      const id = credential.id;
      expect(credentials.sealedWith(id)).toMatch(/^ring:/);
      expect(database().all('SELECT 1 FROM project_keys WHERE project_id = ?', fresh.id)).toEqual([]);
    } finally {
      delete process.env.LANDFLOW_PROJECT_KEYS;
    }
  });
});

describe('audit posture (C31-D5)', () => {
  it('a credential save still works while audit is down: creating its project’s key is fail-open', () => {
    const fresh = projects.createTeamProject({ name: 'Audit down' });
    breakAudit();
    const id = create('audit-down-secret-1', fresh.id);
    expect(credentials.sealedWith(id)).toBe(`dek:${fresh.id}.1`);
    expect(credentials.dataFor({ id, name: 'x' }, 'core.httpHeaderAuth')).toMatchObject({ value: 'audit-down-secret-1' });
  });

  it('rotate, migrate and revert answer 503 and change nothing when audit cannot store the event', async () => {
    const id = create('refused-secret-12345');
    const before = credentials.sealedWith(id);
    breakAudit();
    expect((await rotate(team.id)).status).toBe(503);
    expect((await post({ action: 'migrate' })).status).toBe(503);
    expect((await post({ action: 'revert' })).status).toBe(503);
    expect(credentials.sealedWith(id)).toBe(before);
    expect(projects.getProject(team.id)).toBeTruthy();
    expect(database().all<{ version: number }>('SELECT version FROM project_keys WHERE project_id = ?', team.id).map((r) => Number(r.version))).toEqual([1, 2]); // a refused rotation added no version (1 is retired from the test above, not destroyed)
  });
});
