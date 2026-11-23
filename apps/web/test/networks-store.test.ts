/**
 * C29 T-1: networks and runners. A network has a unique name and an optional project; a runner's token is `lf_run_…`,
 * returned once, only its SHA-256 stored, the hint its last four characters; the token authenticates until revoked and
 * from the addresses the runner allows; a member lists only the networks of their projects; every change is audited
 * and no event holds the token; a runner connected and then unseen is audited as disconnected (D16).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-networks-store-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const auth = await import('@/lib/server/auth');
const { database } = await import('@/lib/server/db');
const projects = await import('@/lib/server/projects');
const store = await import('@/lib/server/networks/store');
const { tokenHash } = await import('@/lib/server/auth/passwords');
const { queryEvents } = await import('@/lib/server/audit/store');
const queryAudit = (options: { limit: number }) => queryEvents({}, options);

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

let n = 0;
const make = async (role: 'owner' | 'admin' | 'member') => auth.createUser({ email: `n${++n}@example.test`, name: `N${n}`, role, password: 'a-long-password-1' });
const reqFrom = (token: string | undefined, ip = '10.0.0.5') => new Request('http://localhost:3000/api/runner/v1/poll', { method: 'POST', headers: { ...(token && { authorization: `Bearer ${token}` }), 'x-forwarded-for': ip } });

let admin: Awaited<ReturnType<typeof make>>;
beforeAll(async () => {
  admin = await make('owner');
});

describe('networks', () => {
  it('creates a network with a unique name and an optional project', () => {
    const office = store.createNetwork({ name: 'Office' }, admin);
    expect(office).toMatchObject({ name: 'Office', runners: [] });
    expect(office.projectId).toBeUndefined();
    expect(() => store.createNetwork({ name: 'Office' }, admin)).toThrow(/already/);
    const project = projects.createTeamProject({ name: 'Ops', createdBy: admin.id });
    expect(store.createNetwork({ name: 'Ops VPC', projectId: project.id }, admin)).toMatchObject({ projectId: project.id, projectName: 'Ops' });
    expect(() => store.createNetwork({ name: 'Lost', projectId: 'prj_nope' }, admin)).toThrow(/project/i);
  });

  it('shows a member only the networks of their projects and the instance-wide ones', async () => {
    const member = await make('member');
    const mine = projects.createTeamProject({ name: 'Mine', createdBy: admin.id });
    projects.setMember(mine.id, member.id, 'builder');
    store.createNetwork({ name: 'Mine VPC', projectId: mine.id }, admin);
    store.createNetwork({ name: 'Hidden VPC', projectId: projects.createTeamProject({ name: 'Other', createdBy: admin.id }).id }, admin);
    const names = store.listNetworks(member).map((net) => net.name);
    expect(names).toContain('Mine VPC');
    expect(names).toContain('Office');
    expect(names).not.toContain('Hidden VPC');
    expect(store.listNetworks(admin).map((net) => net.name)).toContain('Hidden VPC');
  });
});

describe('runners', () => {
  it('returns the token once and keeps only its SHA-256', () => {
    const net = store.createNetwork({ name: 'Token net' }, admin);
    const { runner, token } = store.registerRunner(net.id, { name: 'office-1' }, admin);
    expect(token).toMatch(/^lf_run_[A-Za-z0-9]{32}$/);
    expect(runner.hint).toBe(token.slice(-4));
    const row = database().get<{ token_hash: string }>('SELECT token_hash FROM network_runners WHERE id = ?', runner.id);
    expect(row?.token_hash).toBe(tokenHash(token));
    expect(JSON.stringify(database().all('SELECT * FROM network_runners'))).not.toContain(token);
    // A later read never carries it.
    expect(JSON.stringify(store.listNetworks(admin))).not.toContain(token);
  });

  it('authenticates a good token and refuses a wrong, missing or revoked one', () => {
    const net = store.createNetwork({ name: 'Auth net' }, admin);
    const { runner, token } = store.registerRunner(net.id, { name: 'a' }, admin);
    expect(store.authenticateRunner(reqFrom(token))?.id).toBe(runner.id);
    expect(store.authenticateRunner(reqFrom('lf_run_nope'))).toBeUndefined();
    expect(store.authenticateRunner(reqFrom(undefined))).toBeUndefined();
    // An API key is not a runner token.
    expect(store.authenticateRunner(reqFrom('lf_abcdefghijklmnopqrstuvwxyz012345'))).toBeUndefined();
    store.revokeRunner(net.id, runner.id, admin);
    expect(store.authenticateRunner(reqFrom(token))).toBeUndefined();
    expect(store.listNetworks(admin).find((x) => x.id === net.id)?.runners[0]).toMatchObject({ status: 'revoked' });
  });

  it('refuses a token from an address outside the runner’s allow-list', () => {
    const net = store.createNetwork({ name: 'Ip net' }, admin);
    const { token } = store.registerRunner(net.id, { name: 'a', allowedIps: ['10.20.0.0/16'] }, admin);
    expect(store.authenticateRunner(reqFrom(token, '10.20.1.1'))).toBeDefined();
    expect(store.authenticateRunner(reqFrom(token, '203.0.113.9'))).toBeUndefined();
    expect(() => store.registerRunner(net.id, { name: 'b', allowedIps: ['not an ip'] }, admin)).toThrow();
  });

  it('is online when seen in the last 30 seconds, offline after', () => {
    const net = store.createNetwork({ name: 'Presence net' }, admin);
    const { runner } = store.registerRunner(net.id, { name: 'a' }, admin);
    const view = () => store.listNetworks(admin).find((x) => x.id === net.id)!.runners[0];
    expect(view().status).toBe('offline');
    const now = Date.now();
    store.markSeen(runner.id, { version: '0.1.0', address: '10.0.0.5' }, now);
    expect(view()).toMatchObject({ status: 'online', version: '0.1.0', address: '10.0.0.5' });
    expect(store.onlineRunnerCount(net.id, now + 10_000)).toBe(1);
    expect(store.onlineRunnerCount(net.id, now + 31_000)).toBe(0);
  });

  it('audits registered, revoked, connected, disconnected and deleted, never the token', async () => {
    const net = store.createNetwork({ name: 'Audit net' }, admin);
    const { runner, token } = store.registerRunner(net.id, { name: 'a' }, admin);
    const now = Date.now();
    store.markSeen(runner.id, { version: '1' }, now - 120_000); // connected
    store.listNetworks(admin, now); // unseen for 2 minutes: disconnected
    store.revokeRunner(net.id, runner.id, admin);
    store.deleteNetwork(net.id, admin);
    const actions = queryAudit({ limit: 200 }).events.map((e) => e.action);
    for (const action of ['network.created', 'network.runner.registered', 'network.runner.connected', 'network.runner.disconnected', 'network.runner.revoked', 'network.deleted']) expect(actions).toContain(action);
    expect(JSON.stringify(queryAudit({ limit: 200 }).events)).not.toContain(token);
  });

  it('deleting a network revokes its runners', () => {
    const net = store.createNetwork({ name: 'Gone net' }, admin);
    const { token } = store.registerRunner(net.id, { name: 'a' }, admin);
    store.deleteNetwork(net.id, admin);
    expect(store.authenticateRunner(reqFrom(token))).toBeUndefined();
    expect(store.getNetwork(net.id)).toBeUndefined();
  });
});
