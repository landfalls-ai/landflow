/**
 * C35 (docs/access-requests.md#grants-and-removal): the minute pass and the hourly reconcile of the `access grants` service. `now` is passed in.
 * Grants are made through the real flow and the fake GitHub and Google.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });
const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-access-sweeper-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const { makeWorld } = await import('./fixtures/access-world');
const { createRequest, decideAccessRequest, cancelRequest } = await import('@/lib/server/access/requests');
const { markDone, revokeNow, removeGrant } = await import('@/lib/server/access/grants');
const { sweepGrants, reconcileGrants } = await import('@/lib/server/access/sweeper');
const { grantRow, grantOfRequest } = await import('@/lib/server/access/store');
const { queryEvents } = await import('@/lib/server/audit/store');
const { database } = await import('@/lib/server/db');

const w = await makeWorld();
const { mia, ola, ann, lead, admin, team, manual, fake, mails } = w;
w.captureMail();
const audited = (action: string) => queryEvents({ action: [action] }, { limit: 200 }).events;
const MIN = 60_000;

let n = 0;
/** A live grant for `user` on the team for `minutes` (the real flow). */
async function granted(user = mia, minutes: number | null = 15, entryId = team.id) {
  const login = `sweep-${++n}`;
  for (const open of database().all<{ id: string }>(`SELECT id FROM access_requests WHERE entry_id = ? AND requester_id = ? AND status = 'pending'`, entryId, user.id)) await cancelRequest(admin, open.id);
  const request = await createRequest(user, { entryId, durationMinutes: minutes, reason: 'Sweeper test', account: login });
  const decided = await decideAccessRequest(ann, request.id, { approved: true, ...(minutes !== null && { choice: String(minutes) }) });
  return { login, grant: grantRow(decided.grant!.id)!, requestId: request.id };
}
const inTeam = (login: string) => Object.hasOwn(fake.members('teams', 'acme/platform'), login);
const untilOf = (id: string) => Date.parse(grantRow(id)!.until!);

