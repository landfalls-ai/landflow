/**
 * Ownership transfer: "Move to project" for one workflow or credential (and data tables and agents), deleting a team
 * project, and removing a user, whose personal project's resources go to another user or a project (with its folders,
 * variables and templates). Every change is one database transaction, so a failure leaves everything where it was.
 *
 * Moving keeps things working where that is safe: a moved credential stays usable by its old project (a `user`
 * share) unless told otherwise, and moving a workflow can share the credentials it uses with the new project.
 */
import { recordAudit } from '../audit';
import { projectKeys } from '../credentials/project-keys'; // C31:
import { logger } from '../telemetry/logger';
import { personalProjectId, type ResourceKind, type ShareRole, type TransferTarget } from '../../shared/projects';
import { authDb } from '../auth/db';
import { deleteUser, getUser } from '../auth/users';
import { dataTables } from '../datatables';
import { folders } from '../folders';
import { forgetProjectSettings } from '../governance/scopes';
import { agentTemplateRows } from '../agents/template-rows';
import { localTemplates } from '../templates/store';
import { settleRetired } from '../practices/inbox';
import { removeProjectSubscriptions } from '../outbox/subscriptions';
import { dropCollections, moveCollections, settleCollectionsBeforeMove } from '../rag/collection-access'; // C21:
import { projectVariables } from './variables';
import {
  auditShare,
  putShare,
  defaultProjectId,
  ensurePersonalProject,
  getProject,
  homeProjectId,
  ProjectError,
  removeProjectRows,
  resourcesIn,
  setHomeProject,
  sharesTo,
  storedHomeProject,
  type ProjectRecord,
} from './store';

export interface MoveOptions {
  /** Credentials: keep the credential usable by its old project (a `user` share). Default true. */
  keepAccess?: boolean;
  /** Workflows: share these credentials (the ones it uses) with the new project. */
  shareCredentials?: string[];
  actorId?: string;
}

/** Move one resource to `projectId`. Returns the project it left. */
export function moveResource(kind: ResourceKind, id: string, projectId: string, options: MoveOptions = {}): { from?: string; to: ProjectRecord } {
  const target = getProject(projectId);
  if (!target) throw new ProjectError('Project not found', 404);
  const db = authDb();
  const kept: Array<[ResourceKind, string, string, ShareRole | undefined]> = [];
  const result = db.transaction(() => {
    const from = homeProjectId(kind, id);
    if (from === target.id && storedHomeProject(kind, id)) return { from, to: target, moved: false };
    setHomeProject(kind, id, target.id);
    if (kind === 'credential' && from && from !== target.id && options.keepAccess !== false) {
      const before = putShare('credential', id, from, 'user', options.actorId);
      if (before !== 'user') kept.push(['credential', id, from, before]);
    }
    for (const credentialId of options.shareCredentials ?? []) {
      if (homeProjectId('credential', credentialId) !== target.id) {
        const before = putShare('credential', credentialId, target.id, 'user', options.actorId);
        if (before !== 'user') kept.push(['credential', credentialId, target.id, before]);
      }
    }
    return { from, to: target, moved: true };
  });
  // Recorded once the transaction has committed.
  if (result.moved) {
    const fromName = result.from ? (getProject(result.from)?.name ?? result.from) : undefined;
    recordAudit({
      action: 'resource.transfer',
      target: { type: kind, id },
      summary: `Moved ${kind} ${id} from ${fromName ?? 'the default project'} to ${target.name}`,
      details: { kind, resourceId: id, from: result.from ?? null, to: target.id, toName: target.name, keepAccess: kind === 'credential' ? options.keepAccess !== false : null, sharedCredentials: options.shareCredentials?.length ?? 0 },
    });
    for (const [shareKind, shareId, withProject, was] of kept) auditShare(shareKind, shareId, withProject, was, 'user');
    // C31: the credential is sealed with its new project's key now (the vault is not in this transaction: a failure leaves it on the old key, readable, and `migrate` finishes it).
    if (kind === 'credential') projectKeys.resealCredentials([id]);
  }
  return { from: result.from, to: result.to };
}

/** C31: a project is gone: its keys are retired now and deleted by a later sweep (not here: another process may still be sealing with them). A failure is logged; `migrate` retries. */
function removed(projectId: string) {
  projectKeys.projectRemoved(projectId).catch((error) => logger.warn('a removed project’s keys could not be retired', { 'landflow.project_key.project': projectId, error: error instanceof Error ? error.name : 'error' }));
}

