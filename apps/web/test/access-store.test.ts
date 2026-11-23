/**
 * C35 (docs/access-requests.md): migration 2935, the shared words (state, duration text, the durations an approver may
 * shorten to) and the two claims every state change goes through.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '@/lib/shared/audit';
import { durationText, requestState, shorterDurations, type GrantStatus, type RequestStatus } from '@/lib/shared/access';

const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-access-store-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const { database } = await import('@/lib/server/db');
const store = await import('@/lib/server/access/store');

const now = '2030-01-01T00:00:00.000Z';
const request = (id: string, status: RequestStatus = 'pending'): import('@/lib/server/access/store').RequestRow => ({
  id, entry_id: 'ae_1', entry_version: 1, entry_snapshot: '{}', requester_id: 'u1', account: null, duration_minutes: 60, reason: 'Because', channel: 'form', status, approvers: '[]', workflow_id: null, execution_id: null, decisions: null, approved_minutes: null, note: null, created_at: now, updated_at: now,
});
const grant = (id: string, status: GrantStatus = 'active'): import('@/lib/server/access/store').GrantRow => ({
  id, request_id: 'ar_1', entry_id: 'ae_1', holder_id: 'u1', account: null, system: 'manual', target: '{}', credential_id: null, status, since: now, until: null, approved_by: null, already_had: 0, lease_until: null, attempts: 0, next_attempt_at: null, ended_at: null, ended_by: null, end_reason: null, last_error: null, checked_at: null, overdue_noted: 0, created_at: now, updated_at: now,
});

describe('migration 2935', () => {
  it('creates the four tables', () => {
    for (const table of ['access_entries', 'access_requests', 'access_grants', 'access_accounts']) {
      expect(database().all(`SELECT * FROM ${table}`), table).toEqual([]);
    }
  });
});

describe('the words people see', () => {
  it('names a request state from its status and its grant', () => {
    const states: Array<[RequestStatus, GrantStatus | undefined, string]> = [
      ['pending', undefined, 'waiting'],
      ['approved', undefined, 'approved'],
      ['approved', 'pending', 'approved'],
      ['approved', 'active', 'granted'],
      ['approved', 'removing', 'granted'],
      ['approved', 'revoke_failed', 'granted'],
      ['approved', 'expired', 'expired'],
      ['approved', 'revoked', 'removed'],
      ['approved', 'drift', 'removed'],
      ['approved', 'failed', 'failed'],
      ['denied', undefined, 'denied'],
      ['expired', undefined, 'expired'],
      ['failed', undefined, 'failed'],
      ['cancelled', undefined, 'cancelled'],
    ];
    for (const [status, grantStatus, expected] of states) expect(requestState({ status, ...(grantStatus && { grant: { status: grantStatus } }) }), `${status}/${grantStatus}`).toBe(expected);
  });

  it('writes durations', () => {
    expect(durationText(null)).toBe('unlimited');
    expect(durationText(60)).toBe('1 h');
    expect(durationText(15)).toBe('15 min');
    expect(durationText(1_440)).toBe('1 day');
    expect(durationText(10_080)).toBe('7 days');
    expect(durationText(90)).toBe('1 h 30 min');
  });

  it('offers an approver the asked duration first, then shorter ones', () => {
    expect(shorterDurations([1, 60, 240, null], 60)).toEqual([60, 1]);
    expect(shorterDurations([1, 60, 240, null], null)).toEqual([null, 240, 60, 1]);
    expect(shorterDurations([60, 240], 1)).toEqual([]);
  });
});

describe('claims', () => {
  it('move a request once: the second claim loses and changes nothing', async () => {
    store.insertRequest(request('ar_claim'));
    const first = await store.claimRequest('ar_claim', 'pending', { status: 'approved', note: 'first' });
    expect(first.won).toBe(true);
    const second = await store.claimRequest('ar_claim', 'pending', { status: 'denied', note: 'second' });
    expect(second.won).toBe(false);
    expect(second.row).toMatchObject({ status: 'approved', note: 'first' });
    expect(store.requestRow('ar_claim')).toMatchObject({ status: 'approved', note: 'first' });
  });

  it('move a grant once, and a claim for work sets the lease', async () => {
    store.insertGrant(grant('ag_claim'));
    const now = Date.parse(now0());
    const first = await store.claimGrant('ag_claim', 'active', { status: 'removing' }, { leaseMs: 600_000, now });
    expect(first.won).toBe(true);
    expect(first.row?.lease_until).toBe(new Date(now + 600_000).toISOString());
    expect((await store.claimGrant('ag_claim', 'active', { status: 'removing' }, { leaseMs: 600_000, now })).won).toBe(false);
    expect(store.grantRow('ag_claim')?.status).toBe('removing');
  });

  it('lose a claim on a row that does not exist', async () => {
    expect(await store.claimGrant('ag_missing', 'active', { status: 'removing' })).toEqual({ won: false, row: undefined });
  });

  it('one of two simultaneous claims wins', async () => {
    store.insertRequest(request('ar_race'));
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.claimRequest('ar_race', 'pending', { status: 'approved', note: `n${i}` })));
    expect(results.filter((r) => r.won)).toHaveLength(1);
  });
});

function now0() {
  return '2030-06-01T00:00:00.000Z';
}

describe('audit labels', () => {
  it('has a label for every access event', () => {
    const wanted = ['entry.create', 'entry.update', 'entry.delete', 'request.create', 'request.cancel', 'request.approve', 'request.deny', 'request.expire', 'request.fail', 'grant.activate', 'grant.fail', 'grant.done', 'grant.revoke', 'grant.revoke_failed', 'grant.revoke_overdue', 'grant.drift', 'account.set'];
    for (const action of wanted) expect(AUDIT_ACTIONS[`access.${action}`], action).toBeTruthy();
    expect(AUDIT_ACTIONS['access.setup']).toBeTruthy();
  });
});
