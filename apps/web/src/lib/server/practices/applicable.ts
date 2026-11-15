/**
 * What a caller may get, and the block for it (docs/practices.md#following). The one place that turns a caller into
 * project ids: GET /api/practices/applicable, the cite route and the MCP tools all come through here, so none can widen what
 * it gets. A repository, paths, topics or a task only narrow and rank (./select.ts); nothing a caller sends adds a practice.
 */
import { PRACTICE_BUDGETS, type ApprovedPractice, type ApplicablePractice, type ApplicableResponse, type PracticeLevel } from '../../shared/practices';
import { HttpError } from '../errors';
import { projectRole, visibleProjectIds, type Actor } from '../projects/access';
import { getProject, listProjects } from '../projects/store';
import { cleanSummary, practicesBlock } from './block';
import { redactPatterns, redactText } from '../secrets/redact';
import { practicesPort } from './port';
import { selectPractices, type PracticeQuery } from './select';

/** `full` for an agent's prompt, `mod` for Claude Code (the default), `index` for a remote agent's index. */
export const PRACTICE_SIZES = ['full', 'mod', 'index'] as const;
export type PracticeSize = (typeof PRACTICE_SIZES)[number];
export const sizeBudget = (size: PracticeSize): number => (size === 'full' ? PRACTICE_BUDGETS.inProcess : size === 'index' ? PRACTICE_BUDGETS.remote : PRACTICE_BUDGETS.mod);

/** Who is asking: a person (none: the instance access token), and the project a server or a request is limited to. */
export interface PracticeCaller {
  actor?: Actor;
  projectId?: string;
}

/**
 * Approved practices the caller may get, before any narrowing by what they asked for. Org practices always; project
 * practices of one project (the caller needs a role there, else 404), or of every project they have a role in. Without an
 * actor: org practices only. `repo` (the request's) keeps a project practice only when it lists it, when no project is
 * named; the cite route passes none and so sees them all.
 */
export function practicesFor(caller: PracticeCaller, options: { repo?: string } = {}): ApprovedPractice[] {
  const port = practicesPort();
  if (!port?.enabled()) return [];
  const { actor, projectId } = caller;
  if (projectId) {
    if (!actor || !getProject(projectId) || !projectRole(actor, projectId)) {
      if (actor) throw new HttpError('Project not found', 404);
      return port.approved({ projectIds: [] });
    }
    return port.approved({ projectIds: [projectId] });
  }
  if (!actor) return port.approved({ projectIds: [] });
  const visible = visibleProjectIds(actor);
  const projectIds = visible ? [...visible] : listProjects().map((p) => p.id);
  const wanted = options.repo;
  return port.approved({ projectIds }).filter((p) => p.level === 'org' || (wanted !== undefined && p.repos.includes(wanted)));
}

/** The same, for a caller that wants every project practice it may get whatever its repositories (citing). */
export function practicesCitable(caller: PracticeCaller): ApprovedPractice[] {
  const port = practicesPort();
  if (!port?.enabled()) return [];
  const { actor, projectId } = caller;
  if (projectId) return practicesFor(caller);
  if (!actor) return port.approved({ projectIds: [] });
  const visible = visibleProjectIds(actor);
  return port.approved({ projectIds: visible ? [...visible] : listProjects().map((p) => p.id) });
}

/** A title as one safe line. */
export const cleanTitle = (title: string): string => cleanSummary(redactPatterns(redactText(title)));

const cleanLine = (text: string): string => redactPatterns(redactText(text));

export const toApplicable = (p: ApprovedPractice): ApplicablePractice => ({
  id: p.id,
  ...(p.projectId && { projectId: p.projectId }),
  handle: p.handle,
  version: p.version,
  title: cleanTitle(p.title),
  level: p.level,
  strength: p.strength,
  summary: cleanSummary(p.summary),
  topics: p.topics.map(cleanLine),
  repos: p.repos.map(cleanLine),
  paths: p.paths.map(cleanLine),
});

export interface ApplicableOptions {
  size: PracticeSize;
  /** Do not write `delivered` rows (the Brain page and the CLI's dry look). */
  preview?: boolean;
}

