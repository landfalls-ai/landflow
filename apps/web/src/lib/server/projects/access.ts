/**
 * Who may do what with projects and the resources in them. The rules (which access allows which action) are
 * `resourceCan` in lib/shared/projects.ts; this module works out someone's access from the database:
 *
 * - The instance owner and admins (`can(user, 'projects:manage')`) have full access to everything.
 * - A member of a resource's home project has their project role on it.
 * - A member of a project the resource is shared with has the weaker of their project role and the share's role
 *   (credentials shared for use give `user`: usable, never readable).
 *
 * The route guard applies it to every resource route (`checkResourceRule`, with the table in ../auth/policy.ts),
 * list routes filter with `visibleIds`/`ownershipOf`, and runs check credentials with `credentialUsableBy`.
 * `projectRole` is the one helper to ask for someone's role in a project (approvals, other features call it).
 */
import { can, type Role } from '../../shared/auth';
import {
  FULL_ACCESS,
  personalProjectId,
  projectRoleCan,
  RESOURCE_LABELS,
  resourceCan,
  strongerAccess,
  weakerRole,
  type ProjectRole,
  type ResourceAccess,
  type ResourceAction,
  type ResourceKind,
  type ResourceOwnership,
} from '../../shared/projects';
import { authDb } from '../auth/db';
import { AuthError } from '../auth/errors';
import {
  allShares,
  defaultProjectId,
  ensurePersonalProject,
  getProject,
  homeProjectId,
  homeProjects,
  listProjects,
  memberRole,
  membershipsOf,
  shares,
  storedHomeProject,
} from './store';

/** The part of a user the checks need. */
export interface Actor {
  id: string;
  role: Role;
}

/** Owners and admins: every project, every resource. */
export const isInstanceAdmin = (actor: Actor | undefined): boolean => can(actor, 'projects:manage');

/**
 * `actor`'s role in `projectId`: admin for the instance owner and admins, else their membership's role (none when
 * they aren't a member). The one function to call for "what is this person in this project".
 */
export function projectRole(actor: Actor | undefined, projectId: string | undefined): ProjectRole | undefined {
  if (!actor || !projectId) return undefined;
  if (isInstanceAdmin(actor)) return 'admin';
  if (projectId === personalProjectId(actor.id)) return 'admin';
  return memberRole(projectId, actor.id);
}

/** Projects `actor` sees: all for owners and admins, else their personal project and the projects they are in. */
export function visibleProjectIds(actor: Actor): Set<string> | undefined {
  if (isInstanceAdmin(actor)) return undefined;
  ensurePersonalProject(actor.id);
  return new Set([personalProjectId(actor.id), ...membershipsOf(actor.id).map((m) => m.projectId)]);
}

/** The access a home role and a list of shares give, with `roleIn` saying the actor's role in a project. */
function accessFrom(home: string | undefined, homeShares: Array<{ projectId: string; role: string }>, roleIn: (projectId: string | undefined) => ProjectRole | undefined): ResourceAccess | undefined {
  const homeRole = roleIn(home);
  let access: ResourceAccess | undefined = homeRole && { role: homeRole, home: true };
  for (const share of homeShares) {
    const role = roleIn(share.projectId);
    if (!role) continue;
    access = strongerAccess(access, { role: share.role === 'user' ? 'user' : weakerRole<ResourceAccess['role']>(role, share.role as ProjectRole), home: false });
  }
  return access;
}

/** `actor`'s access to one resource (undefined: none, it is invisible to them). */
export function resourceAccess(actor: Actor | undefined, kind: ResourceKind, id: string): ResourceAccess | undefined {
  if (!actor) return undefined;
  if (isInstanceAdmin(actor)) return FULL_ACCESS;
  return accessFrom(homeProjectId(kind, id), shares(kind, id), (projectId) => projectRole(actor, projectId));
}

/** Whether `actor` may do `action` with a resource. */
export function canResource(actor: Actor | undefined, kind: ResourceKind, id: string, action: ResourceAction): boolean {
  return resourceCan(resourceAccess(actor, kind, id), action);
}