/** Data table names are unique per project: a table moving in with a name the project already has becomes `name 2`, `name 3`… */
function renameForProject(tableId: string, projectId: string) {
  const service = dataTables();
  const table = service.storage.getTable(tableId);
  if (!table) return;
  const taken = new Set(service.inProject(service.listTables(), projectId).filter((t) => t.id !== tableId).map((t) => t.name.toLowerCase()));
  if (!taken.has(table.name.toLowerCase())) return;
  for (let i = 2; ; i++) {
    const name = `${table.name} ${i}`;
    if (taken.has(name.toLowerCase())) continue;
    service.renameTable(tableId, name);
    return;
  }
}

/**
 * Move everything `fromProjectId` owns, and the shares made to it, to `toProjectId` (inside the caller's transaction):
 * its resources, its folders (so its workflows keep them), its variables (keys the target has already stay the
 * target's) and its templates. Its settings go with it.
 */
function moveAll(fromProjectId: string, toProjectId: string, options: { includeUnassigned?: boolean; actorId?: string } = {}): Partial<Record<ResourceKind, number>> {
  const moved: Partial<Record<ResourceKind, number>> = {};
  for (const { kind, id } of resourcesIn(fromProjectId)) {
    if (kind === 'dataTable') renameForProject(id, toProjectId);
    setHomeProject(kind, id, toProjectId);
    moved[kind] = (moved[kind] ?? 0) + 1;
  }
  folders.reassignProject(fromProjectId, toProjectId);
  projectVariables.moveAll(fromProjectId, toProjectId);
  localTemplates.moveProject(fromProjectId, toProjectId);
  agentTemplateRows.moveProject(fromProjectId, toProjectId);
  moveCollections(fromProjectId, toProjectId, options.actorId); // C21: its vector collections and the grants it held
  forgetProjectSettings(fromProjectId);
  for (const share of sharesTo(fromProjectId)) {
    // A share to the new owner is pointless (it owns or already has it), so it goes with the old project.
    if (homeProjectId(share.kind, share.resourceId) === toProjectId) continue;
    if (!sharesTo(toProjectId, share.kind).some((s) => s.resourceId === share.resourceId)) putShare(share.kind, share.resourceId, toProjectId, share.role, options.actorId ?? share.createdBy);
  }
  return moved;
}

/** A project goes without a transfer (it owned no resources): its folders, variables, templates and settings go too. */
function dropProjectData(projectId: string) {
  folders.removeProject(projectId);
  projectVariables.removeProject(projectId);
  localTemplates.moveProject(projectId);
  agentTemplateRows.moveProject(projectId);
  dropCollections(projectId); // C21: its collections and grants go with it
  forgetProjectSettings(projectId);
}

/** The project a transfer target names (a user's personal project, made if needed). */
export function transferProject(target: TransferTarget): ProjectRecord {
  if ('userId' in target) {
    const user = getUser(target.userId);
    if (!user) throw new ProjectError('The user to transfer to doesn’t exist', 404);
    if (user.disabledAt) throw new ProjectError(`${user.name} is deactivated: choose someone else`, 400);
    const id = ensurePersonalProject(user.id)!;
    return getProject(id)!;
  }
  const project = getProject(target.projectId);
  if (!project) throw new ProjectError('The project to transfer to doesn’t exist', 404);
  return project;
}

/** What a user's personal project owns, by kind (what removing them would transfer). */
export function ownedBy(userId: string): Partial<Record<ResourceKind, number>> {
  const counts: Partial<Record<ResourceKind, number>> = {};
  for (const { kind } of resourcesIn(personalProjectId(userId))) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
}

/**
 * Remove a user. Their personal project's workflows, credentials, data tables and agents (and what was shared with
 * them) go to `target`, which is required when they own anything; then their memberships, personal project,
 * sessions, API keys and the user go. All in one transaction.
 */
