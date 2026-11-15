/**
 * The inbox (docs/practices.md#the-inbox): every saved draft version files one suggestion in the second brain's inbox
 * (`source: 'practice'`), shaped like a team's note promotion (notebook/service.ts). It waits for the people who may approve
 * the practice. An approval, a rejection or a retirement on /brain settles it. Apply approves the version, for owners and
 * admins only and never for a draft read from outside: that one links to /brain, where a person reads it against its sources.
 *
 * This file imports neither the store nor approve.ts, which call it (store -> inbox, approve -> inbox): approve.ts hands
 * over what Apply needs with `setInboxDeps`, so no import cycle closes. The applier registers here at import.
 */
import { fingerprintOf, ProposalError, dismissProposal, markApplied, saveProposal, setProposalApplier, upsertProposal, type ApplyOptions } from '../brain/proposals';
import type { AudienceMember, Proposal } from '../../shared/brain';
import { MAX_AUDIENCE } from '../../shared/brain';
import type { Practice, PracticeApproveInput, PracticeVersion } from '../../shared/practices';
import { projectRoleCan } from '../../shared/projects';
import { getUser, listUsers, type UserRecord } from '../auth/users';
import { database, type Database } from '../db';
import { isInstanceAdmin, projectRole } from '../projects/access';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';
import { PracticeConflict } from './errors';

/** Where a practice is read on the Brain page. */
export const practiceHref = (practiceId: string) => `/brain/practices/${practiceId}`;

const DRAFTER = { person: 'A person', learned: 'A repository', agent: 'An agent' } as const;

/** Who may approve a practice (the same rule as approve.ts `canApprove`): org practices, owners and admins; project ones, the project's admins and owners/admins. */
function approvers(practice: Pick<Practice, 'level' | 'projectId'>): UserRecord[] {
  return listUsers().filter((u) => !u.disabledAt && (practice.level === 'org' ? isInstanceAdmin(u) : projectRoleCan.manage(projectRole(u, practice.projectId))));
}

const audienceOf = (practice: Pick<Practice, 'level' | 'projectId'>): AudienceMember[] =>
  approvers(practice)
    .slice(0, MAX_AUDIENCE)
    .map((u) => ({ userId: u.id, email: u.email.toLowerCase(), name: u.name }));

const parse = (text: string): Proposal | undefined => {
  try {
    return JSON.parse(text) as Proposal;
  } catch {
    return undefined;
  }
};

/** The open (or snoozed) practice suggestions of one practice. */
function openFor(practiceId: string, db: Database): Proposal[] {
  return db
    .all<{ data: string }>("SELECT data FROM proposals WHERE source = 'practice' AND status IN ('open', 'snoozed')")
    .flatMap((r) => parse(r.data) ?? [])
    .filter((p) => p.practice?.practiceId === practiceId);
}

/* ------------------------------------------------------------------------------------------------------------ filing */

/**
 * File the suggestion for a saved draft version, and let it replace the open suggestion of an older version of the same
 * practice. Never throws: a draft is saved whether or not the inbox took it. Its text is the cleaned title and summary
 * only: nothing of a tainted draft's body goes into the card.
 */
export function fileDraftSuggestion(practice: Pick<Practice, 'id' | 'handle' | 'level' | 'projectId'>, version: PracticeVersion, db: Database = database()): Proposal | undefined {
  try {
    const drafter = version.draftedBy?.startsWith('user:') ? (getUser(version.draftedBy.slice(5))?.name ?? 'A person') : DRAFTER[version.source];
    const where = practice.level === 'project' ? 'a project practice' : 'an organization practice';
    const proposal = upsertProposal(
      {
        source: 'practice',
        label: 'Practice draft',
        fingerprint: fingerprintOf('practice', practice.id, version.version),
        ...(practice.projectId && { projectId: practice.projectId }),
        target: { type: 'instance', name: practice.handle },
        title: version.tainted ? `Read this draft practice: ${version.title}` : `Approve this practice: ${version.title}`,
        why: version.tainted
          ? `${drafter} drafted version ${version.version} of ${practice.handle}, ${where}: ${version.summary} It was read from outside (a repository or an agent’s run), so it is approved only by someone who reads its rules against their sources on /brain.`
          : `${drafter} drafted version ${version.version} of ${practice.handle}, ${where}: ${version.summary} Applying it approves this version: agents get it from then on.`,
        evidence: [
          { label: 'Practice', value: practice.handle, href: practiceHref(practice.id) },
          { label: 'Version', value: version.version },
          { label: 'Strength', value: version.strength },
          ...(version.tainted ? [{ label: 'Read from outside', value: version.source === 'learned' ? 'a repository' : 'an agent’s run' }] : []),
        ],
        ops: [],
        audience: audienceOf(practice),
        risk: version.tainted ? 'medium' : 'low',
        confidence: 0.9,
        score: 7,
        practice: { practiceId: practice.id, version: version.version, tainted: version.tainted },
      },
      db,
    );
    // A newer version replaces the open suggestion of an older one.
    const at = new Date().toISOString();
    for (const older of openFor(practice.id, db)) {
      if (older.practice && older.practice.version < version.version) saveProposal({ ...older, status: 'expired', updatedAt: at, note: `Replaced by version ${version.version}` }, db);
    }
    return proposal;
  } catch (caught) {
    logger.warn('a practice draft could not file its suggestion', { error: caught });
    return undefined;
  }
}

