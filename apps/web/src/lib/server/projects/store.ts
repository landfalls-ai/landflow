/**
 * Projects, members, home projects and shares in the database (migration 800). Every user has a personal project
 * (`personal_<userId>`, made on first use for users created after the migration); owners and admins create team
 * projects. `project_resources` says which project owns each workflow, credential, data table and agent; a resource
 * without a row belongs to the instance owner's personal project (what existed before projects, and what system
 * code such as Git sync or the instance MCP server creates). `resource_shares` shares workflows and credentials with
 * other projects.
 *
 * Writes that touch several rows (moving, deleting a project, transferring a removed user's resources) run in one
 * transaction (./transfer).
 */
import { nanoid } from 'nanoid';
import { personalProjectId, PROJECT_ROLES, type ProjectRole, type ProjectType, type ResourceKind, type ShareRole } from '../../shared/projects';
import { authDb } from '../auth/db';

export interface ProjectRecord {
  id: string;
  name: string;
  type: ProjectType;
  ownerId?: string;
  description?: string;
  icon?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface MemberRecord {
  projectId: string;
  userId: string;
  role: ProjectRole;
  createdAt: string;
  /** `personal` (the owner of a personal project), `saml`, `scim`, or none (added by a person). */
  source?: string;
}

export interface ShareRecord {
  kind: ResourceKind;
  resourceId: string;
  projectId: string;
  role: ShareRole;
  createdAt: string;
  createdBy?: string;
}

interface ProjectRow {
  id: string;
  name: string;
  type: string;
  owner_id: string | null;
  description: string | null;
  icon: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

interface MemberRow {
  project_id: string;
  user_id: string;
  role: string;
  created_at: string;
  source: string | null;
}

interface ShareRow {
  kind: string;
  resource_id: string;
  project_id: string;
  role: string;
  created_at: string;
  created_by: string | null;
}

export class ProjectError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const db = () => authDb();

const isRole = (role: string): role is ProjectRole => (PROJECT_ROLES as readonly string[]).includes(role);

function projectFrom(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    type: row.type === 'personal' ? 'personal' : 'team',
    ...(row.owner_id && { ownerId: row.owner_id }),
    ...(row.description && { description: row.description }),
    ...(row.icon && { icon: row.icon }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.created_by && { createdBy: row.created_by }),
  };
}

function projectRow(project: ProjectRecord) {
  return {
    id: project.id,
    name: project.name,
    type: project.type,
    owner_id: project.ownerId ?? null,
    description: project.description ?? null,
    icon: project.icon ?? null,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
    created_by: project.createdBy ?? null,
  };
}

const memberFrom = (row: MemberRow): MemberRecord => ({
  projectId: row.project_id,
  userId: row.user_id,
  role: isRole(row.role) ? row.role : 'viewer',
  createdAt: row.created_at,
  ...(row.source && { source: row.source }),
});

const shareFrom = (row: ShareRow): ShareRecord => ({
  kind: row.kind as ResourceKind,
  resourceId: row.resource_id,
  projectId: row.project_id,
  role: (['editor', 'viewer', 'user'].includes(row.role) ? row.role : 'viewer') as ShareRole,
  createdAt: row.created_at,
  ...(row.created_by && { createdBy: row.created_by }),
});

// ---- projects ---------------------------------------------------------------------------------------------

export function listProjects(): ProjectRecord[] {
  return db()
    .all<ProjectRow>(`SELECT * FROM projects ORDER BY CASE type WHEN 'team' THEN 1 ELSE 0 END, name, id`)
    .map(projectFrom);
}

export function getProject(id: string): ProjectRecord | undefined {
  const row = db().get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id);
  return row && projectFrom(row);
}

/** A team project by id, or by name (case-insensitive). */
export function findProject(idOrName: string): ProjectRecord | undefined {
  const byId = getProject(idOrName);
  if (byId) return byId;
  const row = db().get<ProjectRow>(`SELECT * FROM projects WHERE type = 'team' AND LOWER(name) = ? ORDER BY created_at LIMIT 1`, idOrName.trim().toLowerCase());
  return row && projectFrom(row);
}

