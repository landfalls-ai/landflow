/**
 * Settings → Source control: Git on the server, like n8n's source control. Push exports the instance (the sync
 * format, ./format.ts) into a working copy under the data directory, commits it with a message and pushes the
 * branch; pull fetches the branch and applies its files (./index.ts applySync). The repository is a local path or a
 * remote URL plus a branch, optionally a sub-directory; the settings live in the `settings` table.
 *
 * Git runs as the `git` CLI through execFile (no shell) with the host account's git configuration ignored
 * (GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: no signing, credential helpers or hooks from there), prompts off, hooks
 * off, the `ext::` transport blocked and symlinks checked out as plain files (a branch can't point a workflow file
 * at a file outside the working copy). The working copy belongs to Landflow: every operation first resets it to the
 * remote branch. An HTTPS token comes from a saved credential or LANDFLOW_GIT_TOKEN and reaches git only through
 * GIT_ASKPASS and the child's environment, never the URL, the command line or the repository config. One operation
 * runs at a time.
 */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { SourceControlConfig, SourceControlPullResult, SourceControlPushResult, SourceControlRun, SourceControlView } from '../../shared/sync';
import { credentials as vault } from '../credentials/vault';
import { database, dataDir } from '../db';
import { singleton } from '../singleton';
import { readSyncDir, writeSyncDir } from './files';
import { MANIFEST_FILE, isSafePath } from './format';
import { applySync, exportState, type PlanOptions } from './index';

const SETTINGS_KEY = 'source_control';
const GIT_TIMEOUT_MS = Number(process.env.LANDFLOW_GIT_TIMEOUT_MS) || 120_000;
/** Fields of a credential that can hold the token, in order. */
const TOKEN_FIELDS = ['token', 'accessToken', 'password', 'apiKey', 'value', 'key'];

export class SourceControlError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'SourceControlError';
  }
}

interface StoredSourceControl {
  config?: SourceControlConfig;
  lastPush?: SourceControlRun;
  lastPull?: SourceControlRun;
  /** Entity hashes after the last push or pull: the base for the next pull's conflict check. */
  hashes?: Record<string, string>;
}

const baseDir = () => join(dataDir(), 'source-control');
/** The working copy. */
export const workingCopyDir = () => join(baseDir(), 'repo');

function read(): StoredSourceControl {
  try {
    return JSON.parse(database().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', SETTINGS_KEY)?.value ?? '{}') as StoredSourceControl;
  } catch {
    return {};
  }
}

function write(next: StoredSourceControl) {
  database().upsert('settings', { key: SETTINGS_KEY, value: JSON.stringify(next) });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Why a repository location is refused, or undefined when it is fine. */
export function repositoryProblem(value: string): string | undefined {
  if (value.startsWith('-')) return 'A repository can’t start with "-"';
  if (/^[a-z][\w+.-]*::/i.test(value)) return 'Remote helpers (transport::address) aren’t allowed';
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return 'Not a valid URL';
    }
    if (url.password || url.username) return 'Keep credentials out of the URL: pick a credential with the token, or set LANDFLOW_GIT_TOKEN';
    return undefined;
  }
  if (/^(file|ssh):\/\//i.test(value)) return undefined;
  if (/^[\w.-]+@[\w.-]+:[^\s]+$/.test(value)) return undefined;
  if (isAbsolute(value)) return undefined;
  return 'Use an absolute path, a file:// URL, or an https://, http:// or ssh:// remote';
}

/** A branch name git accepts (a subset of `git check-ref-format --branch`). */
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._\/-]+$/;
const branchOk = (name: string) => BRANCH.test(name) && !name.endsWith('.lock') && !name.endsWith('/') && !name.endsWith('.') && !name.startsWith('/');