/* ---------------------------------------------------------------------------------------------------------- settling */

/** A decision on /brain: the open suggestion of that version is applied. Older versions' suggestions are no longer pending. */
export function settleApproved(practiceId: string, version: number, actorId: string, db: Database = database()): void {
  try {
    const at = new Date().toISOString();
    for (const p of openFor(practiceId, db)) {
      if (p.practice!.version === version) markApplied(p, { actorId, note: 'Approved' }, db);
      else if (p.practice!.version < version) saveProposal({ ...p, status: 'expired', updatedAt: at, note: `Replaced by version ${version}` }, db);
    }
  } catch (caught) {
    logger.warn('a practice approval could not settle its suggestion', { error: caught });
  }
}

/** A rejected version's suggestion is dismissed, with the reason. */
export function settleRejected(practiceId: string, version: number, actorId: string, reason: string, db: Database = database()): void {
  try {
    for (const p of openFor(practiceId, db)) if (p.practice!.version === version) dismissProposal(p.id, 'not-relevant', { actorId, note: `Rejected: ${reason}` }, db);
  } catch (caught) {
    logger.warn('a practice rejection could not settle its suggestion', { error: caught });
  }
}

/** Every open suggestion of a retired practice is dismissed. */
export function settleRetired(practiceId: string, actorId: string, db: Database = database()): void {
  try {
    for (const p of openFor(practiceId, db)) dismissProposal(p.id, 'not-relevant', { actorId, note: 'The practice was retired' }, db);
  } catch (caught) {
    logger.warn('a practice retirement could not settle its suggestions', { error: caught });
  }
}

/* ---------------------------------------------------------------------------------------------------------- applying */

/** What Apply needs from approve.ts (see the file comment). */
export interface InboxDeps {
  /** approvePractice. */
  approve: (actor: UserRecord, practiceId: string, input: PracticeApproveInput) => unknown;
  /** Why a version can no longer be approved ('already approved', 'rejected', 'replaced', 'retired'…), or undefined while it waits. */
  stale: (practiceId: string, version: number) => string | undefined;
}
const slot = () => singleton('practices-inbox-deps', () => ({ deps: undefined as InboxDeps | undefined }));
export const setInboxDeps = (deps: InboxDeps | undefined): void => void (slot().deps = deps);

/**
 * Apply for `source: 'practice'`: approve that version, with the applying person as the approver. Owners and admins only;
 * a draft read from outside is refused (its approver must read it against its sources on /brain). A version that is no
 * longer waiting answers 409 and settles the suggestion (dismissed with the reason).
 */
export function applyPracticeSuggestion(proposal: Proposal, options: ApplyOptions, db: Database = database()): void {
  const info = proposal.practice;
  if (!info) throw new ProposalError('This suggestion is not about a practice', 400);
  const actor = options.actorId ? getUser(options.actorId) : undefined;
  if (!actor || !isInstanceAdmin(actor)) throw new ProposalError('Only owners and admins approve a practice from the inbox. Open it on /brain.', 403);
  if (info.tainted) throw new ProposalError('This draft was read from outside: read it against its sources on /brain and approve it there', 403);
  const deps = slot().deps;
  if (!deps) throw new ProposalError('Practices are not loaded on this host', 503);
  const stale = deps.stale(info.practiceId, info.version);
  if (stale) {
    dismissProposal(proposal.id, 'not-relevant', { actorId: actor.id, note: `Not approved from the inbox: ${stale}` }, db);
    throw new ProposalError(`Version ${info.version} is no longer waiting (${stale})`, 409);
  }
  try {
    deps.approve(actor, info.practiceId, { version: info.version });
  } catch (caught) {
    if (caught instanceof PracticeConflict) throw new ProposalError('This practice overlaps approved ones: approve it on /brain, where each overlap gets an answer', 409);
    throw caught;
  }
}

setProposalApplier('practice', (proposal, options, db) => applyPracticeSuggestion(proposal, options, db));
