/** Projects as the API shows them (lib/shared/projects.ts `ProjectView`, `ProjectDetail`). */
import { PROJECT_ROLES, type ProjectDetail, type ProjectView } from '../../shared/projects';
import { listUsers } from '../auth/users';
import { projectRole, visibleProjectIds, type Actor } from './access';
import { ensurePersonalProject, listProjects, memberCounts, members, resourceCounts, type ProjectRecord } from './store';

export function projectView(project: ProjectRecord, actor: Actor, counts = resourceCounts(), memberTotals = memberCounts()): ProjectView {
  return {
    id: project.id,
    name: project.name,
    type: project.type,
    ...(project.description && { description: project.description }),
    ...(project.icon && { icon: project.icon }),
    ...(project.ownerId && { ownerId: project.ownerId }),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    ...(projectRole(actor, project.id) && { role: projectRole(actor, project.id) }),
    memberCount: memberTotals.get(project.id) ?? 0,
    counts: counts.get(project.id) ?? {},
  };
}

/** The projects `actor` sees: their personal project first, then team projects by name (owners and admins: all). */
export function visibleProjects(actor: Actor): ProjectView[] {
  ensurePersonalProject(actor.id);
  const visible = visibleProjectIds(actor);
  const counts = resourceCounts();
  const totals = memberCounts();
  return listProjects()
    .filter((project) => !visible || visible.has(project.id))
    .sort((a, b) => Number(b.ownerId === actor.id) - Number(a.ownerId === actor.id))
    .map((project) => projectView(project, actor, counts, totals));
}

export function projectDetail(project: ProjectRecord, actor: Actor): ProjectDetail {
  const users = new Map(listUsers().map((u) => [u.id, u]));
  return {
    ...projectView(project, actor),
    // Admins first, then editors and viewers, each by name.
    members: members(project.id)
      .flatMap((member) => {
        const user = users.get(member.userId);
        return user ? [{ userId: user.id, name: user.name, email: user.email, role: member.role, ...(member.source && { source: member.source }), createdAt: member.createdAt }] : [];
      })
      .sort((a, b) => PROJECT_ROLES.indexOf(a.role) - PROJECT_ROLES.indexOf(b.role) || a.name.localeCompare(b.name)),
  };
}