export const sourceControlInputSchema = z.strictObject({
  repository: z
    .string()
    .trim()
    .min(1, 'Enter a repository')
    .max(2000)
    .superRefine((value, ctx) => {
      const problem = repositoryProblem(value);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    }),
  branch: z.string().trim().max(200).default('main').refine(branchOk, 'Not a valid branch name'),
  directory: z
    .string()
    .trim()
    .max(500)
    .default('')
    .transform((value) => value.replace(/^\/+|\/+$/g, ''))
    .refine((value) => value === '' || isSafePath(value), 'A relative path inside the repository'),
  credentialId: z.string().max(200).nullable().optional(),
  username: z.string().trim().max(200).optional(),
  authorName: z
    .string()
    .trim()
    .max(100)
    .refine((v) => !/[\u0000-\u001f<>]/.test(v), 'No control characters or <>')
    .optional(),
  authorEmail: z
    .string()
    .trim()
    .max(200)
    .refine((v) => v === '' || /^[^\s<>@]+@[^\s<>@]+$/.test(v), 'Not an email address')
    .optional(),
  includeVariableValues: z.boolean().optional(),
});
export type SourceControlInput = z.input<typeof sourceControlInputSchema>;

/** The token for HTTPS and where it came from. */
export function tokenFor(config: SourceControlConfig): { token?: string; source: SourceControlView['tokenSource']; credentialName?: string } {
  if (config.credentialId) {
    const detail = vault.get(config.credentialId);
    if (!detail) throw new SourceControlError('The source control credential was deleted: pick another one in Settings → Source control');
    const data = vault.dataFor({ id: detail.id, name: detail.name }, detail.type);
    const field = TOKEN_FIELDS.find((name) => typeof data[name] === 'string' && data[name]);
    if (!field) throw new SourceControlError(`Credential “${detail.name}” has no token, password or key`);
    return { token: String(data[field]), source: 'credential', credentialName: detail.name };
  }
  const env = process.env.LANDFLOW_GIT_TOKEN?.trim();
  return env ? { token: env, source: 'env' } : { source: 'none' };
}

export function sourceControlView(): SourceControlView {
  const stored = read();
  const view: SourceControlView = { configured: Boolean(stored.config), tokenSource: 'none', workingCopy: workingCopyDir() };
  if (stored.config) {
    view.config = stored.config;
    try {
      const { source, credentialName } = tokenFor(stored.config);
      view.tokenSource = source;
      if (credentialName) view.credentialName = credentialName;
    } catch {
      view.tokenSource = 'credential';
    }
  } else if (process.env.LANDFLOW_GIT_TOKEN?.trim()) view.tokenSource = 'env';
  if (stored.lastPush) view.lastPush = stored.lastPush;
  if (stored.lastPull) view.lastPull = stored.lastPull;
  return view;
}

/** Save the settings. A different repository, branch or directory forgets the last sync's base. */
export function configureSourceControl(input: z.output<typeof sourceControlInputSchema>): SourceControlView {
  if (input.credentialId && !vault.get(input.credentialId)) throw new SourceControlError('Credential not found', 404);
  const stored = read();
  const config: SourceControlConfig = {
    repository: input.repository,
    branch: input.branch,
    directory: input.directory,
    ...(input.credentialId && { credentialId: input.credentialId }),
    username: input.username || 'x-access-token',
    authorName: input.authorName || 'Landflow',
    authorEmail: input.authorEmail || 'landflow@localhost',
    includeVariableValues: input.includeVariableValues ?? false,
  };
  const before = stored.config;
  const moved = !before || before.repository !== config.repository || before.branch !== config.branch || before.directory !== config.directory;
  write({ ...stored, config, ...(moved && { hashes: undefined, lastPush: undefined, lastPull: undefined }) });
  return sourceControlView();
}

