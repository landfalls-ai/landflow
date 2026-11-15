/**
 * Who approves a practice and how (docs/practices.md#who-approves), shaped like notebook/approve.ts: org practices by
 * instance owners and admins, project practices by that project's admins, no four-eyes (the drafter may approve their
 * own). A version read from outside needs the approver to have read it against its sources; an overlap with an approved
 * practice needs an answer. Reject, retire and waive are here too. Each is audited.
 */
import { matchesPracticeGlob, type Practice, type PracticeApplication, type PracticeApproveInput, type PracticeConflict as ConflictInfo, type PracticeLevel, type PracticeVersion, type PracticeWaiverInput } from '../../shared/practices';
import { projectRoleCan } from '../../shared/projects';
import { recordAudit } from '../audit';
import { database } from '../db';
import { canResource, executionWorkflowId, isInstanceAdmin, projectRole, type Actor } from '../projects/access';
import { redactPatterns, redactText } from '../secrets/redact';
import { PracticeConflict, PracticeError, PracticeNeedsReview } from './errors';
import { setInboxDeps, settleApproved, settleRejected, settleRetired } from './inbox'; // PR09:
import { findWaiver, getPractice, getVersion, insertApplication, markApproved, markRejected, markRetired } from './store';

/** Org practices: owners and admins. Project practices: that project's admins. */
export function canApprove(actor: Actor | undefined, practice: Pick<Practice, 'level' | 'projectId'>): boolean {
  if (!actor) return false;
  return practice.level === 'org' ? isInstanceAdmin(actor) : projectRoleCan.manage(projectRole(actor, practice.projectId));
}

const pending = (practice: Practice, version: PracticeVersion) => !version.rejectedAt && !version.approvedAt && version.version > (practice.approvedVersion ?? 0);

/* -------------------------------------------------------------------------------------------------------- conflicts */

const intersect = (a: readonly string[], b: readonly string[]) => a.filter((x) => b.includes(x));
const globsMeet = (a: string, b: string) => a === b || matchesPracticeGlob(a, b) || matchesPracticeGlob(b, a);

interface Scope {
  level: PracticeLevel;
  projectId?: string;
  topics: readonly string[];
  repos: readonly string[];
  paths: readonly string[];
}

/** What two practices share, in words, or undefined when their topics or scopes do not meet. */
function overlap(a: Scope, b: Scope): string | undefined {
  const topics = intersect(a.topics, b.topics);
  if (!topics.length) return undefined;
  if (a.level === 'project' && b.level === 'project' && a.projectId !== b.projectId) return undefined;
  const parts = [`topic ${topics.join(', ')}`];
  if (a.repos.length && b.repos.length) {
    const repos = intersect(a.repos, b.repos);
    if (!repos.length) return undefined;
    parts.push(`repo ${repos.join(', ')}`);
  }
  if (a.paths.length && b.paths.length) {
    const meet = a.paths.flatMap((x) => b.paths.filter((y) => globsMeet(x, y)).map((y) => (x === y ? x : `${x} ~ ${y}`)));
    if (!meet.length) return undefined;
    parts.push(`path ${meet.slice(0, 3).join(', ')}`);
  }
  return parts.join('; ');
}

/** Approved practices (other than `practiceId`) that share a topic with `scope` and whose scopes meet. */
export function conflictsFor(practiceId: string, scope: Scope): ConflictInfo[] {
  const rows = database().all<{ id: string }>(`SELECT id FROM practices WHERE status = 'approved' AND approved_version IS NOT NULL AND id <> ?`, practiceId);
  const out: ConflictInfo[] = [];
  for (const { id } of rows) {
    const other = getPractice(id)!;
    const text = overlap(scope, other);
    if (text) out.push({ id: other.id, handle: other.handle, title: other.title, level: other.level, ...(other.projectId && { projectId: other.projectId }), version: other.approvedVersion!, overlap: text });
  }
  return out;
}

export const conflictsOfVersion = (practice: Practice, version: PracticeVersion) => conflictsFor(practice.id, { level: practice.level, projectId: practice.projectId, topics: version.topics, repos: version.repos, paths: version.paths });

/* ------------------------------------------------------------------------------------------------------- decisions */

