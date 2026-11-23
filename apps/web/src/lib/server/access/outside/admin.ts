/**
 * What an instance admin does with the people without a Landflow account who have signed in (docs/access-requests.md#signing-in-without-an-account):
 * see them, Block one, Unblock one. A block ends their sessions, cancels their open requests and stops new sign-in links (the answer to
 * the asker stays the same: nothing says they are blocked). Grants they already hold stay until they end or an admin revokes them on
 * the Grants tab. Admins only, audited with the person's address.
 */
import { database } from '../../db';
import { auditedTransaction, recordAudit } from '../../audit';
import { isInstanceAdmin, type Actor } from '../../projects/access';
import { logger } from '../../telemetry/logger';
import { cancelOpenRequestsOf } from '../requests';
import { accountOf } from '../store';
import { AccessError } from '../errors';
import { auditActorOf } from '../rules';
import { endSessionsFor } from './sessions';
import { requesterRow, requesterRows, saveRequester, type RequesterRow } from './store';

export interface OutsideRequesterView {
  id: string;
  email: string;
  name: string | null;
  verifiedBy: 'link' | 'google';
  createdAt: string;
  lastSeenAt: string | null;
  blocked: boolean;
  blockedAt: string | null;
  openRequests: number;
  liveGrants: number;
  /** The GitHub username they typed (unverified), if any; an admin can clear it. */
  github: string | null;
}

/** A grant still in place or on its way to being taken away (the statuses of C35's unique live-target index). */
const LIVE_GRANTS = ['pending', 'active', 'removing', 'revoke_failed', 'drift', 'failed'];

const adminOnly = (actor: Actor) => {
  if (!isInstanceAdmin(actor)) throw new AccessError('Only an owner or admin sees people without a Landflow account', 403);
};

const count = (sql: string, ...params: string[]) => database().get<{ n: number }>(sql, ...params)?.n ?? 0;

function view(row: RequesterRow): OutsideRequesterView {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    verifiedBy: row.verified_by,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    blocked: Boolean(row.blocked_at),
    blockedAt: row.blocked_at,
    github: accountOf(row.id, 'github') ?? null,
    openRequests: count(`SELECT COUNT(*) AS n FROM access_requests WHERE requester_id = ? AND status = 'pending'`, row.id),
    liveGrants: count(`SELECT COUNT(*) AS n FROM access_grants WHERE holder_id = ? AND status IN (${LIVE_GRANTS.map(() => '?').join(', ')})`, row.id, ...LIVE_GRANTS),
  };
}

export function listOutsideRequesters(actor: Actor): OutsideRequesterView[] {
  adminOnly(actor);
  return requesterRows().map(view);
}

const audit = (actor: Actor, action: 'access.outside.block' | 'access.outside.unblock', row: RequesterRow, details: Record<string, unknown>) =>
  recordAudit({
    action,
    actor: auditActorOf(actor),
    target: { type: 'access_outside', id: row.id, name: row.email },
    project: null,
    summary: `${action === 'access.outside.block' ? 'Blocked' : 'Unblocked'} ${row.email} from asking for access`,
    details: { email: row.email, ...details },
  });

/**
 * Block: no more sessions or links, open requests cancelled. Blocking twice is the same block. The requests are cancelled first and the
 * block is then written whether or not that worked (a failure is logged, never a half-finished 500 that left the person unblocked), and
 * once more after the block for a request filed in between.
 */
export async function blockRequester(actor: Actor, id: string): Promise<OutsideRequesterView> {
  adminOnly(actor);
  const row = requesterRow(id);
  if (!row) throw new AccessError('Requester not found', 404);
  const by = auditActorOf(actor);
  const cancelOpen = () => cancelOpenRequestsOf(id, by).catch((error: unknown) => logger.warn('open requests of a blocked requester could not all be cancelled', { requester: id, error: (error as Error).message }));
  await cancelOpen();
  auditedTransaction(() => {
    saveRequester({ ...row, blocked_at: row.blocked_at ?? new Date().toISOString(), blocked_by: row.blocked_by ?? actor.id });
    const sessions = endSessionsFor(id);
    audit(actor, 'access.outside.block', row, { sessions });
  });
  await cancelOpen();
  return view(requesterRow(id)!);
}

/** An admin clears the GitHub username an outside requester typed (it is unverified and one person's, so a wrong or squatted one can be freed). Audited. */
export function clearRequesterGithub(actor: Actor, id: string): OutsideRequesterView {
  adminOnly(actor);
  const row = requesterRow(id);
  if (!row) throw new AccessError('Requester not found', 404);
  const kept = accountOf(id, 'github');
  if (kept) {
    auditedTransaction(() => {
      database().delete('access_accounts', { user_id: id, system: 'github' });
      recordAudit({ action: 'access.account.set', actor: auditActorOf(actor), target: { type: 'user', id }, project: null, summary: `Cleared the GitHub username of ${row.email}`, details: { from: kept, to: null, requesterKind: 'outside', clearedBy: 'admin' } });
    });
  }
  return view(requesterRow(id)!);
}

export function unblockRequester(actor: Actor, id: string): OutsideRequesterView {
  adminOnly(actor);
  const row = requesterRow(id);
  if (!row) throw new AccessError('Requester not found', 404);
  auditedTransaction(() => {
    saveRequester({ ...row, blocked_at: null, blocked_by: null });
    audit(actor, 'access.outside.unblock', row, {});
  });
  return view(requesterRow(id)!);
}
