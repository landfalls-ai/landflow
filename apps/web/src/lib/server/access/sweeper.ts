/**
 * The `access grants` leader service (docs/access-requests.md#grants-and-removal): every minute it takes back grants that reached
 * their end; every hour it reconciles. Each grant is claimed with one conditional update (store.ts `claimGrant`), so a second process
 * can't remove the same grant. At most 100 grants a pass.
 *
 * - minute: `active` and `until <= now` -> removed (`expired`); `revoke_failed` whose `next_attempt_at` passed -> tried again
 *   (1 min, then doubling, up to 1 h); a manual grant at its end becomes `removing` and its approvers are asked to remove it by hand.
 * - hour: `removing` whose lease ran out (a process stopped) -> taken again; each live automatic grant is checked with the system:
 *   gone outside Landflow -> `drift` (audited, never re-added); still there 24 h after its end -> `revoke_overdue` once.
 */
import { recordAudit } from '../audit';
import { database } from '../db';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';
import { runAction } from './actions';
import { removeGrant, OVERDUE_MS, type EndReason } from './grants';
import { claimGrant, grantRow, parseJson, type GrantRow } from './store';
import { SYSTEMS } from './systems';

const PASS_LIMIT = 100;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

export interface SweepResult {
  removed: number;
  retried: number;
}

/** The minute pass. `now` is passed in by tests. */
export async function sweepGrants(now = Date.now()): Promise<SweepResult> {
  const result: SweepResult = { removed: 0, retried: 0 };
  const due = database().all<GrantRow>(`SELECT * FROM access_grants WHERE status = 'active' AND until IS NOT NULL AND until <= ? ORDER BY until LIMIT ?`, iso(now), PASS_LIMIT);
  for (const grant of due) {
    await removeGrant(grant.id, 'expired', undefined, now);
    result.removed++;
  }
  const retry = database().all<GrantRow>(`SELECT * FROM access_grants WHERE status = 'revoke_failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?`, iso(now), PASS_LIMIT);
  for (const grant of retry) {
    const reason = (['expired', 'given_back', 'revoked'].includes(grant.end_reason ?? '') ? grant.end_reason : 'expired') as EndReason;
    await removeGrant(grant.id, reason, undefined, now);
    result.retried++;
  }
  return result;
}

export interface ReconcileResult {
  retaken: number;
  drift: number;
  overdue: number;
}

/** The hourly pass. */
export async function reconcileGrants(now = Date.now()): Promise<ReconcileResult> {
  const result: ReconcileResult = { retaken: 0, drift: 0, overdue: 0 };
  // A process that stopped mid-removal left `removing` with a lease that ran out.
  const stale = database().all<GrantRow>(`SELECT * FROM access_grants WHERE status = 'removing' AND system <> 'manual' AND lease_until IS NOT NULL AND lease_until <= ? LIMIT ?`, iso(now), PASS_LIMIT);
  for (const grant of stale) {
    const reason = (['expired', 'given_back', 'revoked'].includes(grant.end_reason ?? '') ? grant.end_reason : 'expired') as EndReason;
    await removeGrant(grant.id, reason, undefined, now);
    result.retaken++;
  }
  // Still there long after it should be gone: said once, loudly.
  const late = database().all<GrantRow>(`SELECT * FROM access_grants WHERE overdue_noted = 0 AND (status IN ('removing', 'revoke_failed') OR (status = 'active' AND until IS NOT NULL)) LIMIT ?`, PASS_LIMIT * 5);
  for (const grant of late) {
    const ended = grant.status === 'active' ? Date.parse(grant.until ?? '') : Date.parse(grant.updated_at);
    if (!Number.isFinite(ended) || now - ended < OVERDUE_MS) continue;
    // A grant that is `removing` or `revoke_failed` keeps its original end in `until` when it has one.
    const end = grant.until ? Date.parse(grant.until) : ended;
    if (now - end < OVERDUE_MS) continue;
    database().upsert('access_grants', { ...grant, overdue_noted: 1 } as never);
    recordAudit({ action: 'access.grant.revoke_overdue', target: { type: 'access_grant', id: grant.id }, project: null, summary: 'Access is still in place more than a day after it should have ended', details: { from: grant.status, to: grant.status, until: grant.until ?? null } });
    result.overdue++;
  }
  // Each live automatic grant: is the person still in it? Not re-added when they are not.
  const live = database().all<GrantRow>(`SELECT * FROM access_grants WHERE status = 'active' AND system <> 'manual' AND (checked_at IS NULL OR checked_at <= ?) ORDER BY checked_at LIMIT ?`, iso(now - HOUR + MINUTE), PASS_LIMIT);
  for (const grant of live) {
    if (!SYSTEMS[grant.system as keyof typeof SYSTEMS]?.checks) continue;
    const config = parseJson<{ config: Record<string, string> }>(grant.target, { config: {} }).config;
    try {
      const state = await runAction({ system: grant.system as never, config, credentialId: grant.credential_id, account: grant.account ?? '' }, 'check');
      const current = grantRow(grant.id);
      if (!current || current.status !== 'active') continue;
      if (state.state === 'none' && Number(grant.already_had) === 0) {
        const { won } = await claimGrant(grant.id, 'active', { status: 'drift', checked_at: iso(now), last_error: 'The person is no longer in it; it was removed outside Landflow' });
        if (won) {
          recordAudit({ action: 'access.grant.drift', target: { type: 'access_grant', id: grant.id }, project: null, summary: 'Access was removed outside Landflow', details: { from: 'active', to: 'drift' } });
          result.drift++;
        }
      } else database().upsert('access_grants', { ...current, checked_at: iso(now) } as never);
    } catch (error) {
      logger.warn('an access check failed', { error: (error as Error).message });
    }
  }
  return result;
}

export const accessGrants = singleton('access-grants-service', () => {
  let minute: ReturnType<typeof setInterval> | undefined;
  let hour: ReturnType<typeof setInterval> | undefined;
  const guarded = (name: string, fn: () => Promise<unknown>) => () => void fn().catch((error: Error) => logger.warn(`access ${name} failed`, { error: error.message }));
  return {
    start() {
      if (minute) return;
      minute = setInterval(guarded('sweep', sweepGrants), MINUTE);
      hour = setInterval(guarded('reconcile', reconcileGrants), HOUR);
      minute.unref?.();
      hour.unref?.();
      // The first pass soon after boot, so a restart does not wait a whole interval.
      setTimeout(guarded('sweep', async () => { await reconcileGrants(); await sweepGrants(); }), 5_000).unref?.();
    },
    stop() {
      if (minute) clearInterval(minute);
      if (hour) clearInterval(hour);
      minute = hour = undefined;
    },
  };
});
