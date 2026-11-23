/**
 * The one selector (docs/practices.md#following): which approved practices apply to a repository, some paths, some
 * topics and a task, in what order. Pure and deterministic. It only narrows and ranks what it is given: who may get a
 * practice at all is decided before it (./applicable.ts), so nothing here, and nothing a caller sends, adds a practice.
 */
import { matchesPracticeGlob, type ApprovedPractice } from '../../shared/practices';

export interface PracticeQuery {
  repo?: string;
  paths?: string[];
  topics?: string[];
  task?: string;
}

/** The words of a task that count: lowercase, three or more letters, each once. */
export function taskWords(task: string | undefined): string[] {
  return [...new Set((task ?? '').toLowerCase().match(/[a-z]{3,}/g) ?? [])];
}

/** How specific a practice is for a query: a matched path 3, a listed repo 2, a project practice 1, an org practice 0. */
function specificity(p: ApprovedPractice, q: PracticeQuery): number {
  if (q.paths?.length && p.paths.length && p.paths.some((glob) => q.paths!.some((path) => matchesPracticeGlob(glob, path)))) return 3;
  if (q.repo && p.repos.includes(q.repo)) return 2;
  return p.level === 'project' ? 1 : 0;
}

function taskScore(p: ApprovedPractice, words: string[]): number {
  if (!words.length) return 0;
  const haystack = `${p.title} ${p.summary} ${p.topics.join(' ')}`.toLowerCase();
  return words.filter((word) => haystack.includes(word)).length;
}

const strengthRank = (p: ApprovedPractice) => (p.strength === 'required' ? 0 : 1);

export function selectPractices(practices: ApprovedPractice[], q: PracticeQuery): ApprovedPractice[] {
  const kept = practices.filter((p) => {
    if (q.repo ? p.repos.length > 0 && !p.repos.includes(q.repo) : p.repos.length > 0) return false;
    if (q.paths?.length && p.paths.length > 0 && !p.paths.some((glob) => q.paths!.some((path) => matchesPracticeGlob(glob, path)))) return false;
    if (q.topics?.length && !p.topics.some((topic) => q.topics!.includes(topic))) return false;
    return true;
  });
  // One handle once: the project's practice stands in for the organization's.
  const byHandle = new Map<string, ApprovedPractice>();
  for (const p of kept) {
    const had = byHandle.get(p.handle);
    if (!had || (p.level === 'project' && had.level !== 'project')) byHandle.set(p.handle, p);
  }
  const words = taskWords(q.task);
  const scored = [...byHandle.values()].map((p) => ({ p, specificity: specificity(p, q), words: taskScore(p, words) }));
  scored.sort(
    (a, b) =>
      b.specificity - a.specificity ||
      strengthRank(a.p) - strengthRank(b.p) ||
      b.words - a.words ||
      (a.p.approvedAt < b.p.approvedAt ? 1 : a.p.approvedAt > b.p.approvedAt ? -1 : 0) ||
      (a.p.handle < b.p.handle ? -1 : a.p.handle > b.p.handle ? 1 : 0),
  );
  return scored.map((s) => s.p);
}