const NOT_FOUND: Record<ResourceKind, string> = { workflow: 'Workflow not found', credential: 'Credential not found', dataTable: 'Data table not found', agent: 'Agent not found', agentTeam: 'Agent team not found' };

/** Why `actor` may not do `action` with a resource (404 when they can't see it at all), or undefined when they may. */
export function resourceDenial(actor: Actor | undefined, kind: ResourceKind, id: string, action: ResourceAction): { status: 403 | 404; message: string } | undefined {
  const access = resourceAccess(actor, kind, id);
  if (!access) return { status: 404, message: NOT_FOUND[kind] };
  if (resourceCan(access, action)) return undefined;
  const label = RESOURCE_LABELS[kind];
  const why: Record<ResourceAction, string> = {
    read: `You can’t see this ${label}`,
    use: `You can’t use this ${label}`,
    run: `You can view this ${label} but not run it`,
    update: `You can view this ${label} but not change it`,
    delete: `Only editors of the ${label}’s project can delete it`,
    share: `Only admins of the ${label}’s project can share it`,
    move: `Only admins of the ${label}’s project can move it`,
  };
  return { status: 403, message: why[action] };
}

/** Throws AuthError (404/403) unless `actor` may do `action` with the resource. */
export function requireResource(actor: Actor | undefined, kind: ResourceKind, id: string, action: ResourceAction) {
  const denied = resourceDenial(actor, kind, id, action);
  if (denied) throw new AuthError(denied.message, denied.status);
}

/** A rule from the route table (../auth/policy.ts): an execution stands for its workflow. */
export interface ResourceRule {
  kind: ResourceKind | 'execution';
  id: string;
  action: ResourceAction;
}

/** The workflow of a saved execution (undefined when there is no such execution). */
export function executionWorkflowId(executionId: string): string | undefined {
  if (!/^[\w-]+$/.test(executionId)) return undefined;
  return authDb().get<{ workflow_id: string }>('SELECT workflow_id FROM executions WHERE id = ?', executionId)?.workflow_id;
}

/** The guard's check of one route rule: undefined when allowed, else the status and message to answer with. */
export function checkResourceRule(actor: Actor | undefined, rule: ResourceRule): { status: 403 | 404; message: string } | undefined {
  if (isInstanceAdmin(actor)) return undefined;
  if (rule.kind === 'execution') {
    const workflowId = executionWorkflowId(rule.id);
    // An execution that isn't saved (yet): the route answers 404, or the runner knows its workflow.
    if (!workflowId) return undefined;
    const denied = resourceDenial(actor, 'workflow', workflowId, rule.action);
    return denied && { status: denied.status, message: denied.status === 404 ? 'Execution not found' : denied.message };
  }
  return resourceDenial(actor, rule.kind, rule.id, rule.action);
}

/**
 * Ids of the resources of a kind `actor` sees (undefined = all: owners and admins). `ids` are every resource of
 * that kind, so ones without a row (the default project's) are included for members of the default project.
 */
export function visibleIds(actor: Actor, kind: ResourceKind, ids: Iterable<string>): Set<string> | undefined {
  if (isInstanceAdmin(actor)) return undefined;
  const projects = visibleProjectIds(actor)!;
  const homes = homeProjects(kind);
  const fallback = defaultProjectId();
  const visible = new Set<string>();
  const shared = new Set(
    authDb()
      .all<{ resource_id: string; project_id: string }>('SELECT resource_id, project_id FROM resource_shares WHERE kind = ?', kind)
      .filter((row) => projects.has(row.project_id))
      .map((row) => row.resource_id),
  );
  for (const id of ids) {
    const home = homes.get(id) ?? fallback;
    if ((home && projects.has(home)) || shared.has(id)) visible.add(id);
  }
  return visible;
}

/** Keep the items `actor` sees. */
export function filterVisible<T extends { id: string }>(actor: Actor, kind: ResourceKind, items: T[]): T[] {
  const visible = visibleIds(actor, kind, items.map((item) => item.id));
  return visible ? items.filter((item) => visible.has(item.id)) : items;
}

/**
 * Each item with its ownership (home project and the viewer's access), for list routes; `projectId` keeps the items
 * a project owns or has been shared. Items `actor` can't see are left out.
 */