/** The caller's practices for a query, as the block and its list; writes a `delivered` row per included practice unless `preview`. */
export function applicableFor(caller: PracticeCaller, q: PracticeQuery, options: ApplicableOptions): ApplicableResponse & { included: ApprovedPractice[] } {
  const budget = sizeBudget(options.size);
  const port = practicesPort();
  if (!port?.enabled()) return { practices: [], text: '', budget, omitted: 0, included: [] };
  const allowed = practicesFor(caller, { repo: q.repo });
  const block = practicesBlock(selectPractices(allowed, q), budget);
  if (!options.preview) {
    for (const p of block.included) port.record({ practiceId: p.id, version: p.version, kind: 'delivered', ...(caller.actor && { userId: caller.actor.id }), ...(q.repo && { repo: q.repo }) });
  }
  return { practices: block.included.map(toApplicable), text: block.text, budget, omitted: block.omitted, included: block.included };
}

/**
 * What delivery gives for a repository: the ids that apply, and the selector's winner per handle. Throws 404 for a project
 * the caller has no role in.
 */
export function deliveredFor(caller: PracticeCaller, repo?: string, paths?: string[], topics?: string[]): { applies: Set<string>; winners: Map<string, ApprovedPractice> } {
  const delivered = practicesFor(caller, { repo });
  return { applies: new Set(delivered.map((p) => p.id)), winners: new Map(selectPractices(delivered, { repo, paths, topics }).map((p) => [p.handle, p])) };
}

/** One approved practice in full, as every route and tool that gives its rules shows it: redacted, with its scope and machine checks. */
export const toFull = (p: ApprovedPractice) => ({
  handle: p.handle,
  version: p.version,
  title: cleanTitle(p.title),
  strength: p.strength,
  scope: { level: p.level, ...(p.projectId && { projectId: p.projectId }), topics: p.topics.map(cleanLine), repos: p.repos.map(cleanLine), paths: p.paths.map(cleanLine) },
  summary: cleanSummary(cleanLine(p.summary)),
  body: cleanLine(p.body),
  checks: JSON.parse(cleanLine(JSON.stringify(p.checks))) as ApprovedPractice['checks'],
});

/**
 * The one practice a handle means for this caller, exactly the one delivery gave for the same `repo`, `paths` and project: the
 * `projectId` match if one is asked for (a named project practice); else the selector's winner (the same filter by `repo`,
 * `paths` and `topics`, and ranking, that `applicableFor` uses). `level` keeps a winner of that level only. Undefined when delivery gave none: never an arbitrary
 * practice of another project or level. Throws 404 for a project the caller has no role in (set `caller.projectId`).
 */
export function resolvePractice(caller: PracticeCaller, handle: string, options: { repo?: string; paths?: string[]; topics?: string[]; projectId?: string; level?: PracticeLevel } = {}): ApprovedPractice | undefined {
  return resolveBy(caller, { handle }, options);
}

/**
 * The practice with this id, only when delivery gives it for the same `repo`, `paths` and `topics` the listing used (its id is in
 * `deliveredFor(...).applies`). Undefined otherwise: another project's, one the repository does not list, or a retired one.
 */
export function resolvePracticeById(caller: PracticeCaller, id: string, options: { repo?: string; paths?: string[]; topics?: string[]; level?: PracticeLevel } = {}): ApprovedPractice | undefined {
  return resolveBy(caller, { id }, options);
}

function resolveBy(caller: PracticeCaller, by: { handle?: string; id?: string }, options: { repo?: string; paths?: string[]; topics?: string[]; projectId?: string; level?: PracticeLevel }): ApprovedPractice | undefined {
  if (by.id !== undefined) {
    const found = practicesCitable(caller).find((p) => p.id === by.id && (!options.level || p.level === options.level));
    if (!found) return undefined;
    // In the listing for this scope: delivered for the repository, and the selector's winner of its handle for the paths and topics.
    const { applies, winners } = deliveredFor(caller, options.repo, options.paths, options.topics);
    return applies.has(found.id) && winners.get(found.handle)?.id === found.id ? found : undefined;
  }
  const handle = by.handle as string;
  const matches = practicesCitable(caller).filter((p) => p.handle === handle && (!options.level || p.level === options.level));
  if (!matches.length) return undefined;
  const byProject = options.projectId ? matches.find((p) => p.projectId === options.projectId) : undefined;
  if (byProject) return byProject;
  const winner = deliveredFor(caller, options.repo, options.paths, options.topics).winners.get(handle);
  return winner && matches.find((p) => p.id === winner.id);
}