describe('the minute pass', () => {
  it('removes a grant at its end, marks it expired, audits it and tells the person; leaves the rest', async () => {
    const a = await granted(mia, 15);
    const b = await granted(ola, 60);
    const u = await granted(w.lead, null);
    mails.length = 0;
    expect(await sweepGrants(untilOf(a.grant.id) - 1)).toEqual({ removed: 0, retried: 0 });
    expect(await sweepGrants(untilOf(a.grant.id) + 1)).toEqual({ removed: 1, retried: 0 });
    expect(inTeam(a.login)).toBe(false);
    expect(inTeam(b.login)).toBe(true);
    expect(inTeam(u.login)).toBe(true);
    expect(grantRow(a.grant.id)).toMatchObject({ status: 'expired', end_reason: 'expired', lease_until: null });
    expect(audited('access.grant.revoke').some((e) => e.target?.id === a.grant.id && (e.details as { reason: string }).reason === 'expired')).toBe(true);
    await vi.waitFor(() => expect(mails.some((m) => m.to === 'mia@landflow.test' && /ended/i.test(m.subject))).toBe(true));
    // Unlimited grants never end by themselves.
    expect(await sweepGrants(Date.now() + 400 * 86_400_000)).toMatchObject({ removed: 1 });
    expect(inTeam(u.login)).toBe(true);
    await revokeNow(admin, u.grant.id);
  });

  it('keeps access the person already had, and says so', async () => {
    fake.seedTeam('acme', 'platform', { 'veteran-gh': 'member' });
    const request = await createRequest(ola, { entryId: team.id, durationMinutes: 15, reason: 'Sweeper test', account: 'veteran-gh' });
    const decided = await decideAccessRequest(ann, request.id, { approved: true, choice: '15' });
    expect(decided.grant).toMatchObject({ alreadyHad: true, status: 'active' });
    await sweepGrants(untilOf(decided.grant!.id) + 1);
    expect(inTeam('veteran-gh')).toBe(true);
    expect(grantRow(decided.grant!.id)).toMatchObject({ status: 'expired', last_error: expect.stringMatching(/not taken back/) });
    fake.seedTeam('acme', 'platform');
  });

  it('retries a failed removal after 1 minute, then 2, 4 … never past an hour, and succeeds on a later pass', async () => {
    const a = await granted(mia, 15);
    const end = untilOf(a.grant.id);
    fake.down = true;
    expect(await sweepGrants(end + 1)).toMatchObject({ removed: 1 });
    let row = grantRow(a.grant.id)!;
    expect(row).toMatchObject({ status: 'revoke_failed', attempts: 1, last_error: expect.stringMatching(/not reachable/) });
    expect(Date.parse(row.next_attempt_at!) - (end + 1)).toBe(1 * MIN);
    // Too early: nothing.
    expect(await sweepGrants(end + 1 + MIN - 1)).toMatchObject({ retried: 0 });
    let now = end + 1 + MIN;
    for (const [attempts, wait] of [[2, 2], [3, 4], [4, 8], [5, 16], [6, 32], [7, 60], [8, 60]] as const) {
      expect(await sweepGrants(now)).toMatchObject({ retried: 1 });
      row = grantRow(a.grant.id)!;
      expect(row.attempts).toBe(attempts);
      expect(Date.parse(row.next_attempt_at!) - now).toBe(wait * MIN);
      now += wait * MIN;
    }
    expect(audited('access.grant.revoke_failed').filter((e) => e.target?.id === a.grant.id).length).toBe(8);
    fake.down = false;
    expect(await sweepGrants(now)).toMatchObject({ retried: 1 });
    expect(grantRow(a.grant.id)).toMatchObject({ status: 'expired' });
    expect(inTeam(a.login)).toBe(false);
  });

  it('a manual grant at its end waits for a person: the approver is asked to remove it by hand, Done ends it', async () => {
    const request = await createRequest(mia, { entryId: manual.id, durationMinutes: 60, reason: 'Edit the launch deck' });
    const decided = await decideAccessRequest(ann, request.id, { approved: true, choice: '60' });
    await markDone(ann, decided.grant!.id);
    mails.length = 0;
    const end = untilOf(decided.grant!.id);
    expect(await sweepGrants(end + 1)).toMatchObject({ removed: 1 });
    expect(grantRow(decided.grant!.id)).toMatchObject({ status: 'removing' });
    await vi.waitFor(() => expect(mails.some((m) => m.to === 'ann@landflow.test' && /remove by hand/i.test(m.subject))).toBe(true));
    expect(await sweepGrants(end + 2 * MIN)).toMatchObject({ removed: 0 });
    expect(await markDone(ann, decided.grant!.id)).toMatchObject({ status: 'expired' });
  });
});

