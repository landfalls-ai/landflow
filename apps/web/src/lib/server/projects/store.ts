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
import { ALL_PROJECTS, personalProjectId, PROJECT_ROLES, type ProjectRole, type ProjectType, type ResourceKind, type ShareRole } from '../../shared/projects';
import { recordAudit } from '../audit';
import { can } from '../../shared/auth';
import { authDb } from '../auth/db';
import { getUser } from '../auth/users';
import { HttpError } from '../errors';

export interface ProjectRecord {
  id: string;
  name: string;
  type: ProjectType;
  ownerId?: string;
  description?: string;
  icon?: string;
  /** The brief (docs/projects-and-goals.md#the-brief): set through `updateProjectBrief`, kept by a rename. */
  brief?: string;
  briefConstraints?: string;
  doneWhen?: string;
  glossary?: string;
  status?: string;
  targetDate?: string;
  leadId?: string;
  decisionOwnerId?: string;
  repos?: string[]; // PC10: owner/name, lowercased
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

/** The brief fields of a project record, with the project record field each is stored in. */
export const BRIEF_FIELDS = [
  ['brief', 'brief'],
  ['constraints', 'briefConstraints'],
  ['doneWhen', 'doneWhen'],
  ['glossary', 'glossary'],
  ['status', 'status'],
  ['targetDate', 'targetDate'],
  ['leadId', 'leadId'],
  ['decisionOwnerId', 'decisionOwnerId'],
] as const;

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
  brief?: string | null;
  brief_constraints?: string | null;
  done_when?: string | null;
  glossary?: string | null;
  status?: string | null;
  target_date?: string | null;
  lead_id?: string | null;
  decision_owner_id?: string | null;
  repos?: string | null; // PC10: JSON
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

export class ProjectError extends HttpError {
  static readonly errorName: string = 'ProjectError';
  constructor(
    message: string,
    status = 400,
  ) {
    super(message, status, { expose: true });
  }
}

const db = () => authDb();

const isRole = (role: string): role is ProjectRole => (PROJECT_ROLES as readonly string[]).includes(role);

/** PC10: the repositories column (a JSON array of owner/name). */
function parseRepos(raw: string | null | undefined): string[] {
  try {
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function projectFrom(row: ProjectRow): ProjectRecord {
  const repos = parseRepos(row.repos);
  return {
    id: row.id,
    name: row.name,
    type: row.type === 'personal' ? 'personal' : 'team',
    ...(row.owner_id && { ownerId: row.owner_id }),
    ...(row.description && { description: row.description }),
    ...(row.icon && { icon: row.icon }),
    ...(row.brief && { brief: row.brief }),
    ...(row.brief_constraints && { briefConstraints: row.brief_constraints }),
    ...(row.done_when && { doneWhen: row.done_when }),
    ...(row.glossary && { glossary: row.glossary }),
    ...(row.status && { status: row.status }),
    ...(row.target_date && { targetDate: row.target_date }),
    ...(row.lead_id && { leadId: row.lead_id }),
    ...(row.decision_owner_id && { decisionOwnerId: row.decision_owner_id }),
    ...(repos.length && { repos }), // PC10
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
    brief: project.brief ?? null,
    brief_constraints: project.briefConstraints ?? null,
    done_when: project.doneWhen ?? null,
    glossary: project.glossary ?? null,
    status: project.status ?? null,
    target_date: project.targetDate ?? null,
    lead_id: project.leadId ?? null,
    decision_owner_id: project.decisionOwnerId ?? null,
    repos: project.repos?.length ? JSON.stringify(project.repos) : null, // PC10
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
  recordAudit({ action: 'project.create', target: { type: 'project', id: project.id, name: project.name }, project: project.id, summary: `Created the project ${project.name}`, details: { name: project.name } });
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
  const details: Record<string, string | null> = {};
  for (const field of ['name', 'description', 'icon'] as const) {
    if (project[field] !== next[field]) {
      details[`${field}From`] = project[field] ?? null;
      details[`${field}To`] = next[field] ?? null;
    }
  }
  if (Object.keys(details).length) recordAudit({ action: 'project.update', target: { type: 'project', id: id, name: next.name }, project: id, summary: `Changed the project ${next.name} (${Object.keys(details).filter((k) => k.endsWith('From')).map((k) => k.replace('From', '')).join(', ')})`, details });
  return next;
}

/**
 * A repository the project no longer lists loses its stored workspace entry (branch and setup lines), so re-adding it later
 * starts empty instead of bringing old setup lines back. A raw read and upsert of `project_workspaces` (PC16's table): this
 * module must not import `./workspace` (the `http.ts` import closure). A row that doesn't parse is left for the reader.
 */
function pruneWorkspaceRepos(id: string, repos: string[]): void {
  const row = db().get<{ project_id: string; data: string; updated_at: string; updated_by: string | null }>('SELECT * FROM project_workspaces WHERE project_id = ?', id);
  if (!row) return;
  let data: { repos?: Record<string, unknown> };
  try {
    data = JSON.parse(row.data) as { repos?: Record<string, unknown> };
  } catch {
    return;
  }
  const kept = Object.fromEntries(Object.entries(data.repos ?? {}).filter(([name]) => repos.includes(name)));
  if (Object.keys(kept).length === Object.keys(data.repos ?? {}).length) return;
  db().upsert('project_workspaces', { ...row, data: JSON.stringify({ ...data, repos: kept }) });
}

/** PC10: set the repositories a project lists (already validated and lowercased; [] clears). Audited. */
export function setProjectRepos(id: string, repos: string[]): ProjectRecord {
  const project = getProject(id);
  if (!project) throw new ProjectError('Project not found', 404);
  const next: ProjectRecord = { ...project, updatedAt: new Date().toISOString() };
  if (repos.length) next.repos = repos;
  else delete next.repos;
  if (JSON.stringify(project.repos ?? []) === JSON.stringify(repos)) return project;
  db().upsert('projects', projectRow(next));
  pruneWorkspaceRepos(id, repos);
  recordAudit({ action: 'project.update', target: { type: 'project', id, name: next.name }, project: id, summary: `Changed the repositories of ${next.name}`, details: { reposFrom: (project.repos ?? []).join(', ') || null, reposTo: repos.join(', ') || null } });
  return next;
}

/**
 * Set or clear brief fields (`null` clears; a field left out stays). Throws a 400 for a lead or decision owner who has no role in
 * the project. Audits `project.brief_changed` with each changed field's old and new value.
 */
export function updateProjectBrief(id: string, patch: Partial<Record<(typeof BRIEF_FIELDS)[number][0], string | null>>): ProjectRecord {
  const project = getProject(id);
  if (!project) throw new ProjectError('Project not found', 404);
  const next: ProjectRecord = { ...project, updatedAt: new Date().toISOString() };
  const changes: Record<string, { from: string | null; to: string | null }> = {};
  for (const [field, key] of BRIEF_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    const clean = value?.trim() || undefined;
    if ((field === 'leadId' || field === 'decisionOwnerId') && clean && !hasRoleIn(project, clean)) {
      throw new ProjectError(field === 'leadId' ? 'The lead must be a member of the project' : 'The decision owner must be a member of the project');
    }
    if (clean === project[key]) continue;
    changes[field] = { from: project[key] ?? null, to: clean ?? null };
    if (clean === undefined) delete next[key];
    else next[key] = clean;
  }
  if (!Object.keys(changes).length) return project;
  db().upsert('projects', projectRow(next));
  recordAudit({ action: 'project.brief_changed', target: { type: 'project', id, name: next.name }, project: id, summary: `Changed the brief of ${next.name} (${Object.keys(changes).join(', ')})`, details: Object.fromEntries(Object.entries(changes).flatMap(([field, change]) => [[`${field}From`, change.from], [`${field}To`, change.to]])) });
  return next;
}

/** Whether `userId` is an existing user with a role in the project (as `projectRole` defines it: a member, the personal project's owner, an instance owner or admin). */
function hasRoleIn(project: ProjectRecord, userId: string): boolean {
  const user = getUser(userId);
  if (!user) return false;
  return can(user, 'projects:manage') || project.ownerId === userId || !!memberRole(project.id, userId);
}

/**
 * Remove a project row with its members, the shares made to it, its `project_goals` rows and its own project goals with their links
 * (./transfer moves its resources first). Its project-level practices are retired, not deleted: their versions and applications
 * stay for the audit trail, and no agent gets them again (a practice approved by one project's people is never handed to another's). Sub-goals of a removed goal go up to its nearest remaining ancestor, or become roots.
 * Returns the ids of the practices it retired, so the caller can settle their inbox suggestions once the transaction holds.
 */
export function removeProjectRows(id: string): string[] {
  const database = db();
  const retired: string[] = [];
  const waiting: string[] = [];
  database.transaction(() => {
    const own = database.all<{ id: string; parent_id: string | null }>('SELECT id, parent_id FROM goals WHERE project_id = ?', id);
    const gone = new Map(own.map((g) => [g.id, g.parent_id]));
    const survivor = (parent: string | null): string | null => {
      for (let hops = 0; parent && gone.has(parent) && hops < 100; hops++) parent = gone.get(parent) ?? null;
      return parent && gone.has(parent) ? null : parent;
    };
    for (const goalId of gone.keys()) {
      for (const child of database.all<{ id: string }>('SELECT id FROM goals WHERE parent_id = ?', goalId)) {
        if (gone.has(child.id)) continue;
        const row = database.get<Record<string, string | null>>('SELECT * FROM goals WHERE id = ?', child.id);
        if (row) database.upsert('goals', { ...row, parent_id: survivor(gone.get(goalId) ?? null) });
      }
    }
    for (const goalId of gone.keys()) {
      for (const row of database.all<{ project_id: string }>('SELECT project_id FROM project_goals WHERE goal_id = ?', goalId)) database.delete('project_goals', { project_id: row.project_id, goal_id: goalId });
      for (const row of database.all<{ kind: string; ref_id: string }>('SELECT kind, ref_id FROM goal_links WHERE goal_id = ?', goalId)) database.delete('goal_links', { goal_id: goalId, kind: row.kind, ref_id: row.ref_id });
      database.delete('goals', { id: goalId });
    }
    for (const row of database.all<{ goal_id: string }>('SELECT goal_id FROM project_goals WHERE project_id = ?', id)) database.delete('project_goals', { project_id: id, goal_id: row.goal_id });
    // The same change as `markRetired` in ../practices/store.ts (status `retired`, updated_at), here in this transaction and without importing the practices store.
    for (const practice of database.all<{ id: string; handle: string }>("SELECT id, handle FROM practices WHERE project_id = ? AND status <> 'retired'", id)) {
      const row = database.get<Record<string, unknown>>('SELECT * FROM practices WHERE id = ?', practice.id);
      if (row) database.upsert('practices', { ...row, status: 'retired', updated_at: new Date().toISOString() });
      retired.push(practice.id);
      recordAudit({ action: 'practice.retired', target: { type: 'practice', id: practice.id, name: practice.handle }, project: id, summary: `Retired ${practice.handle}: its project was deleted` });
    }
    // PC14: its AI budget and incidents (deleted here, not through budgets/store.ts, which would pull the price table
    // into http.ts's import closure: test/runtime.test.ts).
    database.delete('project_budgets', { project_id: id });
    for (const row of database.all<{ id: string }>('SELECT id FROM project_budget_incidents WHERE project_id = ?', id)) database.delete('project_budget_incidents', { id: row.id });
    // Open requests to raise its cap are withdrawn (the same status `cancelCapRequest` sets); their waiting runs are stopped below.
    const capId = `project:${id}:month:cost`;
    for (const row of database.all<Record<string, string | number | null>>("SELECT * FROM ai_cap_requests WHERE cap_id = ? AND status IN ('pending', 'asking')", capId)) {
      database.upsert('ai_cap_requests', { ...row, status: 'cancelled', updated_at: new Date().toISOString() });
      if (typeof row.execution_id === 'string') waiting.push(row.execution_id);
    }
    database.delete('project_workspaces', { project_id: id }); // PC16: the workspace for harness runs
    // PC19: its tasks and their runs are its own data: deleted with it, never transferred (raw deletes: tasks/* would grow http.ts's import closure).
    for (const row of database.all<{ id: string }>('SELECT id FROM task_runs WHERE project_id = ?', id)) database.delete('task_runs', { id: row.id });
    for (const row of database.all<{ id: string }>('SELECT id FROM project_tasks WHERE project_id = ?', id)) database.delete('project_tasks', { id: row.id });
    database.delete('project_members', { project_id: id });
    for (const share of database.all<ShareRow>('SELECT * FROM resource_shares WHERE project_id = ?', id)) {
      database.delete('resource_shares', { kind: share.kind, resource_id: share.resource_id, project_id: id });
    }
    database.delete('projects', { id });
  });
  // After the transaction, and lazily (these modules would grow http.ts's import closure: test/runtime.test.ts): the meter forgets
  // the cached budget, and the runs that waited on a cap-raise answer stop waiting. Settled by the next tick.
  afterRemoved = import('../ai-usage').then(async ({ aiUsageMeter }) => {
    aiUsageMeter().invalidateBudgets();
    if (waiting.length) {
      const { cancelWaitingExecution } = await import('../runner');
      for (const executionId of waiting) cancelWaitingExecution(executionId);
    }
  }).catch(() => undefined);
  return retired;
}

/** The last lazy clean-up `removeProjectRows` started (tests await it). */
export let afterRemoved: Promise<void> = Promise.resolve();

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

/** The member's email for an audit line (the id when the user is gone). */
const memberLabel = (userId: string) => db().get<{ email: string }>('SELECT email FROM users WHERE id = ?', userId)?.email ?? userId;

/** One `project.member_change` event: who was added, removed or moved from one role to another, and by which route in (`source`). */
function auditMember(projectId: string, userId: string, from: ProjectRole | undefined, to: ProjectRole | undefined, source?: string | null) {
  const change = !from ? 'added' : !to ? 'removed' : 'changed';
  const email = memberLabel(userId);
  const name = getProject(projectId)?.name ?? projectId;
  recordAudit({
    action: 'project.member_change',
    target: { type: 'project', id: projectId, name },
    project: projectId,
    summary: `${change === 'added' ? `Added ${email} to ${name} as ${to}` : change === 'removed' ? `Removed ${email} from ${name}` : `Changed ${email}’s role in ${name} from ${from} to ${to}`}`,
    details: { change, userId, email, from: from ?? null, to: to ?? null, ...(source && { source }) },
  });
}

/** Write a member row without auditing it (callers that batch changes audit them after their transaction). */
function putMember(projectId: string, userId: string, role: ProjectRole, source?: string): ProjectRole | undefined {
  const project = getProject(projectId);
  if (!project) throw new ProjectError('Project not found', 404);
  if (project.type === 'personal') throw new ProjectError('Personal projects have one member: share with them instead', 400);
  if (!db().get('SELECT id FROM users WHERE id = ?', userId)) throw new ProjectError('User not found', 404);
  const existing = db().get<MemberRow>('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?', projectId, userId);
  db().upsert('project_members', { project_id: projectId, user_id: userId, role, created_at: existing?.created_at ?? new Date().toISOString(), source: source ?? null });
  return existing && isRole(existing.role) ? existing.role : undefined;
}

export function setMember(projectId: string, userId: string, role: ProjectRole, source?: string) {
  const before = putMember(projectId, userId, role, source);
  if (before !== role) auditMember(projectId, userId, before, role, source);
}

export function removeMember(projectId: string, userId: string, source?: string): boolean {
  const before = memberRole(projectId, userId);
  const removed = db().delete('project_members', { project_id: projectId, user_id: userId }) > 0;
  if (removed) auditMember(projectId, userId, before, undefined, source);
  return removed;
}

/** Replace a team project's members with `list` (one transaction; the changes are audited once it commits). */
export function replaceMembers(projectId: string, list: Array<{ userId: string; role: ProjectRole }>) {
  const database = db();
  const changes: Array<[string, ProjectRole | undefined, ProjectRole | undefined]> = [];
  database.transaction(() => {
    const wanted = new Map(list.map((m) => [m.userId, m.role]));
    for (const member of members(projectId)) {
      if (!wanted.has(member.userId)) {
        database.delete('project_members', { project_id: projectId, user_id: member.userId });
        changes.push([member.userId, member.role, undefined]);
      }
    }
    for (const [userId, role] of wanted) {
      const current = database.get<MemberRow>('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?', projectId, userId);
      // An unchanged row keeps who manages it (single sign-on or provisioning).
      if (current?.role === role) continue;
      changes.push([userId, putMember(projectId, userId, role), role]);
    }
  });
  for (const [userId, from, to] of changes) auditMember(projectId, userId, from, to);
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

/** Task counts per project (`project_tasks` rows; PC19): what deleting a project deletes with it. */
export function taskCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of db().all<{ project_id: string; n: number }>('SELECT project_id, COUNT(*) AS n FROM project_tasks GROUP BY project_id')) counts.set(row.project_id, Number(row.n));
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

/** Write a share without auditing it (a move keeps access, a project's shares follow its resources: those are part of their own event). */
export function putShare(kind: ResourceKind, id: string, projectId: string, role: ShareRole, createdBy?: string): ShareRole | undefined {
  const existing = db().get<ShareRow>('SELECT * FROM resource_shares WHERE kind = ? AND resource_id = ? AND project_id = ?', kind, id, projectId);
  db().upsert('resource_shares', { kind, resource_id: id, project_id: projectId, role, created_at: existing?.created_at ?? new Date().toISOString(), created_by: existing?.created_by ?? createdBy ?? null });
  return existing && shareFrom(existing).role;
}

/** `resource.share` (new, or its role moved) and `resource.unshare`: the kind, the resource, with whom and the role from → to. */
export function auditShare(kind: ResourceKind, id: string, projectId: string, from: ShareRole | undefined, to: ShareRole | undefined) {
  const withName = projectId === ALL_PROJECTS ? 'all projects' : (getProject(projectId)?.name ?? projectId); // PC06: the '*' share
  recordAudit({
    action: to ? 'resource.share' : 'resource.unshare',
    target: { type: kind, id },
    summary: to ? `Shared ${kind} ${id} with ${withName} as ${to}${from ? ` (was ${from})` : ''}` : `Stopped sharing ${kind} ${id} with ${withName}`,
    details: { kind, resourceId: id, withProjectId: projectId, withProject: withName, from: from ?? null, to: to ?? null },
  });
}

export function addShare(kind: ResourceKind, id: string, projectId: string, role: ShareRole, createdBy?: string) {
  const before = putShare(kind, id, projectId, role, createdBy);
  if (before !== role) auditShare(kind, id, projectId, before, role);
}

export function removeShare(kind: ResourceKind, id: string, projectId: string): boolean {
  const before = shares(kind, id).find((s) => s.projectId === projectId)?.role;
  const removed = db().delete('resource_shares', { kind, resource_id: id, project_id: projectId }) > 0;
  if (removed) auditShare(kind, id, projectId, before, undefined);
  return removed;
}

/** Replace a resource's shares with `list` (one transaction; the changes are audited once it commits). */
export function replaceShares(kind: ResourceKind, id: string, list: Array<{ projectId: string; role: ShareRole }>, createdBy?: string) {
  const database = db();
  const changes: Array<[string, ShareRole | undefined, ShareRole | undefined]> = [];
  database.transaction(() => {
    const wanted = new Map(list.map((s) => [s.projectId, s.role]));
    for (const share of shares(kind, id)) {
      if (wanted.has(share.projectId)) continue;
      database.delete('resource_shares', { kind, resource_id: id, project_id: share.projectId });
      changes.push([share.projectId, share.role, undefined]);
    }
    for (const [projectId, role] of wanted) {
      const before = putShare(kind, id, projectId, role, createdBy);
      if (before !== role) changes.push([projectId, before, role]);
    }
  });
  for (const [projectId, from, to] of changes) auditShare(kind, id, projectId, from, to);
}
