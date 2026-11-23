/**
 * The lease sweeper (C30, a leader service): leases of runs that are over (or gone) are revoked in one tick (AS-4); a
 * revoke the store refuses is retried on a backoff and done once it is back, and given up only after 24 hours (AS-6);
 * a lease of a running run with under two minutes left is renewed up to an hour after it was issued, and one that
 * runs out first is `expired`; at most 200 rows a tick. The clock is the `now` a tick is given.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeVaultLeases, VAULT_LEASES_TOKEN } from '@landflow/test-fakes/vault-leases';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-leases-sweep-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });
delete process.env.LANDFLOW_ENVIRONMENT;

const { database } = await import('@/lib/server/db');
const secrets = await import('@/lib/server/secrets');
const leases = await import('@/lib/server/secrets/leases');
const { leaseSweeper } = await import('@/lib/server/secrets/lease-sweeper');
const { SERVICES } = await import('@/lib/server/runtime');

const bao = fakeVaultLeases();
const PATH = 'database/creds/report-reader';
const ref = { provider: 'bao', name: PATH };
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

/** A run row of the given status (the sweeper only reads its status). */
const setRun = (id: string, status: string) =>
  database().upsert('executions', { id, workflow_id: 'wf_sweep', status, mode: 'manual', started_at: iso(Date.now() - 5 * MIN), summary: '{}', data: '{}' });
const row = (executionId: string) => database().get<Record<string, string | number | null>>('SELECT * FROM secret_leases WHERE execution_id = ?', executionId)!;
const audits = (action: string) => database().all<{ action: string; outcome: string; actor_type: string }>('SELECT action, outcome, actor_type FROM audit_events WHERE action = ?', action);
const lease = async (executionId: string, status = 'running') => {
  setRun(executionId, status);
  await leases.leasedSecret(ref, { executionId, workflowId: 'wf_sweep' });
  return row(executionId);
};
/** Rewrite a lease's times, as if it had been issued earlier. */
const age = (executionId: string, patch: Record<string, unknown>) => database().upsert('secret_leases', { ...row(executionId), ...patch });

beforeAll(async () => {
  await bao.start();
  secrets.externalSecrets.create({ name: 'bao', kind: 'vault', settings: { url: bao.url, auth: 'token', token: VAULT_LEASES_TOKEN, dynamicMounts: 'database/', leaseTtl: 900 } });
});
beforeEach(() => {
  bao.reset();
  database().delete('secret_leases', { provider: 'bao' });
  database().delete('secret_leases', { provider: 'other' });
});
afterAll(async () => {
  secrets.externalSecrets.closeAll();
  leaseSweeper.stop();
  await bao.stop();
});

describe('the service', () => {
  it('is a leader entry of the service table, on the main only', () => {
    const entry = SERVICES.find((spec) => spec.name === 'secret lease sweeper');
    expect(entry).toMatchObject({ roles: ['main'], leader: true });
  });
});

describe('leases of runs that are over', () => {
  it('revokes the lease of a finished run in one tick, and of a run that is gone (AS-4)', async () => {
    await lease('run_over', 'error');
    await lease('run_gone');
    // Gone: no run row at all, and issued long enough ago not to be a run that has not saved yet.
    database().delete('executions', { id: 'run_gone' });
    age('run_gone', { issued_at: iso(Date.now() - 10 * MIN) });
    expect(Object.keys(bao.state().active)).toHaveLength(2);
    await leaseSweeper.tick();
    expect(bao.state().active).toEqual({});
    expect(row('run_over')).toMatchObject({ state: 'revoked', ended_by: 'sweeper', lease_id: null, lease_values: null });
    expect(row('run_gone').state).toBe('revoked');
    expect(audits('secrets.lease.revoked').map((e) => e.actor_type)).toEqual(['system', 'system']);
  });

  it('leaves the lease of a running or waiting run, and of a run that has not saved yet', async () => {
    await lease('run_running', 'running');
    await lease('run_waiting', 'waiting');
    await lease('run_new');
    database().delete('executions', { id: 'run_new' });
    await leaseSweeper.tick();
    expect(Object.keys(bao.state().active)).toHaveLength(3);
    expect([row('run_running').state, row('run_waiting').state, row('run_new').state]).toEqual(['active', 'active', 'active']);
  });
});

