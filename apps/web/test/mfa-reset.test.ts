/**
 * C16 / P15a: an owner's or admin's reset of another person's second factors (DELETE /api/users/<id>/mfa). Owners reset
 * anyone's but their own; admins reset members' and other admins', never an owner's; nobody on themselves. It removes the
 * factors and codes, ends the person's sessions and stores `auth.mfa_reset` in the same transaction: with
 * LANDFLOW_AUDIT_FAIL_CLOSED and the audit log down it answers 503 and changes nothing. GET /api/users shows who has one.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { call } from './mfa-helpers';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-mfa-reset-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const UNSET = ['LANDFLOW_OWNER_EMAIL', 'LANDFLOW_OWNER_PASSWORD', 'LANDFLOW_AUDIT_FAIL_CLOSED', 'LANDFLOW_MFA_REQUIRED'];
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
for (const key of UNSET) delete process.env[key];

const auth = await import('@/lib/server/auth');
const factors = await import('@/lib/server/auth/mfa/factors');
const totp = await import('@/lib/server/auth/mfa/totp');
const { database } = await import('@/lib/server/db');
const { queryEvents } = await import('@/lib/server/audit/store');
const resetRoute = await import('@/app/api/users/[id]/mfa/route');
const usersRoute = await import('@/app/api/users/route');

let broken: ReturnType<typeof vi.spyOn> | undefined;
beforeAll(() => auth.disableTestAuth());
afterEach(() => {
  broken?.mockRestore();
  broken = undefined;
  delete process.env.LANDFLOW_AUDIT_FAIL_CLOSED;
});
afterAll(() => {
  auth.enableTestAuth();
  for (const key of [...Object.keys(ENV), ...UNSET]) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

let n = 0;
const make = async (role: 'owner' | 'admin' | 'member', withFactor = false) => {
  const user = await auth.createUser({ email: `r${++n}@example.test`, name: `R${n}`, role, password: 'a-long-password-1' });
  if (withFactor) {
    const started = factors.startTotp(user);
    await factors.confirmTotp(user, started.factorId, totp.totpAt(started.secret, totp.stepAt()));
  }
  return user;
};
const session = (user: Awaited<ReturnType<typeof make>>) => auth.createSession(user, 'password').token;
const reset = (as: string, id: string) => call(resetRoute.DELETE, `/api/users/${id}/mfa`, { method: 'DELETE', session: as }, { id });
const count = (id: string) => Number(database().get<{ n: number }>('SELECT COUNT(*) AS n FROM user_mfa_factors WHERE user_id = ?', id)?.n);

describe('admin reset of second factors', () => {
  it('lets an admin reset a member: factors and codes go, their sessions end and the event is high-value audited', async () => {
    const admin = await make('admin');
    const member = await make('member', true);
    const memberSession = session(member);
    const done = await reset(session(admin), member.id);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(count(member.id)).toBe(0);
    expect(database().get('SELECT 1 FROM user_recovery_codes WHERE user_id = ?', member.id)).toBeUndefined();
    expect(auth.sessionUser(memberSession)).toBeUndefined();
    const event = queryEvents({ action: ['auth.mfa_reset'] }).events.find((e) => e.target?.id === member.id);
    expect(event).toBeDefined();
    expect(JSON.stringify(event)).not.toMatch(/secret|code_hash/i);
  });

  it('follows the roles: admins reset admins but never the owner; the owner resets admins; nobody resets themselves', async () => {
    const owner = await make('owner', true);
    const admin = await make('admin', true);
    const otherAdmin = await make('admin', true);
    expect((await reset(session(admin), owner.id)).status).toBe(403);
    expect(count(owner.id)).toBe(1);
    expect((await reset(session(admin), otherAdmin.id)).status).toBe(200);
    expect((await reset(session(owner), admin.id)).status).toBe(200);
    expect((await reset(session(owner), owner.id)).status).toBe(400);
    expect((await reset(session(owner), 'usr_missing')).status).toBe(404);
    const member = await make('member');
    expect((await reset(session(member), admin.id)).status).toBe(403);
  });

  it('answers 503 and changes nothing when the audit log is down and fail-closed is on', async () => {
    const admin = await make('admin');
    const member = await make('member', true);
    const memberSession = session(member);
    const db = database();
    const real = db.insertNew.bind(db);
    broken = vi.spyOn(db, 'insertNew').mockImplementation(((table: string, row: Record<string, unknown>) => {
      if (table === 'audit_events') throw new Error('database or disk is full');
      return real(table as never, row as never);
    }) as never);
    process.env.LANDFLOW_AUDIT_FAIL_CLOSED = 'true';
    const refused = await reset(session(admin), member.id);
    expect(refused.status).toBe(503);
    expect(count(member.id)).toBe(1);
    expect(auth.sessionUser(memberSession)).toBeDefined();
  });

  it('shows in the user list who has a second factor', async () => {
    const owner = await make('admin');
    const member = await make('member', true);
    const list = await call(usersRoute.GET, '/api/users', { session: session(owner) });
    expect(list.body.users.find((u: { id: string }) => u.id === member.id)).toMatchObject({ mfaFactors: 1 });
    expect(list.body.users.find((u: { id: string }) => u.id === owner.id).mfaFactors).toBeUndefined();
  });
});
