/**
 * A project's workspace for harness runs (docs/projects-and-goals.md#workspace; migration 2701, `project_workspaces`): for each
 * repository the project lists, the branch to start from and the setup commands, whether a run gets its own worktree, and the
 * branch name template. Landflow stores and serves it; it never runs a setup command. Setup lines are for the project's editors
 * and admins. A repository the project no longer lists is dropped when the workspace is read, and `setProjectRepos` prunes it
 * from the stored row.
 */
import {
  BRANCH_TEMPLATE_MAX,
  DEFAULT_WORKSPACE,
  SETUP_LINES_MAX,
  SETUP_LINE_MAX,
  branchFor,
  isValidBranch,
  templateProblem,
  workspaceSlug,
  type ProjectWorkspace,
  type ProjectWorkspaceView,
  type WorkspaceRepo,
} from '../../shared/project-workspace';
import type { ProjectContextAnswer } from '../../shared/project-context-api';
import { projectRoleCan } from '../../shared/projects';
import { recordAudit } from '../audit';
import { HttpError } from '../errors';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';
import { isInstanceAdmin, projectRole, type Actor } from './access';
import { projectsDb } from './db';
import { getProject } from './store';

interface Row {
  project_id: string;
  data: string;
  updated_at: string;
  updated_by: string | null;
}

const CONTROL = /[\x00-\x1f\x7f]/;
const warned = () => singleton('project-workspace-warned', () => new Set<string>());

class WorkspaceError extends HttpError {
  static readonly errorName: string = 'WorkspaceError';
  constructor(message: string, status = 400) {
    super(message, status, { expose: true });
  }
}

/** The setup lines of a textarea or a list: split on newlines, trimmed, blank ones dropped. */
export function cleanSetup(lines: string[]): string[] {
  return lines.flatMap((line) => line.split(/\r?\n/)).map((line) => line.trim()).filter(Boolean);
}

/** Checks a workspace against the project's repositories and the limits; returns the cleaned value or throws a 400 with the message. */
export function validateWorkspace(input: ProjectWorkspace, projectRepos: string[]): ProjectWorkspace {
  if (input.worktree !== 'per-run' && input.worktree !== 'shared') throw new WorkspaceError('Worktree is per-run or shared');
  const template = input.branchTemplate.trim();
  const problem = templateProblem(template);
  if (problem) throw new WorkspaceError(problem);
  const repos: Record<string, WorkspaceRepo> = {};
  for (const [name, repo] of Object.entries(input.repos)) {
    if (!projectRepos.includes(name)) throw new WorkspaceError(`“${name}” isn't one of this project's repositories`);
    const next: WorkspaceRepo = {};
    const branch = repo.defaultBranch?.trim();
    if (branch) {
      if (!isValidBranch(branch)) throw new WorkspaceError(`“${branch}” is not a valid branch name (${name})`);
      next.defaultBranch = branch;
    }
    const setup = cleanSetup(repo.setup ?? []);
    if (setup.length > SETUP_LINES_MAX) throw new WorkspaceError(`At most ${SETUP_LINES_MAX} setup lines for ${name}`);
    for (const line of setup) {
      if (line.length > SETUP_LINE_MAX) throw new WorkspaceError(`A setup line for ${name} is longer than ${SETUP_LINE_MAX} characters`);
      if (CONTROL.test(line)) throw new WorkspaceError(`A setup line for ${name} has a control character`);
    }
    if (setup.length) next.setup = setup;
    repos[name] = next;
  }
  return { repos, worktree: input.worktree, branchTemplate: template };
}

/** What is saved, cleaned against the project's current repositories; a broken stored value reads as the default (logged once). */
function stored(projectId: string, projectRepos: string[]): { workspace: ProjectWorkspace; saved: boolean; row?: Row } {
  const row = projectsDb().get<Row>('SELECT * FROM project_workspaces WHERE project_id = ?', projectId);
  if (!row) return { workspace: structuredClone(DEFAULT_WORKSPACE), saved: false };
  try {
    const data = JSON.parse(row.data) as Partial<ProjectWorkspace>;
    const repos: Record<string, WorkspaceRepo> = {};
    for (const [name, repo] of Object.entries(data.repos ?? {})) {
      if (!projectRepos.includes(name)) continue;
      const clean: WorkspaceRepo = {};
      if (typeof repo?.defaultBranch === 'string' && repo.defaultBranch) clean.defaultBranch = repo.defaultBranch;
      if (Array.isArray(repo?.setup)) clean.setup = repo.setup.filter((l): l is string => typeof l === 'string');
      repos[name] = clean;
    }
    const worktree = data.worktree === 'shared' ? 'shared' : 'per-run';
    const branchTemplate = typeof data.branchTemplate === 'string' && data.branchTemplate.length <= BRANCH_TEMPLATE_MAX && !templateProblem(data.branchTemplate) ? data.branchTemplate : DEFAULT_WORKSPACE.branchTemplate;
    return { workspace: { repos, worktree, branchTemplate }, saved: true, row };
  } catch {
    if (!warned().has(projectId)) {
      warned().add(projectId);
      logger.warn('a project workspace could not be read; the default is used', { projectId });
    }
    return { workspace: structuredClone(DEFAULT_WORKSPACE), saved: false };
  }
}

