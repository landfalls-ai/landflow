/**
 * Project memberships an identity provider manages: SAML attributes (lib/server/auth/saml.ts) and SCIM groups
 * (lib/server/scim) map to team projects with a role. Rows they add carry their `source` (`saml`, `scim`), so a
 * later sign-in or sync removes the memberships the provider no longer grants without touching the ones people
 * added by hand.
 *
 * Mappings are written `idp-value=<project>:<role>` separated by commas, where `<project>` is a project id or a
 * team project's name and `<role>` is admin, editor or viewer (default editor), e.g.
 * `LANDFLOW_SAML_PROJECT_MAP="data-team=Data:editor,ops=prj_abc:viewer"`.
 */
import { PROJECT_ROLES, type ProjectRole } from '../../shared/projects';
import { authDb } from '../auth/db';
import { createTeamProject, findProject, membershipsOf, removeMember, setMember } from './store';

export interface ProjectGrant {
  /** A project id or a team project's name. */
  project: string;
  role: ProjectRole;
}

/** Parse `value=project:role,…` (the role defaults to `defaultRole`). */
export function parseProjectMap(text: string | undefined, defaultRole: ProjectRole = 'editor'): Record<string, ProjectGrant> {
  const map: Record<string, ProjectGrant> = {};
  for (const entry of (text ?? '').split(',')) {
    const index = entry.indexOf('=');
    if (index <= 0) continue;
    const value = entry.slice(0, index).trim();
    let target = entry.slice(index + 1).trim();
    let role: ProjectRole = defaultRole;
    const colon = target.lastIndexOf(':');
    if (colon > 0 && (PROJECT_ROLES as readonly string[]).includes(target.slice(colon + 1).trim().toLowerCase())) {
      role = target.slice(colon + 1).trim().toLowerCase() as ProjectRole;
      target = target.slice(0, colon).trim();
    }
    if (value && target) map[value] = { project: target, role };
  }
  return map;
}

/** The mapping as `{ value: "project:role" }`, for Settings → Security. */
export function describeProjectMap(map: Record<string, ProjectGrant>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([value, grant]) => [value, `${grant.project}:${grant.role}`]));
}

const RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, admin: 3 };

/**
 * The grants `values` (attribute values, group names) earn under `map`, one per project (the strongest role wins).
 * With `create`, a team project named in the map that doesn't exist yet is created.
 */
export function grantsFor(values: Iterable<string>, map: Record<string, ProjectGrant>, options: { create?: boolean; createdBy?: string } = {}): Array<{ projectId: string; role: ProjectRole }> {
  const byProject = new Map<string, ProjectRole>();
  for (const value of values) {
    const grant = map[value];
    if (!grant) continue;
    let project = findProject(grant.project);
    if (!project && options.create && !grant.project.startsWith('prj_')) project = createTeamProject({ name: grant.project, createdBy: options.createdBy });
    if (!project || project.type !== 'team') continue;
    const current = byProject.get(project.id);
    if (!current || RANK[grant.role] > RANK[current]) byProject.set(project.id, grant.role);
  }
  return [...byProject].map(([projectId, role]) => ({ projectId, role }));
}

/**
 * Make the memberships `source` manages for `userId` exactly `desired`: add or change those, and remove the ones of
 * that source that aren't wanted any more. A membership someone added by hand isn't removed, but a grant for the
 * same project takes it over (with the granted role). One transaction.
 */
export function syncManagedMemberships(userId: string, source: 'saml' | 'scim', desired: Array<{ projectId: string; role: ProjectRole }>) {
  const db = authDb();
  db.transaction(() => {
    const wanted = new Map(desired.map((grant) => [grant.projectId, grant.role]));
    for (const membership of membershipsOf(userId)) {
      if (membership.source === source && !wanted.has(membership.projectId)) removeMember(membership.projectId, userId);
    }
    for (const [projectId, role] of wanted) {
      const current = membershipsOf(userId).find((m) => m.projectId === projectId);
      if (current?.role === role && current.source === source) continue;
      setMember(projectId, userId, role, source);
    }
  });
}