describe('the hourly reconcile', () => {
  it('takes again a removal whose process stopped (the lease ran out)', async () => {
    const a = await granted(mia, 15);
    // A process claimed the removal and stopped: the row says `removing` with a lease that ran out.
    const gone = Date.now() - 1;
    database().upsert('access_grants', { ...grantRow(a.grant.id)!, status: 'removing', end_reason: 'expired', lease_until: new Date(gone).toISOString() } as never);
    expect(inTeam(a.login)).toBe(true);
    expect(await reconcileGrants(Date.now())).toMatchObject({ retaken: 1 });
    expect(inTeam(a.login)).toBe(false);
    expect(grantRow(a.grant.id)).toMatchObject({ status: 'expired' });
  });

  it('does not take a removal that is still leased', async () => {
    const a = await granted(mia, 15);
    database().upsert('access_grants', { ...grantRow(a.grant.id)!, status: 'removing', end_reason: 'expired', lease_until: new Date(Date.now() + 5 * MIN).toISOString() } as never);
    expect(await reconcileGrants(Date.now())).toMatchObject({ retaken: 0 });
    expect(inTeam(a.login)).toBe(true);
    database().upsert('access_grants', { ...grantRow(a.grant.id)!, status: 'active', lease_until: null } as never);
    await revokeNow(admin, a.grant.id);
  });

  it('notices a member removed outside Landflow: drift, audited, not added back', async () => {
    const a = await granted(ola, 60);
    fake.teams.get('acme/platform')!.delete(a.login);
    const result = await reconcileGrants(Date.now() + 2 * 3_600_000);
    expect(result.drift).toBe(1);
    expect(grantRow(a.grant.id)).toMatchObject({ status: 'drift' });
    expect(inTeam(a.login)).toBe(false);
    expect(audited('access.grant.drift').some((e) => e.target?.id === a.grant.id)).toBe(true);
    // A second pass changes nothing.
    expect(await reconcileGrants(Date.now() + 4 * 3_600_000)).toMatchObject({ drift: 0 });
    await revokeNow(admin, a.grant.id);
  });

  it('checks a live grant once an hour, not every pass', async () => {
    const a = await granted(ola, 60);
    const t = Date.now();
    fake.calls.length = 0;
    // (The grant was checked once before it was added, so the first hourly check is an hour on.)
    await reconcileGrants(t + 61 * MIN);
    const first = fake.calls.filter((c) => c.operation === 'get').length;
    expect(first).toBeGreaterThanOrEqual(1);
    await reconcileGrants(t + 91 * MIN);
    expect(fake.calls.filter((c) => c.operation === 'get').length).toBe(first);
    await revokeNow(admin, a.grant.id);
  });

  it('says once, loudly, when access is still in place a day after its end', async () => {
    const a = await granted(mia, 15);
    const end = untilOf(a.grant.id);
    fake.down = true;
    await sweepGrants(end + 1);
    fake.down = false;
    const before = audited('access.grant.revoke_overdue').filter((e) => e.target?.id === a.grant.id).length;
    const noted = () => audited('access.grant.revoke_overdue').filter((e) => e.target?.id === a.grant.id).length;
    await reconcileGrants(end + 23 * 3_600_000);
    expect(noted()).toBe(before);
    await reconcileGrants(end + 25 * 3_600_000);
    expect(noted()).toBe(before + 1);
    await reconcileGrants(end + 26 * 3_600_000);
    expect(noted()).toBe(before + 1);
    await sweepGrants(end + 27 * 3_600_000);
    expect(inTeam(a.login)).toBe(false);
  });
});

describe('revoking now', () => {
  it('starts clean', async () => {
    for (const live of database().all<{ id: string }>(`SELECT id FROM access_grants WHERE status IN ('active', 'revoke_failed', 'drift')`)) await revokeNow(admin, live.id);
  });

  it('lets the holder give it back, and an owner, an approver or an admin take it back; others get a 404', async () => {
    const give = await granted(mia, 60);
    const done = await revokeNow(mia, give.grant.id);
    expect(done.status).toBe('revoked');
    expect(grantRow(give.grant.id)).toMatchObject({ end_reason: 'given_back', ended_by: mia.id });
    expect(inTeam(give.login)).toBe(false);

    for (const [who, label] of [[lead, 'owner'], [ann, 'approver'], [admin, 'admin']] as const) {
      const g = await granted(ola, 60);
      await revokeNow(who, g.grant.id);
      expect(grantRow(g.grant.id), label).toMatchObject({ status: 'revoked', end_reason: 'revoked', ended_by: who.id });
      expect(inTeam(g.login), label).toBe(false);
    }
    const mine = await granted(ola, 60);
    await expect(revokeNow(mia, mine.grant.id)).rejects.toMatchObject({ status: 404 });
    expect(inTeam(mine.login)).toBe(true);
    await expect(revokeNow(ola, 'ag_missing')).rejects.toMatchObject({ status: 404 });
    await revokeNow(ola, mine.grant.id);
    await expect(revokeNow(ola, mine.grant.id)).rejects.toMatchObject({ status: 409 });
  });

  it('two removals at once remove once', async () => {
    const a = await granted(mia, 60);
    const [x, y] = await Promise.all([removeGrant(a.grant.id, 'revoked', admin.id), removeGrant(a.grant.id, 'revoked', lead.id)]);
    // The one that lost the claim answers the winner's row, whatever state it was in then.
    expect([x?.status, y?.status]).toContain('revoked');
    expect(fake.calls.filter((c) => c.operation === 'remove' && c.parameters.username === a.login)).toHaveLength(1);
    expect(grantOfRequest(a.requestId)!.status).toBe('revoked');
  });
});
