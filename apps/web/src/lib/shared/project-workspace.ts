/**
 * A project's workspace for harness runs (docs/projects-and-goals.md#workspace): for each repository the project lists
 * (`projects.repos`, PC10), the branch to start from and the setup commands, whether a run gets its own worktree, and the
 * branch name template. Landflow stores and serves it (the route, GET /api/projects/context, the MCP `project_context`
 * tool); it never runs a setup command. The harness plan's stage 2 reads it. Shared by the server and the card; no runtime
 * imports, no zod. Written by the plan for Paperclip wave 9: PC16 owns it; nobody else adds it.
 */

/** At most this many setup lines per repository, each at most `SETUP_LINE_MAX` characters. */
export const SETUP_LINES_MAX = 10;
export const SETUP_LINE_MAX = 300;
/** A branch template's longest form. */
export const BRANCH_TEMPLATE_MAX = 120;
/** The tokens a branch template may use. */
export const BRANCH_TOKENS = ['project', 'run', 'date', 'task'] as const;
export type BranchToken = (typeof BRANCH_TOKENS)[number];

export interface WorkspaceRepo {
  /** The branch a run starts from; absent: the repository's default branch. */
  defaultBranch?: string;
  /** Commands a harness runs once in a fresh worktree, in order. Shown only to the project's editors and admins. */
  setup?: string[];
}

export interface ProjectWorkspace {
  /** Keyed by `owner/name` from `projects.repos`; a key the project no longer lists is dropped when read. */
  repos: Record<string, WorkspaceRepo>;
  /** per-run: a git worktree per run (the default); shared: runs share one checkout. */
  worktree: 'per-run' | 'shared';
  /** e.g. `landflow/{project}/{run}`; `{project}` is the project's slug. Must give a valid git branch name. */
  branchTemplate: string;
}

export const DEFAULT_WORKSPACE: ProjectWorkspace = { repos: {}, worktree: 'per-run', branchTemplate: 'landflow/{project}/{run}' };

/** GET /api/projects/:id/workspace (any role). PUT takes a `ProjectWorkspace` (project admins). */
export interface ProjectWorkspaceView {
  workspace: ProjectWorkspace;
  /** The project's repositories (`projects.repos`), in order. */
  repos: string[];
  /** A workspace was saved (else `workspace` is the default). */
  saved: boolean;
  /** The project's admins (and instance owners and admins). */
  canEdit: boolean;
  /** Setup commands are in the answer (editors and admins); viewers get `repos` without `setup`. */
  setupShown: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

/** A lowercase slug: accents dropped, letters and digits kept, runs of anything else as one '-', at most 40 characters, never empty ('project'). */
export function workspaceSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'project';
}

/**
 * The branch a template gives (pure): each `{token}` replaced by its value made safe for a ref (lowercase, `[a-z0-9._-]`
 * runs, no leading dot or dash), unknown tokens left as they are. `isValidBranch` says whether the result may be used.
 */
export function branchFor(template: string, values: Partial<Record<BranchToken, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, token: string) => {
    if (!(BRANCH_TOKENS as readonly string[]).includes(token)) return whole;
    const value = values[token as BranchToken];
    if (value === undefined || value === '') return whole;
    return value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[.-]+/, '')
      .slice(0, 60) || token;
  });
}

/** git's rules for a branch name (check-ref-format --branch), the subset a template can break. */
export function isValidBranch(name: string): boolean {
  if (!name || name.length > 200) return false;
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.startsWith('-')) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{') || name === '@') return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  return name.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}

/** Whether a template is usable: only known tokens, and the example it gives is a valid branch. */
export function templateProblem(template: string): string | undefined {
  if (!template.trim()) return 'Give a branch template';
  if (template.length > BRANCH_TEMPLATE_MAX) return `At most ${BRANCH_TEMPLATE_MAX} characters`;
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    if (!(BRANCH_TOKENS as readonly string[]).includes(match[1])) return `Unknown token {${match[1]}}: use {project}, {run}, {date} or {task}`;
  }
  const example = branchFor(template, { project: 'billing-revamp', run: 'r1a2b3', date: '2026-11-15', task: 't42' });
  return isValidBranch(example) ? undefined : `“${example}” is not a valid branch name`;
}
