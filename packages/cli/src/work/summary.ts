/**
 * The summary of one repository's day, deterministic and without a model: counts, the first commit subjects (redacted,
 * clipped), the branches and the directories touched. Same input, same output. No code, diff, file name or path.
 */
import { hasFileExtension, isAbsolutePath, looksLikeCode, WORK_LIMITS, type WorkEventInput } from './contract';
import { makeRedactor } from '../redact';
import { WORK_SOURCE } from './held';
import type { CollectedCommit, CollectedPr } from './collect';

export interface DayInput {
  repo: string;
  day: string;
  commits: CollectedCommit[];
  prs: CollectedPr[];
  currentBranch?: string;
}

const SUBJECT_MAX = 60;
const SUBJECTS_SHOWN = 3;

/** Directory names for a list of changed files: the first two path segments of each file's directory, most touched first. */
export function areasFrom(files: string[]): string[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const parts = file.split('/').filter(Boolean);
    if (parts.length < 2) continue;
    const area = parts.slice(0, Math.min(2, parts.length - 1)).join('/');
    if (area.length > WORK_LIMITS.area || area.includes(',') || area.includes('..') || isAbsolutePath(area) || hasFileExtension(area)) continue;
    counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, WORK_LIMITS.areas).map(([area]) => area);
}

/** `token=abc`, `password: abc` and the like in a subject (redact.ts only knows JSON-style pairs and bearer tokens). */
const KEY_VALUE = /\b([A-Za-z0-9_-]*(?:secret|password|passwd|api[-_]?key|token)[A-Za-z0-9_-]*)\s*[=:]\s*\S+/gi;
const scrub = (text: string) => text.replace(KEY_VALUE, '$1=[redacted]');

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function summarizeDay(input: DayInput): WorkEventInput {
  const { redact } = makeRedactor();
  const commits = [...input.commits].sort((a, b) => a.at.localeCompare(b.at) || a.hash.localeCompare(b.hash));
  const branchCounts = new Map<string, number>();
  for (const commit of commits) for (const b of commit.branches) branchCounts.set(b, (branchCounts.get(b) ?? 0) + 1);
  const branches = [...branchCounts.entries()].sort((a, b) => b[1] - a[1] || Number(b[0] === input.currentBranch) - Number(a[0] === input.currentBranch) || a[0].localeCompare(b[0])).map(([b]) => b);
  if (!branches.length && input.currentBranch) branches.push(input.currentBranch);
  const branch = branches[0] ? clip(branches[0], WORK_LIMITS.branch) : undefined;

  const subjects = commits
    .map((c) => clip(scrub(redact(c.subject.replace(/\s+/g, ' ').trim())), SUBJECT_MAX))
    .filter(Boolean)
    .slice(0, SUBJECTS_SHOWN);
  const n = commits.length;
  const where = branches.length ? ` on ${clip(branches.slice(0, 2).join(', '), 60)}` : '';
  let title = n
    ? `${n} commit${n === 1 ? '' : 's'}${where}${subjects.length ? `: ${subjects.join('; ')}` : ''}`
    : `${input.prs.length} pull request${input.prs.length === 1 ? '' : 's'} on ${input.repo}`;
  title = clip(title, WORK_LIMITS.title);
  // A subject that reads like code must not make the whole title be refused: fall back to the counts.
  if (title.length > WORK_LIMITS.codeTitle && looksLikeCode(title)) title = clip(`${n} commit${n === 1 ? '' : 's'}${where}`, WORK_LIMITS.title);

  const areas = areasFrom(commits.flatMap((c) => c.files));
  const prs = [...new Map(input.prs.map((p) => [p.url, p])).values()].sort((a, b) => a.url.localeCompare(b.url)).slice(0, WORK_LIMITS.prs);
  const times = commits.map((c) => c.at);
  const occurredAt = times[0] ?? `${input.day}T00:00:00Z`;
  const endedAt = times.length > 1 ? times[times.length - 1] : undefined;
  const summary = [
    n ? `${n} commit${n === 1 ? '' : 's'}` : '',
    areas.length ? `in ${areas.slice(0, 5).join(', ')}` : '',
    prs.length ? `${prs.length} pull request${prs.length === 1 ? '' : 's'}` : '',
  ]
    .filter(Boolean)
    .join(', ');

  return {
    kind: 'work.session',
    source: WORK_SOURCE,
    sourceId: `${input.repo}@${input.day}`,
    occurredAt,
    ...(endedAt && { endedAt }),
    title,
    ...(summary && { summary: clip(summary, WORK_LIMITS.summary) }),
    repo: input.repo,
    ...(branch && { branch }),
    ...(areas.length && { areas }),
    commits: n,
    ...(prs.length && { prs: prs.map((p) => ({ url: p.url, state: p.state })) }),
  };
}

/** Group a repository's collected commits and PRs by day (the author's local day) and summarise each. */
export function summarizeRepo(repo: string, collected: { commits: CollectedCommit[]; prs: CollectedPr[]; currentBranch?: string }): Array<{ day: string; event: WorkEventInput }> {
  const days = new Set([...collected.commits.map((c) => c.at.slice(0, 10)), ...collected.prs.map((p) => p.day)]);
  return [...days]
    .sort()
    .map((day) => ({
      day,
      event: summarizeDay({
        repo,
        day,
        currentBranch: collected.currentBranch,
        commits: collected.commits.filter((c) => c.at.slice(0, 10) === day),
        prs: collected.prs.filter((p) => p.day === day),
      }),
    }));
}
