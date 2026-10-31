/**
 * The repository a run worked on, read from its journal (docs/run-trace.md#artifacts-and-code-changes): the
 * github.com URLs it names (artifact links, a step's `url`, a `git clone`), and the branch and pull request the GitHub
 * steps report. Pure: the detail sheet links commit SHAs, branches and pull request numbers with it, and the changes
 * route finds the branch to compare with it.
 */
import type { JournalEvent } from './run-trace';

export interface RunRepo {
  owner: string;
  repo: string;
  /** https://github.com/<owner>/<repo> */
  url: string;
}

export interface RunBranch {
  /** The branch the work is on (Create branch's output, the pull request's head, a push's target). */
  branch?: string;
  /** The branch it is meant for (the pull request's base). */
  base?: string;
  pullNumber?: number;
}

export interface RunGitHub extends RunRepo, RunBranch {}

const URL_PATTERN = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[/\s"'#?)\]>,;]|$)/g;
/** github.com paths that are not a repository. */
const NOT_OWNERS = new Set(['orgs', 'settings', 'marketplace', 'features', 'topics', 'sponsors', 'apps', 'login', 'about']);

const strings = (value: unknown, out: string[] = [], depth = 0): string[] => {
  if (typeof value === 'string') out.push(value);
  else if (depth < 4 && value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out, depth + 1);
  return out;
};

/** The repository named most often by github.com URLs in the run. */
export function repoOf(events: JournalEvent[], hint?: { owner: string; repo: string }): RunRepo | undefined {
  const count = new Map<string, number>();
  const note = (owner: string, repo: string, weight = 1) => {
    if (NOT_OWNERS.has(owner.toLowerCase())) return;
    const key = `${owner}/${repo}`;
    count.set(key, (count.get(key) ?? 0) + weight);
  };
  if (hint) note(hint.owner, hint.repo, 1000);
  for (const e of events) {
    const places: unknown[] =
      e.type === 'artifact' ? [e.artifact.url, e.artifact.data, e.artifact.text] : e.type === 'span.started' ? [e.input] : e.type === 'span.ended' ? [e.output] : [];
    for (const text of places.flatMap((p) => strings(p))) for (const m of text.matchAll(URL_PATTERN)) note(m[1], m[2]);
  }
  const [best] = [...count].sort((a, b) => b[1] - a[1]);
  if (!best) return undefined;
  const [owner, repo] = best[0].split('/');
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

/** `git push origin HEAD:<branch>` / `git push -u origin <branch>` in a command: the branch pushed to. */
function pushedBranch(command: string): string | undefined {
  for (const m of command.matchAll(/git\s+push\b([^&;|\n]*)/g)) {
    const args = m[1].split(/\s+/).filter((a) => a && !a.startsWith('-'));
    const target = args[1]?.replace(/^.*:/, '');
    if (target && target !== 'HEAD' && /^[\w./-]+$/.test(target)) return target;
  }
  return undefined;
}

/** The branch and pull request the run's GitHub steps report, the latest of each; else the branch an agent pushed to. */
export function branchOf(events: JournalEvent[]): RunBranch {
  const github = new Set<string>();
  const out: RunBranch = {};
  let pushed: string | undefined;
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.type === 'span.started') {
      if (e.attrs?.nodeType === 'github.github') github.add(e.spanId);
      const command = e.kind === 'tool' && e.input && typeof e.input === 'object' ? (e.input as Record<string, unknown>).command : undefined;
      if (typeof command === 'string') pushed = pushedBranch(command) ?? pushed;
    } else if (e.type === 'span.ended' && github.has(e.spanId) && e.status === 'success' && e.output && typeof e.output === 'object') {
      const o = e.output as Record<string, unknown>;
      if (typeof o.head === 'string' && typeof o.number === 'number') {
        out.branch = o.head.replace(/^.*:/, '');
        out.pullNumber = o.number;
        if (typeof o.base === 'string') out.base = o.base;
      } else if (typeof o.branch === 'string' && typeof o.ref === 'string') out.branch = o.branch;
    }
  }
  if (!out.branch && pushed) out.branch = pushed;
  return out;
}

/** The repository and branch of a run, when it names a repository. */
export function githubOf(events: JournalEvent[], hint?: { owner: string; repo: string }): RunGitHub | undefined {
  const repo = repoOf(events, hint);
  return repo && { ...repo, ...branchOf(events) };
}

export type RefPart = { text: string } | { text: string; href: string };

/** A commit SHA: 7 to 40 hex digits with a digit and a letter among them, so a word or a number alone is not one. */
const SHA = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/;
const PULL = /(?<![\w&/])#(\d{1,6})\b/;

/** The text split into plain parts and links: commit SHAs, `#12` pull requests and the branches named in `repo`. */
export function linkRefs(text: string, repo: RunGitHub): RefPart[] {
  // A branch named like a word ("main") would link every use of the word: only names with a separator are linked.
  const branches = [repo.branch, repo.base].filter((b): b is string => Boolean(b) && /[/_-]/.test(b!));
  const escaped = branches.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp([...(escaped.length ? [`(?<![\\w./-])(?:${escaped.join('|')})(?![\\w./-])`] : []), SHA.source, PULL.source].join('|'), 'g');
  const parts: RefPart[] = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const at = m.index!;
    const hit = m[0];
    const href = hit.startsWith('#') ? `${repo.url}/pull/${hit.slice(1)}` : branches.includes(hit) ? `${repo.url}/tree/${hit.split('/').map(encodeURIComponent).join('/')}` : `${repo.url}/commit/${hit}`;
    if (at > last) parts.push({ text: text.slice(last, at) });
    parts.push({ text: hit, href });
    last = at + hit.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
