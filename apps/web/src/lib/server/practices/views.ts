/**
 * What a viewer sees of practices (docs/practices.md#who-sees-what), in one place. Approved and retired practices: every
 * signed-in person for an org practice, people with a role in the project for a project one (owners and admins see all).
 * Drafts: the person who drafted them and those who may approve them; a practice with no approved version is visible to
 * the same people only.
 */
import type { Practice, PracticeApplication, PracticeConflict, PracticeDetailResponse, PracticesResponse, PracticeStatus, PracticeVersion, PracticeVersionState, PracticeView } from '../../shared/practices';
import { PRACTICE_LIMITS } from '../../shared/practices';
import { getUser } from '../auth/users';
import { isInstanceAdmin, projectRole, visibleProjectIds, type Actor } from '../projects/access';
import { canApprove, conflictsOfVersion } from './approve';
import { applicationsOf, canDraftAt, getPractice, listPractices, pendingVersions, versionsFor, versionsOf } from './store';

export interface PracticeListQuery {
  status?: PracticeStatus;
  level?: 'org' | 'project';
  projectId?: string;
  topic?: string;
  q?: string;
}

const pendingOf = (practice: Practice, v: PracticeVersion) => !v.rejectedAt && !v.approvedAt && v.version > (practice.approvedVersion ?? 0);

export function versionState(practice: Practice, v: PracticeVersion): PracticeVersionState {
  if (v.rejectedAt) return 'rejected';
  if (v.version === practice.approvedVersion) return 'approved';
  if (v.approvedAt || v.version < (practice.approvedVersion ?? 0)) return 'replaced';
  return 'pending';
}

const mine = (viewer: Actor | undefined, v: PracticeVersion) => Boolean(viewer && v.draftedBy === `user:${viewer.id}`);

/** Whether `viewer` may see the practice at all. */
export function practiceVisible(viewer: Actor | undefined, practice: Practice, versions: readonly PracticeVersion[]): boolean {
  if (!viewer) return false;
  if (practice.approvedVersion !== undefined) return practice.level === 'org' || isInstanceAdmin(viewer) || Boolean(projectRole(viewer, practice.projectId));
  return canApprove(viewer, practice) || versions.some((v) => mine(viewer, v));
}

/** A version the viewer may read: the approved ones with the practice, the rest only for their drafter and the approvers. */
function versionVisible(viewer: Actor | undefined, practice: Practice, v: PracticeVersion): boolean {
  if (v.approvedAt) return true;
  return canApprove(viewer, practice) || mine(viewer, v);
}

/** What a PATCH builds on: the newest version the caller may read and that was not rejected, else the newest they may read. */
export function patchBase(viewer: Actor, practice: Practice, versions: readonly PracticeVersion[]): PracticeVersion | undefined {
  const readable = versions.filter((v) => versionVisible(viewer, practice, v));
  return readable.find((v) => !v.rejectedAt) ?? readable[0];
}

/** One practice as `viewer` sees it. With no viewer (a flow), no drafts. */
export function viewOf(viewer: Actor | undefined, practice: Practice, versions: readonly PracticeVersion[]): PracticeView {
  const approved = practice.approvedVersion === undefined ? undefined : versions.find((v) => v.version === practice.approvedVersion);
  const ownerName = practice.ownerId ? getUser(practice.ownerId)?.name : undefined;
  return {
    ...practice,
    ...(ownerName && { ownerName }),
    ...(approved && { approved }),
    drafts: viewer ? versions.filter((v) => pendingOf(practice, v) && versionVisible(viewer, practice, v)) : [],
    canApprove: canApprove(viewer, practice),
    canDraft: canDraftAt(viewer, practice.level, practice.projectId),
  };
}

/** Whether `viewer` may open this practice (404 otherwise). */
export function visiblePractice(viewer: Actor, id: string): Practice | undefined {
  const practice = getPractice(id);
  return practice && practiceVisible(viewer, practice, versionsOf(id)) ? practice : undefined;
}

export function listView(viewer: Actor, query: PracticeListQuery): PracticesResponse {
  const admin = isInstanceAdmin(viewer);
  const within = admin ? undefined : [...(visibleProjectIds(viewer) ?? [])];
  const found = listPractices({
    status: query.status ? [query.status] : ['draft', 'approved'],
    ...(query.level && { level: query.level }),
    ...(query.projectId && { projectId: query.projectId }),
    ...(within && { withinProjects: within }),
    ...(query.topic && { topic: query.topic }),
    ...(query.q && { q: query.q }),
    limit: PRACTICE_LIMITS.list,
  });
  const versions = versionsFor(found.map((p) => p.id));
  const practices = found
    .filter((p) => practiceVisible(viewer, p, versions.get(p.id) ?? []))
    .map((p) => viewOf(viewer, p, versions.get(p.id) ?? []));

  // What waits for this viewer's yes, across every practice they may approve (not only the listed ones).
  const waitingFor = pendingVersions().filter((w) => {
    const practice = getPractice(w.practiceId);
    return practice ? canApprove(viewer, practice) : false;
  }).length;
  return { practices, canApproveOrg: admin, waiting: waitingFor };
}

export function detailView(viewer: Actor, id: string): PracticeDetailResponse | undefined {
  const practice = getPractice(id);
  const all = versionsOf(id);
  if (!practice || !practiceVisible(viewer, practice, all)) return undefined;
  const approver = canApprove(viewer, practice);
  const versions = all.filter((v) => versionVisible(viewer, practice, v)).map((v) => ({ ...v, state: versionState(practice, v) }));
  const newestPending = all.find((v) => pendingOf(practice, v));
  const conflicts: PracticeConflict[] = approver && newestPending ? conflictsOfVersion(practice, newestPending) : [];
  const applications = viewApplications(approver, applicationsOf(id, 20).applications);
  return { practice: viewOf(viewer, practice, all), versions, applications, conflicts };
}

/** Who a run's person was is for the approvers; everyone who sees the practice sees that it was applied. */
export const viewApplications = (approver: boolean, rows: PracticeApplication[]): PracticeApplication[] =>
  approver ? rows : rows.map(({ userId: _user, reason: _reason, ...rest }) => rest);
