/**
 * Collect a day's Git activity in one allowed repository, through an injectable runner so tests never need Git. It
 * reads commit hashes, author dates, branch names, commit subjects and the names of the changed files (reduced to
 * directories in summary.ts). It never runs a diff, a show or a blame and never reads a file: the only commands it
 * issues are the ones listed in `COMMANDS_USED`.
 */
import { execFile } from 'node:child_process';

export type Runner = (command: string, args: string[], options: { cwd: string }) => Promise<{ code: number; stdout: string }>;

/** The real runner: a missing program answers code 127, never throws. */
export const defaultRunner: Runner = (command, args, options) =>
  new Promise((resolve) => {
    execFile(command, args, { cwd: options.cwd, maxBuffer: 32 * 1024 * 1024, timeout: 60_000 }, (error, stdout) => {
      if (!error) return resolve({ code: 0, stdout });
      const code = (error as { code?: unknown }).code;
      resolve({ code: typeof code === 'number' ? code : code === 'ENOENT' ? 127 : 1, stdout: stdout ?? '' });
    });
  });

export interface CollectedCommit {
  hash: string;
  at: string;
  subject: string;
  branches: string[];
  files: string[];
}

export interface CollectedPr {
  url: string;
  state: 'opened' | 'merged';
  day: string;
}

export interface CollectedRepo {
  commits: CollectedCommit[];
  currentBranch?: string;
  prs: CollectedPr[];
  /** Why part of the collection was skipped (no git user, gh absent). */
  notes: string[];
}

/** `owner/name` from an `origin` URL (https, ssh or scp-like), or undefined. */
export function parseRemote(url: string): string | undefined {
  const match = url.trim().match(/[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/** Branch names from a `%D` decoration list: local and `origin/` branches; tags and HEAD are left out. */
export function branchesFrom(decoration: string): string[] {
  const names = new Set<string>();
  for (const raw of decoration.split(',')) {
    let name = raw.trim();
    if (!name || name.startsWith('tag:')) continue;
    name = name.replace(/^HEAD -> /, '');
    if (name === 'HEAD' || name === 'origin/HEAD' || name.endsWith('/HEAD')) continue;
    names.add(name.replace(/^origin\//, ''));
  }
  return [...names];
}

/** Parse `git log --format=@@%H<TAB>%aI<TAB>%D<TAB>%s --name-only`. */
export function parseLog(output: string): CollectedCommit[] {
  const commits: CollectedCommit[] = [];
  let current: CollectedCommit | undefined;
  for (const line of output.split('\n')) {
    if (line.startsWith('@@')) {
      const [hash, at, decoration = '', ...subject] = line.slice(2).split('\t');
      current = { hash, at, subject: subject.join('\t'), branches: branchesFrom(decoration), files: [] };
      commits.push(current);
    } else if (line.trim() && current) current.files.push(line.trim());
  }
  return commits.filter((c) => c.hash && /^\d{4}-\d{2}-\d{2}T/.test(c.at));
}

/** The commands this module issues, for the tests: none of them reads a diff or a file's contents. */
export const COMMANDS_USED = ['git remote get-url origin', 'git config user.email', 'git config user.name', 'git rev-parse --abbrev-ref HEAD', 'git log --branches --remotes --author … --name-only', 'gh --version', 'gh pr list …'] as const;

export async function originRepo(run: Runner, path: string): Promise<string | undefined> {
  const out = await run('git', ['remote', 'get-url', 'origin'], { cwd: path });
  return out.code === 0 ? parseRemote(out.stdout) : undefined;
}

/** `since` is a day (`2026-11-14`) or an ISO time. */
export async function collectRepo(run: Runner, path: string, since: string): Promise<CollectedRepo> {
  const notes: string[] = [];
  const cwd = { cwd: path };
  let author = (await run('git', ['config', 'user.email'], cwd)).stdout.trim();
  if (!author) author = (await run('git', ['config', 'user.name'], cwd)).stdout.trim();
  let commits: CollectedCommit[] = [];
  if (!author) notes.push('No git user.email or user.name is configured here, so no commits were collected');
  else {
    // Git fills a bare day with the current time of day, so give it local midnight; and leave out refs/stash.
    const gitSince = /^\d{4}-\d{2}-\d{2}$/.test(since) ? `${since}T00:00:00` : since;
    const log = await run('git', ['log', '--branches', '--remotes', '--fixed-strings', `--author=${author}`, `--since=${gitSince}`, '--format=@@%H%x09%aI%x09%D%x09%s', '--name-only'], cwd);
    if (log.code === 0) {
      const sinceDay = since.slice(0, 10);
      commits = parseLog(log.stdout).filter((c) => c.at.slice(0, 10) >= sinceDay);
    } else notes.push('git log failed');
  }
  const head = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const currentBranch = head.code === 0 && head.stdout.trim() && head.stdout.trim() !== 'HEAD' ? head.stdout.trim() : undefined;

  const prs: CollectedPr[] = [];
  if ((await run('gh', ['--version'], cwd)).code === 0) {
    const sinceDay = since.slice(0, 10);
    const listed = await run('gh', ['pr', 'list', '--author', '@me', '--state', 'all', '--search', `updated:>=${sinceDay}`, '--json', 'url,state,updatedAt'], cwd);
    if (listed.code === 0) {
      try {
        const rows = JSON.parse(listed.stdout || '[]') as Array<{ url?: string; state?: string; updatedAt?: string }>;
        for (const row of rows) {
          const state = row.state === 'MERGED' ? 'merged' : row.state === 'OPEN' ? 'opened' : undefined;
          if (!state || !row.url || !/^https?:\/\//i.test(row.url) || !row.updatedAt) continue;
          const day = row.updatedAt.slice(0, 10);
          if (day >= sinceDay) prs.push({ url: row.url, state, day });
        }
      } catch {
        notes.push('gh answered something that is not JSON; pull requests were left out');
      }
    } else notes.push('gh could not list pull requests; they were left out');
  } else notes.push('gh is not installed, so pull requests were left out');
  return { commits, ...(currentBranch && { currentBranch }), prs, notes };
}