export function withOwnership<T extends { id: string }>(actor: Actor, kind: ResourceKind, items: T[], projectId?: string | null): Array<T & { ownership: ResourceOwnership }> {
  const homes = homeProjects(kind);
  const fallback = defaultProjectId();
  const projects = new Map(listProjects().map((p) => [p.id, p]));
  const visible = visibleIds(actor, kind, items.map((item) => item.id));
  // One query per kind for the shares and one for the memberships, not one per item (an N+1 once reads go to Postgres).
  const allShared = allShares(kind);
  const admin = isInstanceAdmin(actor);
  const roles = admin ? undefined : new Map(membershipsOf(actor.id).map((m) => [m.projectId, m.role]));
  const roleIn = (id: string | undefined): ProjectRole | undefined => (!id ? undefined : admin || id === personalProjectId(actor.id) ? 'admin' : roles?.get(id));
  const out: Array<T & { ownership: ResourceOwnership }> = [];
  for (const item of items) {
    if (visible && !visible.has(item.id)) continue;
    const home = homes.get(item.id) ?? fallback ?? '';
    const itemShares = allShared.get(item.id) ?? [];
    if (projectId && home !== projectId && !itemShares.some((s) => s.projectId === projectId)) continue;
    const access = (admin ? FULL_ACCESS : accessFrom(homes.get(item.id) ?? fallback, itemShares, roleIn)) ?? FULL_ACCESS;
    const project = projects.get(home);
    out.push({ ...item, ownership: { projectId: home, projectName: project?.name ?? 'Default', projectType: project?.type ?? 'personal', access, shared: !access.home } });
  }
  return out;
}

/** A resource's ownership as the item's `ownership` field (single resource routes). */
export function ownershipOf(actor: Actor, kind: ResourceKind, id: string): ResourceOwnership {
  const home = homeProjectId(kind, id) ?? '';
  const project = getProject(home);
  const access = resourceAccess(actor, kind, id) ?? FULL_ACCESS;
  return { projectId: home, projectName: project?.name ?? 'Default', projectType: project?.type ?? 'personal', access, shared: !access.home };
}

// ---- creating ---------------------------------------------------------------------------------------------

/**
 * The project a new resource goes to: `requested` (the actor must be an editor there), else the actor's personal
 * project. Undefined (the default project) for system callers and test principals that aren't stored users.
 * Throws AuthError when the actor can't create in `requested`.
 */
export function creationProject(actor: Actor | undefined, requested?: string | null): string | undefined {
  if (requested) {
    const project = getProject(requested);
    if (!project) throw new AuthError('Project not found', 404);
    if (!projectRoleCan.create(projectRole(actor, project.id))) throw new AuthError(`You can’t create things in “${project.name}”`, 403);
    return project.id;
  }
  return actor ? ensurePersonalProject(actor.id) : undefined;
}

// ---- running ----------------------------------------------------------------------------------------------

/**
 * Whether a credential may be used by what a project owns: the credential's home is that project, or it is shared
 * with it. Resources without a row belong to the default project on both sides.
 */
export function credentialUsableBy(credentialId: string, projectId: string | undefined): boolean {
  const home = storedHomeProject('credential', credentialId) ?? defaultProjectId();
  if (home === projectId) return true;
  return Boolean(projectId) && shares('credential', credentialId).some((share) => share.projectId === projectId);
}

/** Ids of the credentials a project may use (for the node panel's credential picker). */
export function usableCredentialIds(projectId: string | undefined, ids: Iterable<string>): Set<string> {
  const homes = homeProjects('credential');
  const fallback = defaultProjectId();
  const shared = new Set(
    projectId
      ? authDb()
          .all<{ resource_id: string }>('SELECT resource_id FROM resource_shares WHERE kind = ? AND project_id = ?', 'credential', projectId)
          .map((row) => row.resource_id)
      : [],
  );
  const usable = new Set<string>();
  for (const id of ids) if ((homes.get(id) ?? fallback) === projectId || shared.has(id)) usable.add(id);
  return usable;
}