export function deleteUserWithTransfer(userId: string, target?: TransferTarget, actorId?: string): { moved: Partial<Record<ResourceKind, number>>; to?: ProjectRecord } {
  const user = getUser(userId);
  if (!user) throw new ProjectError('User not found', 404);
  if (user.role === 'owner') throw new ProjectError('The owner can’t be removed', 403);
  const personal = personalProjectId(userId);
  const db = authDb();
  settleCollectionsBeforeMove(); // C21: the upgrade's adoption has run before anything moves
  const { retired, credentialIds, ...result } = db.transaction(() => {
    const owned = resourcesIn(personal);
    const credentialIds = owned.filter((r) => r.kind === 'credential').map((r) => r.id);
    let to: ProjectRecord | undefined;
    let moved: Partial<Record<ResourceKind, number>> = {};
    if (target) {
      to = transferProject(target);
      if (to.id === personal) throw new ProjectError('Transfer to someone else, or to a project', 400);
      moved = moveAll(personal, to.id, { actorId });
    } else if (owned.length) {
      throw new ProjectError(`${user.name} owns ${owned.length} item${owned.length === 1 ? '' : 's'}: choose a user or project to transfer them to`, 409);
    } else {
      dropProjectData(personal);
    }
    db.delete('project_members', { user_id: userId });
    db.delete('scim_group_members', { user_id: userId });
    removeProjectSubscriptions(personal);
    const retired = removeProjectRows(personal);
    if (!deleteUser(userId)) throw new ProjectError('User not found', 404);
    return { moved, retired, credentialIds, ...(to && { to }) };
  });
  for (const practiceId of retired) settleRetired(practiceId, actorId);
  // C31: what moved is sealed with the new project's key, then the personal project's keys are retired.
  projectKeys.resealCredentials(credentialIds);
  removed(personal);
  return result;
}

/** Delete a team project; what it owns goes to `transferTo` (required when it owns anything). One transaction. */
export function deleteProjectWithTransfer(projectId: string, transferTo?: string, actorId?: string): { moved: Partial<Record<ResourceKind, number>> } {
  const project = getProject(projectId);
  if (!project) throw new ProjectError('Project not found', 404);
  if (project.type === 'personal') throw new ProjectError('A personal project goes when its user is removed', 400);
  const db = authDb();
  settleCollectionsBeforeMove(); // C21: the upgrade's adoption has run before anything moves
  const result = db.transaction(() => {
    let moved: Partial<Record<ResourceKind, number>> = {};
    const owned = resourcesIn(projectId);
    const credentialIds = owned.filter((r) => r.kind === 'credential').map((r) => r.id);
    if (transferTo) {
      if (transferTo === projectId) throw new ProjectError('Choose another project to transfer to', 400);
      if (!getProject(transferTo)) throw new ProjectError('The project to transfer to doesn’t exist', 404);
      moved = moveAll(projectId, transferTo, { actorId });
    } else if (owned.length) {
      throw new ProjectError(`“${project.name}” owns ${owned.length} item${owned.length === 1 ? '' : 's'}: choose a project to transfer them to`, 409);
    } else {
      dropProjectData(projectId);
    }
    removeProjectSubscriptions(projectId);
    const retired = removeProjectRows(projectId);
    return { moved, retired, credentialIds };
  });
  // The project's practices are retired: their open inbox suggestions are dismissed, so none waits on a project that is gone.
  for (const practiceId of result.retired) settleRetired(practiceId, actorId);
  // C31: what moved is sealed with the target's key, then this project's keys are retired.
  projectKeys.resealCredentials(result.credentialIds);
  removed(projectId);
  recordAudit({
    action: 'project.delete',
    target: { type: 'project', id: projectId, name: project.name },
    project: projectId,
    summary: `Deleted the project ${project.name}${transferTo ? ` (its items went to ${getProject(transferTo)?.name ?? transferTo})` : ''}`,
    details: { name: project.name, transferredTo: transferTo ?? null, moved: Object.entries(result.moved).map(([k, n]) => `${k}:${n}`) },
  });
  return { moved: result.moved };
}

/**
 * Give every resource without a home project row a row in the default project (the instance owner's personal
 * project): what existed before projects, credentials and agents in files included. Only inserts; idempotent; a
 * no-op before setup. Called at boot and by the migration test.
 */
export function adoptUnassigned(ids: Partial<Record<ResourceKind, Iterable<string>>>): number {
  const project = defaultProjectId();
  if (!project) return 0;
  const db = authDb();
  let adopted = 0;
  db.transaction(() => {
    const now = new Date().toISOString();
    for (const [kind, list] of Object.entries(ids) as Array<[ResourceKind, Iterable<string>]>) {
      for (const id of list) if (db.insertNew('project_resources', { kind, resource_id: id, project_id: project, created_at: now })) adopted++;
    }
  });
  return adopted;
}
