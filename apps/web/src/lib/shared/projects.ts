/**
 * Projects and sharing (Wave 4), shared by the server (lib/server/projects) and the client. No runtime imports.
 *
 * Every user has a personal project, and owners and admins create team projects with members in a project role
 * (admin, editor, viewer). Workflows, credentials, data tables and agents belong to exactly one project (their home
 * project). Workflows and credentials can also be shared with other projects (sharing with a user = with their
 * personal project): workflows as editor or viewer, credentials for use (`user`: a workflow of that project may use
 * it in runs, nobody there sees its data). The instance owner and admins see and do everything.
 *
 * `resourceCan` is the one place that says which access allows which action; the server works out the access
 * (`resourceAccess` in lib/server/projects/access.ts) and the client uses the same table to hide what it can't do.
 */

export const PROJECT_ROLES = ['admin', 'editor', 'viewer'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];
export const PROJECT_ROLE_LABELS: Record<ProjectRole, string> = { admin: 'Admin', editor: 'Editor', viewer: 'Viewer' };
export const PROJECT_ROLE_HINTS: Record<ProjectRole, string> = {
  admin: 'Manages members, shares and moves what the project owns',
  editor: 'Creates, edits, runs and deletes the project’s workflows, credentials, data tables and agents',
  viewer: 'Sees the project’s workflows and executions',
};

export type ProjectType = 'personal' | 'team';

export const RESOURCE_KINDS = ['workflow', 'credential', 'dataTable', 'agent'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export const RESOURCE_LABELS: Record<ResourceKind, string> = { workflow: 'workflow', credential: 'credential', dataTable: 'data table', agent: 'agent' };

/** Kinds that can be shared with other projects. */
export const SHAREABLE_KINDS = ['workflow', 'credential'] as const satisfies readonly ResourceKind[];
export type ShareableKind = (typeof SHAREABLE_KINDS)[number];

/** A share's role: workflows are shared to edit or to view, credentials to use. */
export type ShareRole = 'editor' | 'viewer' | 'user';
export const SHARE_ROLES: Record<ShareableKind, readonly ShareRole[]> = { workflow: ['editor', 'viewer'], credential: ['user'] };
export const SHARE_ROLE_LABELS: Record<ShareRole, string> = { editor: 'Can edit', viewer: 'Can view', user: 'Can use' };

/** What someone does with one resource. */
export type ResourceAction = 'read' | 'use' | 'run' | 'update' | 'delete' | 'share' | 'move';

/**
 * Someone's access to one resource: the strongest role they have on it, and whether it comes from its home project
 * (or instance-wide: owners and admins) rather than a share.
 */
export interface ResourceAccess {
  role: ProjectRole | 'user';
  home: boolean;
}

/** Full access: the instance owner and admins. */
export const FULL_ACCESS: ResourceAccess = { role: 'admin', home: true };

const RANK: Record<ResourceAccess['role'], number> = { user: 0, viewer: 1, editor: 2, admin: 3 };

/** Whether `access` allows `action`. Deleting needs edit rights in the home project; sharing and moving its admin. */
export function resourceCan(access: ResourceAccess | undefined, action: ResourceAction): boolean {
  if (!access) return false;
  const rank = RANK[access.role];
  switch (action) {
    case 'read':
    case 'use':
      return true;
    case 'run':
    case 'update':
      return rank >= RANK.editor;
    case 'delete':
      return access.home && rank >= RANK.editor;
    case 'share':
    case 'move':
      return access.home && rank >= RANK.admin;
  }
}

/** The weaker of two roles (a viewer in a project a workflow is shared with as editor can only view it). */
export function weakerRole<R extends ResourceAccess['role']>(a: R, b: R): R {
  return RANK[a] <= RANK[b] ? a : b;
}

/** The stronger of two accesses (home wins a tie). */
export function strongerAccess(a: ResourceAccess | undefined, b: ResourceAccess | undefined): ResourceAccess | undefined {
  if (!a || !b) return a ?? b;
  if (RANK[a.role] !== RANK[b.role]) return RANK[a.role] > RANK[b.role] ? a : b;
  return a.home ? a : b;
}

/** Whether a project role may manage the project (members, name) and what can be done with its resources. */
export const projectRoleCan = {
  manage: (role: ProjectRole | undefined) => role === 'admin',
  create: (role: ProjectRole | undefined) => role === 'admin' || role === 'editor',
};

/** A project as listed (GET /api/projects). */
export interface ProjectView {
  id: string;
  name: string;
  type: ProjectType;
  description?: string;
  icon?: string;
  /** Personal projects: whose. */
  ownerId?: string;
  createdAt: string;
  updatedAt: string;
  /** The viewer's role in it (owners and admins are admins of every project). */
  role?: ProjectRole;
  memberCount: number;
  counts?: Partial<Record<ResourceKind, number>>;
}

export interface ProjectMemberView {
  userId: string;
  name: string;
  email: string;
  role: ProjectRole;
  /** Who added the membership: a person, single sign-on (`saml`) or provisioning (`scim`). */
  source?: string;
  createdAt: string;
}

export interface ProjectDetail extends ProjectView {
  members: ProjectMemberView[];
}

/** A share of a workflow or credential with a project. */
export interface ShareView {
  projectId: string;
  projectName: string;
  projectType: ProjectType;
  /** Personal projects: the user it belongs to. */
  userId?: string;
  role: ShareRole;
  createdAt: string;
  createdBy?: string;
}

/** Ownership and access of one resource, as list routes attach it to each item (`ownership`). */
export interface ResourceOwnership {
  projectId: string;
  projectName: string;
  projectType: ProjectType;
  /** The viewer's access. */
  access: ResourceAccess;
  /** Reached through a share rather than the home project. */
  shared: boolean;
}

/** Where a removed user's resources go (DELETE /api/users/<id> body). */
export type TransferTarget = { userId: string } | { projectId: string };

/** The id of a user's personal project. */
export const personalProjectId = (userId: string) => `personal_${userId}`;