/** Forget the settings and remove the working copy. */
export function disconnectSourceControl(): SourceControlView {
  write({});
  rmSync(baseDir(), { recursive: true, force: true });
  return sourceControlView();
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

interface GitAuth {
  token?: string;
  username?: string;
}

const ASKPASS = `#!/bin/sh
# Landflow source control: answers git's credential prompts from the environment of this one git call.
case "$1" in
  Username*|username*) printf '%s\\n' "$LANDFLOW_GIT_USERNAME" ;;
  *) printf '%s\\n' "$LANDFLOW_GIT_PASSWORD" ;;
esac
`;

function askpassScript(): string {
  const path = join(baseDir(), 'askpass.sh');
  mkdirSync(baseDir(), { recursive: true });
  writeFileSync(path, ASKPASS, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

/** The environment of a git call: the host's git config ignored, no prompts, and the token for GIT_ASKPASS when there is one. */
export function gitEnvironment(auth: GitAuth = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    ...(process.env.SYSTEMROOT && { SYSTEMROOT: process.env.SYSTEMROOT }),
  };
  if (auth.token) {
    env.GIT_ASKPASS = askpassScript();
    env.LANDFLOW_GIT_USERNAME = auth.username || 'x-access-token';
    env.LANDFLOW_GIT_PASSWORD = auth.token;
  }
  return env;
}

/** Settings every call carries: no credential helpers, no hooks, no `ext::`, and symlinks checked out as plain files. */
export const SAFE_CONFIG = ['-c', 'credential.helper=', '-c', `core.hooksPath=${devNull}`, '-c', 'protocol.ext.allow=never', '-c', 'commit.gpgSign=false', '-c', 'core.symlinks=false'];

export function git(args: string[], options: { cwd: string; auth?: GitAuth }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', [...SAFE_CONFIG, ...args], { cwd: options.cwd, env: gitEnvironment(options.auth) as NodeJS.ProcessEnv, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout: String(stdout), stderr: String(stderr) });
      const text = String(stderr || stdout || error.message).trim();
      // Never echo a token back, should git ever print one.
      const clean = options.auth?.token ? text.split(options.auth.token).join('***') : text;
      reject(new SourceControlError(`git ${args.find((a) => !a.startsWith('-')) ?? ''}: ${clean.split('\n').slice(-3).join(' ').slice(0, 500)}`, 502));
    });
  });
}

/** One source-control operation at a time. */
const queue = singleton('source-control-queue', () => ({ tail: Promise.resolve() as Promise<unknown> }));
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.tail.then(fn, fn);
  queue.tail = run.catch(() => undefined);
  return run;
}

function requireConfig(): { stored: StoredSourceControl; config: SourceControlConfig } {
  const stored = read();
  if (!stored.config) throw new SourceControlError('Source control isn’t set up: add a repository in Settings → Source control', 409);
  return { stored, config: stored.config };
}

/** The working copy for `config`, created (or recreated for another repository) as needed. */
async function workingCopy(config: SourceControlConfig): Promise<string> {
  const cwd = workingCopyDir();
  let fresh = !existsSync(join(cwd, '.git'));
  if (!fresh) {
    const url = await git(['remote', 'get-url', 'origin'], { cwd }).then(
      (r) => r.stdout.trim(),
      () => '',
    );
    fresh = url !== config.repository;
  }
  if (fresh) {
    rmSync(cwd, { recursive: true, force: true });
    mkdirSync(cwd, { recursive: true });
    await git(['init', '-q', `--initial-branch=${config.branch}`], { cwd });
    await git(['remote', 'add', 'origin', config.repository], { cwd });
  }
  return cwd;
}

/** Fetch, then reset the working copy to the remote branch (or to an empty branch when the remote has none). */
async function syncBranch(cwd: string, config: SourceControlConfig, auth: GitAuth): Promise<boolean> {
  await git(['fetch', '-q', '--prune', '--no-tags', 'origin'], { cwd, auth });
  const remote = `refs/remotes/origin/${config.branch}`;
  const exists = await git(['rev-parse', '--verify', '-q', remote], { cwd }).then(
    () => true,
    () => false,
  );
  if (exists) {
    await git(['checkout', '-q', '-f', '-B', config.branch, remote], { cwd });
    await git(['clean', '-fdq'], { cwd });
  } else {
    await git(['symbolic-ref', 'HEAD', `refs/heads/${config.branch}`], { cwd });
    await git(['update-ref', '-d', `refs/heads/${config.branch}`], { cwd }).catch(() => undefined);
    await git(['read-tree', '--empty'], { cwd });
    await git(['clean', '-fdxq'], { cwd });
  }
  return exists;
}