/** The instance owner's id (unassigned resources are theirs), if setup is done. */
export function instanceOwnerId(): string | undefined {
  return db().get<{ id: string }>(`SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1`)?.id;
}

/** A user's personal project, made (with them as its admin) when it doesn't exist yet. Undefined for unknown users. */
export function ensurePersonalProject(userId: string): string | undefined {
  const id = personalProjectId(userId);
  const database = db();
  if (database.get('SELECT id FROM projects WHERE id = ?', id)) return id;
  const user = database.get<{ id: string; name: string; created_at: string }>('SELECT id, name, created_at FROM users WHERE id = ?', userId);
  if (!user) return undefined;
  const now = new Date().toISOString();
  database.transaction(() => {
    database.insertNew('projects', projectRow({ id, name: user.name, type: 'personal', ownerId: user.id, createdAt: now, updatedAt: now }));
    database.insertNew('project_members', { project_id: id, user_id: user.id, role: 'admin', created_at: now, source: 'personal' });
  });
  return id;
}

/** The project unassigned resources belong to: the instance owner's personal project (none before setup). */
export function defaultProjectId(): string | undefined {
  const owner = instanceOwnerId();
  return owner ? ensurePersonalProject(owner) : undefined;
}

export function createTeamProject(input: { name: string; description?: string; icon?: string; createdBy?: string }): ProjectRecord {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new ProjectError('Give the project a name');
  const now = new Date().toISOString();
  const project: ProjectRecord = {
    id: `prj_${nanoid(12)}`,
    name,
    type: 'team',
    ...(input.description?.trim() && { description: input.description.trim().slice(0, 500) }),
    ...(input.icon && { icon: input.icon.slice(0, 40) }),
    createdAt: now,
    updatedAt: now,
    ...(input.createdBy && { createdBy: input.createdBy }),
  };
  db().insertNew('projects', projectRow(project));
  return project;
}

export function updateProject(id: string, patch: { name?: string; description?: string | null; icon?: string | null }): ProjectRecord {
  const project = getProject(id);
  if (!project) throw new ProjectError('Project not found', 404);
  if (project.type === 'personal') throw new ProjectError('A personal project is named after its user', 400);
  const next: ProjectRecord = { ...project, updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) {
    const name = patch.name.trim().slice(0, 120);
    if (!name) throw new ProjectError('Give the project a name');
    next.name = name;
  }
  if (patch.description !== undefined) {
    if (patch.description?.trim()) next.description = patch.description.trim().slice(0, 500);
    else delete next.description;
  }
  if (patch.icon !== undefined) {
    if (patch.icon) next.icon = patch.icon.slice(0, 40);
    else delete next.icon;
  }
  db().upsert('projects', projectRow(next));
  return next;
}

/** Remove a project row with its members and the shares made to it (./transfer moves its resources first). */
export function removeProjectRows(id: string) {
  const database = db();
  database.transaction(() => {
    database.delete('project_members', { project_id: id });
    for (const share of database.all<ShareRow>('SELECT * FROM resource_shares WHERE project_id = ?', id)) {
      database.delete('resource_shares', { kind: share.kind, resource_id: share.resource_id, project_id: id });
    }
    database.delete('projects', { id });
  });
}

/** Keep a personal project's name in step with its user's. */
export function renamePersonalProject(userId: string, name: string) {
  const project = getProject(personalProjectId(userId));
  if (project && project.name !== name) db().upsert('projects', projectRow({ ...project, name, updatedAt: new Date().toISOString() }));
}

// ---- members ----------------------------------------------------------------------------------------------

export function members(projectId: string): MemberRecord[] {
  return db()
    .all<MemberRow>('SELECT * FROM project_members WHERE project_id = ? ORDER BY created_at, user_id', projectId)
    .map(memberFrom);
}