describe('a store that refuses to revoke', () => {
  it('retries on a backoff and revokes once the store is back, without giving up (AS-6)', async () => {
    const start = Date.now();
    await lease('run_retry', 'error');
    bao.down();
    await leaseSweeper.tick(start);
    expect(row('run_retry')).toMatchObject({ state: 'active', attempts: 1, last_error: expect.stringContaining('503') });
    expect(Date.parse(String(row('run_retry').next_attempt_at)) - start).toBe(30_000);
    // Before the next attempt nothing is sent.
    const failed = bao.state().failedRevokes;
    await leaseSweeper.tick(start + 10_000);
    expect(bao.state().failedRevokes).toBe(failed);
    await leaseSweeper.tick(start + 31_000);
    expect(row('run_retry')).toMatchObject({ state: 'active', attempts: 2 });
    expect(Date.parse(String(row('run_retry').next_attempt_at)) - (start + 31_000)).toBe(60_000);
    expect(row('run_retry').lease_id).toMatch(/^v2\./);
    bao.up();
    await leaseSweeper.tick(start + 31_000 + 61_000);
    expect(row('run_retry')).toMatchObject({ state: 'revoked', last_error: null });
    expect(bao.state().active).toEqual({});
  });

  it('caps the backoff at 30 minutes', () => {
    expect([1, 2, 3, 6, 7, 20].map((attempts) => leases.backoffMs(attempts) / 1000)).toEqual([30, 60, 120, 960, 1800, 1800]);
  });

  it('gives up after 24 hours of failures: revoke_failed, an audit event, values dropped, the id kept for an admin’s retry (AS-6)', async () => {
    const start = Date.now();
    await lease('run_giveup', 'error');
    bao.down();
    await leaseSweeper.tick(start);
    age('run_giveup', { failing_since: iso(start - 25 * HOUR), next_attempt_at: null });
    await leaseSweeper.tick(start + MIN);
    expect(row('run_giveup')).toMatchObject({ state: 'revoke_failed', lease_values: null, ended_by: 'sweeper' });
    expect(row('run_giveup').lease_id).toMatch(/^v2\./);
    expect(audits('secrets.lease.revoke_failed')).toEqual([{ action: 'secrets.lease.revoke_failed', outcome: 'failure', actor_type: 'system' }]);
    expect(leases.leaseCounts()).toEqual({ active: 0, revokeFailed: 1 });
    // The sweeper does not try it again; an admin's Revoke now does, and it works once the store is back.
    const failed = bao.state().failedRevokes;
    await leaseSweeper.tick(start + 2 * MIN);
    expect(bao.state().failedRevokes).toBe(failed);
    bao.up();
    const view = await leases.revokeLease(String(row('run_giveup').id), 'admin');
    expect(view).toMatchObject({ state: 'revoked', endedBy: 'admin' });
    expect(leases.leaseCounts().revokeFailed).toBe(0);
  });

  it('lets an admin set a failed lease aside, which removes the banner count but not the row', async () => {
    await lease('run_aside', 'error');
    bao.down();
    await leaseSweeper.tick();
    age('run_aside', { failing_since: iso(Date.now() - 25 * HOUR), next_attempt_at: null });
    await leaseSweeper.tick();
    expect(leases.leaseCounts().revokeFailed).toBe(1);
    await expect(leases.dismissLease(String(row('run_aside').id))).resolves.toMatchObject({ state: 'revoke_failed', dismissed: true });
    expect(leases.leaseCounts().revokeFailed).toBe(0);
    bao.up();
    await lease('run_active_one');
    await expect(leases.dismissLease(String(row('run_active_one').id))).rejects.toThrow(/could not be revoked/);
  });
});