/** Approve `input.version`: its scope and strength become the practice's, and it is what agents get from now on. */
export function approvePractice(actor: Actor, practiceId: string, input: PracticeApproveInput): Practice {
  const practice = getPractice(practiceId);
  if (!practice) throw new PracticeError('Practice not found', 404);
  if (!canApprove(actor, practice)) throw new PracticeError(practice.level === 'org' ? 'Only owners and admins approve organization practices' : 'Only admins of the project approve its practices', 403);
  const version = getVersion(practiceId, input.version);
  if (!version) throw new PracticeError('Version not found', 404);
  if (!pending(practice, version)) throw new PracticeError('This version is not waiting for approval', 400);
  if (version.tainted && !input.reviewedSources) throw new PracticeNeedsReview();

  const conflicts = conflictsOfVersion(practice, version);
  if (conflicts.some((c) => input.conflicts?.[c.id] !== 'supersede' && input.conflicts?.[c.id] !== 'keep')) throw new PracticeConflict(conflicts);
  const superseded = conflicts.filter((c) => input.conflicts?.[c.id] === 'supersede');
  for (const c of superseded) {
    if (!canApprove(actor, c)) throw new PracticeError(`You can’t retire “${c.handle}”: it is approved by someone else`, 403);
  }

  const approved = database().transaction(() => {
    for (const c of superseded) markRetired(c.id);
    return markApproved(practice, version, actor.id, superseded.map((c) => c.id));
  });
  recordAudit({
    action: 'practice.approved',
    target: { type: 'practice', id: practice.id, name: practice.handle },
    details: { version: version.version, sha256: version.sha256, superseded: superseded.map((c) => c.id).join(','), tainted: version.tainted },
    project: practice.projectId ?? null,
  });
  // PR09: the inbox's suggestion for this version is applied; a practice it retired settles its own.
  settleApproved(practice.id, version.version, actor.id);
  for (const c of superseded) settleRetired(c.id, actor.id);
  return approved;
}

export function rejectVersion(actor: Actor, practiceId: string, versionNumber: number, reason: string): Practice {
  const practice = getPractice(practiceId);
  if (!practice) throw new PracticeError('Practice not found', 404);
  if (!canApprove(actor, practice)) throw new PracticeError('You can’t reject this practice’s versions', 403);
  const version = getVersion(practiceId, versionNumber);
  if (!version) throw new PracticeError('Version not found', 404);
  if (!pending(practice, version)) throw new PracticeError('This version is not waiting for approval', 400);
  markRejected(practiceId, versionNumber, actor.id, redactPatterns(redactText(reason)).replace(/\s+/g, ' ').trim());
  recordAudit({ action: 'practice.rejected', target: { type: 'practice', id: practice.id, name: practice.handle }, details: { version: versionNumber }, project: practice.projectId ?? null });
  settleRejected(practiceId, versionNumber, actor.id, redactPatterns(redactText(reason)).replace(/\s+/g, ' ').trim()); // PR09:
  return getPractice(practiceId)!;
}

/** Retire: agents stop getting it. Its versions stay, and a new version can bring it back. */
export function retirePractice(actor: Actor, practiceId: string): Practice {
  const practice = getPractice(practiceId);
  if (!practice) throw new PracticeError('Practice not found', 404);
  if (!canApprove(actor, practice)) throw new PracticeError('You can’t retire this practice', 403);
  if (practice.status === 'retired') return practice;
  const retired = markRetired(practiceId);
  recordAudit({ action: 'practice.retired', target: { type: 'practice', id: practice.id, name: practice.handle }, project: practice.projectId ?? null });
  settleRetired(practiceId, actor.id); // PR09:
  return retired;
}

/** One run's failed check of a practice, waived by someone who may approve it. A second waiver of the same run returns the first. */
export function waivePractice(actor: Actor, practiceId: string, input: PracticeWaiverInput): PracticeApplication {
  const practice = getPractice(practiceId);
  if (!practice) throw new PracticeError('Practice not found', 404);
  if (!canApprove(actor, practice)) throw new PracticeError('Only people who may approve this practice can waive it', 403);
  const workflowId = executionWorkflowId(input.executionId);
  if (!workflowId || !canResource(actor, 'workflow', workflowId, 'read')) throw new PracticeError('Run not found', 404);
  const version = getVersion(practiceId, input.version);
  if (!version?.approvedAt) throw new PracticeError('That version was never approved', 400);
  const first = findWaiver(practiceId, input.executionId);
  if (first) return first;
  const reason = redactPatterns(redactText(input.reason)).replace(/\s+/g, ' ').trim();
  const application = insertApplication({ practiceId, version: version.version, kind: 'waived', executionId: input.executionId, userId: actor.id, reason });
  recordAudit({
    action: 'practice.waived',
    target: { type: 'practice', id: practice.id, name: practice.handle },
    details: { executionId: input.executionId, version: version.version, reason },
    project: practice.projectId ?? null,
  });
  return application;
}

// PR09: what Apply in the inbox needs (./inbox.ts imports neither this file nor the store).
setInboxDeps({
  approve: (actor, practiceId, input) => approvePractice(actor, practiceId, input),
  stale(practiceId, versionNumber) {
    const practice = getPractice(practiceId);
    if (!practice || practice.status === 'retired') return 'the practice is retired';
    const version = getVersion(practiceId, versionNumber);
    if (!version) return 'the version is gone';
    if (version.rejectedAt) return 'it was rejected';
    if (version.approvedAt || versionNumber <= (practice.approvedVersion ?? 0)) return versionNumber === practice.approvedVersion ? 'it is already approved' : 'a newer version replaced it';
    return undefined;
  },
});