export function memberCounts(): Map<string, number> {
  return new Map(db().all<{ project_id: string; n: number }>('SELECT project_id, COUNT(*) AS n FROM project_members GROUP BY project_id').map((r) => [r.project_id, Number(r.n)]));
}

/** `userId`'s role in `projectId`, from its membership row. */
export function memberRole(projectId: string, userId: string): ProjectRole | undefined {
  const row = db().get<MemberRow>('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?', projectId, userId);
  return row && isRole(row.role) ? row.role : undefined;
}

/** Every project `userId` is a member of, with their role. */
export function membershipsOf(userId: string): MemberRecord[] {
  return db()
    .all<MemberRow>('SELECT * FROM project_members WHERE user_id = ?', userId)
    .map(memberFrom);
}

export function setMember(projectId: string, userId: string, role: ProjectRole, source?: string) {
  const project = getProject(projectId);
  if (!project) throw new ProjectError('Project not found', 404);
  if (project.type === 'personal') throw new ProjectError('Personal projects have one member: share with them instead', 400);
  if (!db().get('SELECT id FROM users WHERE id = ?', userId)) throw new ProjectError('User not found', 404);
  const existing = db().get<MemberRow>('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?', projectId, userId);
  db().upsert('project_members', { project_id: projectId, user_id: userId, role, created_at: existing?.created_at ?? new Date().toISOString(), source: source ?? null });
}

export function removeMember(projectId: string, userId: string): boolean {
  return db().delete('project_members', { project_id: projectId, user_id: userId }) > 0;
}

/** Replace a team project's members with `list` (one transaction). */
export function replaceMembers(projectId: string, list: Array<{ userId: string; role: ProjectRole }>) {
  const database = db();
  database.transaction(() => {
    const wanted = new Map(list.map((m) => [m.userId, m.role]));
    for (const member of members(projectId)) {
      if (!wanted.has(member.userId)) removeMember(projectId, member.userId);
    }
    for (const [userId, role] of wanted) {
      const current = database.get<MemberRow>('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?', projectId, userId);
      // An unchanged row keeps who manages it (single sign-on or provisioning).
      if (current?.role === role) continue;
      setMember(projectId, userId, role);
    }
  });
}

// ---- home projects ----------------------------------------------------------------------------------------

/** The project row of a resource (none = the default project, see `defaultProjectId`). */
export function storedHomeProject(kind: ResourceKind, id: string): string | undefined {
  return db().get<{ project_id: string }>('SELECT project_id FROM project_resources WHERE kind = ? AND resource_id = ?', kind, id)?.project_id;
}

/** The home project of a resource: its row, else the default project. */
export function homeProjectId(kind: ResourceKind, id: string): string | undefined {
  return storedHomeProject(kind, id) ?? defaultProjectId();
}

/** Home projects of every resource of a kind that has a row. */
export function homeProjects(kind: ResourceKind): Map<string, string> {
  return new Map(db().all<{ resource_id: string; project_id: string }>('SELECT resource_id, project_id FROM project_resources WHERE kind = ?', kind).map((r) => [r.resource_id, r.project_id]));
}

export function setHomeProject(kind: ResourceKind, id: string, projectId: string) {
  const database = db();
  const existing = database.get<{ created_at: string }>('SELECT created_at FROM project_resources WHERE kind = ? AND resource_id = ?', kind, id);
  database.transaction(() => {
    database.upsert('project_resources', { kind, resource_id: id, project_id: projectId, created_at: existing?.created_at ?? new Date().toISOString() });
    // The home project doesn't need a share as well.
    database.delete('resource_shares', { kind, resource_id: id, project_id: projectId });
  });
}

/** A resource was deleted: forget its home project and shares. */
export function forgetResource(kind: ResourceKind, id: string) {
  const database = db();
  database.transaction(() => {
    database.delete('project_resources', { kind, resource_id: id });
    for (const share of shares(kind, id)) database.delete('resource_shares', { kind, resource_id: id, project_id: share.projectId });
  });
}