describe('leases that run out and are renewed', () => {
  it('renews the lease of a running run with under two minutes left, and records it', async () => {
    const start = Date.now();
    await lease('run_renew', 'running');
    age('run_renew', { expires_at: iso(start + 90_000) });
    await leaseSweeper.tick(start);
    const issued = bao.state().issued[0];
    expect(issued.renewals).toBe(1);
    expect(issued.increments).toEqual([900]);
    expect(row('run_renew')).toMatchObject({ state: 'active', expires_at: iso(start + 900_000), renewed_until: iso(start + 900_000) });
    // Not renewed again while it has time.
    await leaseSweeper.tick(start + MIN);
    expect(bao.state().issued[0].renewals).toBe(1);
  });

  it('asks for only what is left of the hour, and stops renewing in the last minute of it', async () => {
    const start = Date.now();
    await lease('run_hour', 'running');
    age('run_hour', { issued_at: iso(start - 50 * MIN), expires_at: iso(start + 60_000) });
    await leaseSweeper.tick(start);
    expect(bao.state().issued[0].increments).toEqual([600]);
    // 59.5 minutes in: no renewal that would run past the hour.
    age('run_hour', { issued_at: iso(start - 59.5 * MIN), expires_at: iso(start + 30_000) });
    await leaseSweeper.tick(start);
    expect(bao.state().issued[0].renewals).toBe(1);
    // And when it runs out, it is expired, not revoked at the store (the store removed it itself).
    await leaseSweeper.tick(start + 31_000);
    expect(row('run_hour')).toMatchObject({ state: 'expired', lease_id: null, lease_values: null });
    expect(audits('secrets.lease.expired')).toHaveLength(1);
  });

  it('expires the lease of a waiting run when its time passes (a run is not renewed while it waits)', async () => {
    const start = Date.now();
    await lease('run_wait_expiry', 'waiting');
    age('run_wait_expiry', { expires_at: iso(start + 60_000) });
    await leaseSweeper.tick(start);
    expect(bao.state().issued[0].renewals).toBe(0);
    expect(row('run_wait_expiry').state).toBe('active');
    await leaseSweeper.tick(start + 61_000);
    expect(row('run_wait_expiry').state).toBe('expired');
  });

  it('records a failed renewal and tries again on a backoff', async () => {
    const start = Date.now();
    await lease('run_renew_fail', 'running');
    age('run_renew_fail', { expires_at: iso(start + 60_000) });
    bao.down();
    await leaseSweeper.tick(start);
    expect(row('run_renew_fail')).toMatchObject({ state: 'active', attempts: 1, last_error: expect.stringContaining('503') });
    expect(Date.parse(String(row('run_renew_fail').next_attempt_at)) - start).toBe(30_000);
    bao.up();
    await leaseSweeper.tick(start + 31_000);
    expect(row('run_renew_fail')).toMatchObject({ state: 'active' });
    expect(bao.state().issued[0].renewals).toBe(1);
  });

  it('says "expired" for a lease its store already removed when the run ends late', async () => {
    const start = Date.now();
    await lease('run_late', 'error');
    age('run_late', { expires_at: iso(start - 60_000) });
    // The store removed it at its TTL.
    for (const id of Object.keys(bao.state().active)) await fetch(`${bao.url}/v1/sys/leases/revoke`, { method: 'PUT', headers: { 'x-vault-token': VAULT_LEASES_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ lease_id: id }) });
    await leaseSweeper.tick(start);
    expect(row('run_late').state).toBe('expired');
  });
});

describe('bounds', () => {
  it('handles at most 200 rows a tick, and prunes ended rows after 30 days', async () => {
    const now = Date.now();
    const db = database();
    db.transaction(() => {
      for (let i = 0; i < 250; i++) {
        db.upsert('executions', { id: `bulk_run_${i}`, workflow_id: 'wf_sweep', status: 'success', mode: 'manual', started_at: iso(now - 10 * MIN), summary: '{}', data: '{}' });
        db.insertNew('secret_leases', { id: `bulk_${i}`, execution_id: `bulk_run_${i}`, provider: 'other', path: PATH, state: 'active', issued_at: iso(now - 5 * MIN), expires_at: iso(now + 10 * MIN), attempts: 0 });
      }
      db.insertNew('secret_leases', { id: 'old_ended', execution_id: 'old_run', provider: 'other', path: PATH, state: 'revoked', issued_at: iso(now - 40 * 24 * HOUR), expires_at: iso(now - 40 * 24 * HOUR), attempts: 0, ended_at: iso(now - 35 * 24 * HOUR) });
      db.insertNew('secret_leases', { id: 'old_failed', execution_id: 'old_run2', provider: 'other', path: PATH, state: 'revoke_failed', issued_at: iso(now - 40 * 24 * HOUR), expires_at: iso(now - 40 * 24 * HOUR), attempts: 5, ended_at: iso(now - 35 * 24 * HOUR) });
    });
    const count = (state: string) => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM secret_leases WHERE provider = ? AND state = ?', 'other', state)!.n;
    await leaseSweeper.tick(now);
    expect(count('active')).toBe(50);
    await leaseSweeper.tick(now);
    expect(count('active')).toBe(0);
    // The old revoked row is gone; the failed one stays until an admin looks at it.
    expect(db.get('SELECT id FROM secret_leases WHERE id = ?', 'old_ended')).toBeUndefined();
    expect(db.get('SELECT id FROM secret_leases WHERE id = ?', 'old_failed')).toBeDefined();
  });
});