const head = (cwd: string) =>
  git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd }).then(
    (r) => r.stdout.trim(),
    () => undefined,
  );

/**
 * Export the instance into the working copy, commit and push. A dry run stops before the commit and reports what it
 * would hold. Nothing to commit: `committed: false`.
 */
export function pushToRepository(input: { message?: string; dryRun?: boolean } = {}): Promise<SourceControlPushResult> {
  return exclusive(async () => {
    const { config } = requireConfig();
    const { token } = tokenFor(config);
    const auth = { token, username: config.username };
    const cwd = await workingCopy(config);
    await syncBranch(cwd, config, auth);
    const target = config.directory ? join(cwd, config.directory) : cwd;
    mkdirSync(target, { recursive: true });
    const exported = exportState({ values: config.includeVariableValues });
    writeSyncDir(target, exported.files);
    await git(['add', '-A', '--', config.directory || '.'], { cwd });
    const status = (await git(['diff', '--cached', '--name-status', '--no-renames'], { cwd })).stdout;
    const files = status
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [code, ...rest] = line.split('\t');
        return { status: code.trim(), path: rest.join('\t') };
      });
    const base = { dryRun: Boolean(input.dryRun), branch: config.branch, files };
    if (!files.length || input.dryRun) {
      const commit = await head(cwd);
      // Nothing to commit: the branch already holds the instance, so it is the base for the next pull.
      if (!files.length && !input.dryRun && commit) write({ ...read(), hashes: exported.hashes });
      return { ...base, committed: false, ...(commit && { commit }) };
    }
    const message = input.message?.trim() || `Update from Landflow (${exported.summary.workflows} workflow${exported.summary.workflows === 1 ? '' : 's'})`;
    await git(['-c', `user.name=${config.authorName}`, '-c', `user.email=${config.authorEmail}`, 'commit', '-q', '--no-verify', '-m', message], { cwd });
    const commit = (await head(cwd))!;
    try {
      await git(['push', '-q', 'origin', `HEAD:refs/heads/${config.branch}`], { cwd, auth });
    } catch (caught) {
      const text = (caught as Error).message;
      if (/rejected|non-fast-forward|fetch first/i.test(text)) throw new SourceControlError(`The branch ${config.branch} moved on while pushing; push again`, 409);
      throw caught;
    }
    write({ ...read(), lastPush: { at: new Date().toISOString(), commit, message, count: files.length }, hashes: exported.hashes });
    return { ...base, committed: true, commit };
  });
}

/**
 * Fetch the branch and apply its files (creates and updates by id; deletes with `prune`). A change the instance made
 * since the last push or pull is a conflict and stops the pull unless `force`. A dry run only plans.
 */
export function pullFromRepository(input: { dryRun?: boolean; prune?: boolean; force?: boolean; by?: string; publish?: PlanOptions['publish'] } = {}): Promise<SourceControlPullResult> {
  return exclusive(async () => {
    const { stored, config } = requireConfig();
    const { token } = tokenFor(config);
    const auth = { token, username: config.username };
    const cwd = await workingCopy(config);
    if (!(await syncBranch(cwd, config, auth))) throw new SourceControlError(`The branch ${config.branch} isn’t in the repository yet: push first`, 404);
    const commit = (await head(cwd))!;
    const files = readSyncDir(config.directory ? join(cwd, config.directory) : cwd);
    if (!files.some((f) => f.path === MANIFEST_FILE)) throw new SourceControlError(`No Landflow files (${MANIFEST_FILE}) in ${config.directory || 'the repository root'} on ${config.branch}`, 404);
    const note = `Source control pull (${commit.slice(0, 7)})`;
    const result = await applySync(files, { dryRun: input.dryRun, prune: input.prune, force: input.force, by: input.by, note, ...(input.publish && { publish: input.publish }), ...(stored.hashes && { base: stored.hashes }) });
    if (result.applied) {
      write({ ...read(), lastPull: { at: new Date().toISOString(), commit, count: result.appliedCount }, hashes: result.hashes });
    }
    return { ...result, commit, branch: config.branch };
  });
}