/** Ids of the resources of a kind whose row names `projectId` (with `includeUnassigned`, also those without a row). */
export function resourceIdsIn(projectId: string, kind: ResourceKind): string[] {
  return db()
    .all<{ resource_id: string }>('SELECT resource_id FROM project_resources WHERE project_id = ? AND kind = ?', projectId, kind)
    .map((r) => r.resource_id);
}

/** Every resource row of a project, all kinds. */
export function resourcesIn(projectId: string): Array<{ kind: ResourceKind; id: string }> {
  return db()
    .all<{ kind: string; resource_id: string }>('SELECT kind, resource_id FROM project_resources WHERE project_id = ? ORDER BY kind, resource_id', projectId)
    .map((r) => ({ kind: r.kind as ResourceKind, id: r.resource_id }));
}

/** Resource counts per project and kind (rows only). */
export function resourceCounts(): Map<string, Partial<Record<ResourceKind, number>>> {
  const counts = new Map<string, Partial<Record<ResourceKind, number>>>();
  for (const row of db().all<{ project_id: string; kind: string; n: number }>('SELECT project_id, kind, COUNT(*) AS n FROM project_resources GROUP BY project_id, kind')) {
    const entry = counts.get(row.project_id) ?? {};
    entry[row.kind as ResourceKind] = Number(row.n);
    counts.set(row.project_id, entry);
  }
  return counts;
}

// ---- shares -----------------------------------------------------------------------------------------------

export function shares(kind: ResourceKind, id: string): ShareRecord[] {
  return db()
    .all<ShareRow>('SELECT * FROM resource_shares WHERE kind = ? AND resource_id = ? ORDER BY created_at, project_id', kind, id)
    .map(shareFrom);
}

/** Shares of every resource of a kind, by resource id. */
export function allShares(kind: ResourceKind): Map<string, ShareRecord[]> {
  const map = new Map<string, ShareRecord[]>();
  for (const row of db().all<ShareRow>('SELECT * FROM resource_shares WHERE kind = ?', kind)) {
    const list = map.get(row.resource_id) ?? [];
    list.push(shareFrom(row));
    map.set(row.resource_id, list);
  }
  return map;
}

/** Shares made to a project. */
export function sharesTo(projectId: string, kind?: ResourceKind): ShareRecord[] {
  const rows = kind
    ? db().all<ShareRow>('SELECT * FROM resource_shares WHERE project_id = ? AND kind = ?', projectId, kind)
    : db().all<ShareRow>('SELECT * FROM resource_shares WHERE project_id = ?', projectId);
  return rows.map(shareFrom);
}

export function addShare(kind: ResourceKind, id: string, projectId: string, role: ShareRole, createdBy?: string) {
  const existing = db().get<ShareRow>('SELECT * FROM resource_shares WHERE kind = ? AND resource_id = ? AND project_id = ?', kind, id, projectId);
  db().upsert('resource_shares', { kind, resource_id: id, project_id: projectId, role, created_at: existing?.created_at ?? new Date().toISOString(), created_by: existing?.created_by ?? createdBy ?? null });
}

export function removeShare(kind: ResourceKind, id: string, projectId: string): boolean {
  return db().delete('resource_shares', { kind, resource_id: id, project_id: projectId }) > 0;
}

/** Replace a resource's shares with `list` (one transaction). */
export function replaceShares(kind: ResourceKind, id: string, list: Array<{ projectId: string; role: ShareRole }>, createdBy?: string) {
  const database = db();
  database.transaction(() => {
    const wanted = new Map(list.map((s) => [s.projectId, s.role]));
    for (const share of shares(kind, id)) if (!wanted.has(share.projectId)) removeShare(kind, id, share.projectId);
    for (const [projectId, role] of wanted) addShare(kind, id, projectId, role, createdBy);
  });
}