const withoutSetup = (workspace: ProjectWorkspace): ProjectWorkspace => ({
  ...workspace,
  repos: Object.fromEntries(Object.entries(workspace.repos).map(([name, repo]) => [name, repo.defaultBranch ? { defaultBranch: repo.defaultBranch } : {}])),
});

/** Whether the caller sees setup lines: editors and admins of the project (owners and admins always). */
export function seesSetup(actor: Actor, projectId: string): boolean {
  const role = projectRole(actor, projectId);
  return isInstanceAdmin(actor) || (role !== undefined && projectRoleCan.create(role));
}

/** The workspace view for a caller with a role; 404 without one. */
export function workspaceView(actor: Actor, projectId: string): ProjectWorkspaceView {
  const project = getProject(projectId);
  const role = project && projectRole(actor, projectId);
  if (!project || !role) throw new WorkspaceError('Project not found', 404);
  const repos = project.repos ?? [];
  const { workspace, saved, row } = stored(projectId, repos);
  const setupShown = seesSetup(actor, projectId);
  return {
    workspace: setupShown ? workspace : withoutSetup(workspace),
    repos,
    saved,
    canEdit: projectRoleCan.manage(role),
    setupShown,
    ...(row ? { updatedAt: row.updated_at, ...(row.updated_by ? { updatedBy: row.updated_by } : {}) } : {}),
  };
}

/** Saves the workspace (project admins); audited with what changed, never the setup text. Answers the new view. */
export function saveWorkspace(actor: Actor, projectId: string, input: ProjectWorkspace): ProjectWorkspaceView {
  const project = getProject(projectId);
  const role = project && projectRole(actor, projectId);
  if (!project || !role) throw new WorkspaceError('Project not found', 404);
  if (!projectRoleCan.manage(role)) throw new WorkspaceError('Only the project’s admins change its workspace', 403);
  const next = validateWorkspace(input, project.repos ?? []);
  const { workspace: before, row } = stored(projectId, project.repos ?? []);
  // Nothing changed: no write and no audit event (as `setProjectRepos` does).
  if (row && row.data === JSON.stringify(next)) return workspaceView(actor, projectId);
  const now = new Date().toISOString();
  projectsDb().upsert('project_workspaces', { project_id: projectId, data: JSON.stringify(next), updated_at: now, updated_by: actor.id });
  const details: Record<string, unknown> = {};
  const changedRepos = Object.keys({ ...before.repos, ...next.repos }).filter((name) => JSON.stringify(before.repos[name]) !== JSON.stringify(next.repos[name]));
  if (changedRepos.length) {
    details.repos = changedRepos.join(', ');
    details.setupLines = changedRepos.map((name) => `${name}: ${next.repos[name]?.setup?.length ?? 0}`).join(', ');
  }
  if (before.worktree !== next.worktree) details.worktree = next.worktree;
  if (before.branchTemplate !== next.branchTemplate) details.branchTemplate = next.branchTemplate;
  recordAudit({ action: 'project.workspace.update', target: { type: 'project', id: projectId, name: project.name }, project: projectId, summary: `Changed the workspace of ${project.name}`, details });
  return workspaceView(actor, projectId);
}

/** The context answer's `workspace` for a project: only when one is saved; setup lines only for editors and admins. */
export function contextWorkspace(actor: Actor, projectId: string): ProjectContextAnswer['workspace'] {
  const project = getProject(projectId);
  if (!project) return undefined;
  const { workspace, saved } = stored(projectId, project.repos ?? []);
  if (!saved) return undefined;
  const shown = seesSetup(actor, projectId) ? workspace : withoutSetup(workspace);
  return {
    projectId,
    repos: shown.repos,
    worktree: shown.worktree,
    branchTemplate: shown.branchTemplate,
    branchPattern: branchFor(shown.branchTemplate, { project: workspaceSlug(project.name) }),
  };
}
