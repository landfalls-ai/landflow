/**
 * `landflow work context`: the project a repository belongs to and its "Where this work fits" block
 * (GET /api/projects/context, docs/connect-your-harness.md#project-context). The answer's shape is declared here and read
 * defensively: unknown fields are ignored and a bad answer is "no project".
 */
import type { Runner } from './collect';
import { originRepo } from './collect';

export const PROJECT_REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

export interface ProjectContextView {
  projects: Array<{ id: string; name: string }>;
  context: { projectId: string; size: 'full' | 'compact'; text: string } | null;
}

/** The answer as data: only well-formed projects and a text block; never throws. */
export function parseContext(raw: unknown): ProjectContextView {
  const answer = (raw && typeof raw === 'object' ? raw : {}) as { projects?: unknown; context?: unknown };
  const projects = (Array.isArray(answer.projects) ? answer.projects : [])
    .map((item) => {
      const p = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      return { id: typeof p.id === 'string' ? p.id : '', name: typeof p.name === 'string' ? p.name : '' };
    })
    .filter((p) => p.id && p.name);
  const c = (answer.context && typeof answer.context === 'object' ? answer.context : undefined) as Record<string, unknown> | undefined;
  const context = projects.length && c && typeof c.projectId === 'string' && typeof c.text === 'string' ? { projectId: c.projectId, size: c.size === 'full' ? ('full' as const) : ('compact' as const), text: c.text } : null;
  return { projects, context };
}

/** The text a person reads: the block, then the other projects; or the sentence that no project lists the repository. */
export function contextHuman(view: ProjectContextView, subject: string): string {
  if (!view.projects.length) return `No project lists ${subject}.`;
  const lines = [view.context?.text || `The project “${view.projects[0].name}” has no mission, goal or brief yet.`];
  if (view.projects.length > 1) lines.push(`Also listed in: ${view.projects.slice(1).map((p) => p.name).join(', ')}`);
  return lines.join('\n');
}

/** `--repo` (checked), else the origin remote of the working directory, else none. */
export async function repoFor(run: Runner, cwd: string, given: string | undefined): Promise<string | undefined> {
  if (given !== undefined) return PROJECT_REPO.test(given) ? given : undefined;
  return originRepo(run, cwd);
}
