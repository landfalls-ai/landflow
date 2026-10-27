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
 * GIT_ASKPASS and the child's environment, never the URL, the command line or the repository config. SSH remotes use
 * the host account's keys, or a private key from a saved credential: written to a private temporary directory for the
 * one git call, with the host keys pinned in the settings (StrictHostKeyChecking, no agent, no agent forwarding, no
 * ssh config of the host). Push can commit just some workflows; each workflow has a history (the commits that touched
 * its file, the diff, restore a version as a draft). One operation runs at a time.
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { GitCommitDetail, GitHistory, HostKeyScan, SourceControlConfig, SourceControlPullResult, SourceControlPushResult, SourceControlRun, SourceControlView } from '../../shared/sync';
import { hasSecretReference } from '@landflow/engine';
import { credentials as vault } from '../credentials/vault';
import { database, dataDir } from '../db';
import { resolveSecretFields } from '../secrets/resolve';
import { singleton } from '../singleton';
import { store } from '../store';
import { readSyncDir, writeSyncDir } from './files';
import { MANIFEST_FILE, WORKFLOWS_DIR, WORKFLOW_SUFFIX, entityKey, isManagedPath, isSafePath, renderState } from './format';
import { applySync, currentState, exportState, restoreWorkflow, workflowKeys, type PlanOptions } from './index';

const SETTINGS_KEY = 'source_control';
const GIT_TIMEOUT_MS = Number(process.env.LANDFLOW_GIT_TIMEOUT_MS) || 120_000;
/** Fields of a credential that can hold the token, in order. */
const TOKEN_FIELDS = ['token', 'accessToken', 'password', 'apiKey', 'value', 'key'];
/** Fields of a credential that can hold an SSH private key, in order (any other field with a PEM private key works too). */
const SSH_KEY_FIELDS = ['privateKey', 'sshPrivateKey', 'sshKey', 'key'];
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

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

/** Whether `repository` is reached over SSH (`ssh://` or `user@host:path`). */
export function isSshRepository(repository: string): boolean {
  return /^ssh:\/\//i.test(repository) || /^[\w.-]+@[\w.-]+:[^\s]+$/.test(repository);
}

/** The host and port of an SSH repository string. */
export function sshHostOf(repository: string): { host: string; port: number } | undefined {
  if (/^ssh:\/\//i.test(repository)) {
    try {
      const url = new URL(repository);
      return url.hostname ? { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || 22 } : undefined;
    } catch {
      return undefined;
    }
  }
  const match = /^[\w.-]+@([\w.-]+):/.exec(repository);
  return match ? { host: match[1], port: 22 } : undefined;
}

/** Why pinned host keys are refused, or undefined when every line is a plain `host keytype base64` entry. */
export function knownHostsProblem(text: string): string | undefined {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return 'Pin at least one host key (use “Fetch host key” and check its fingerprint)';
  for (const line of lines) {
    if (!/^[^\s@]\S* (ssh-[a-z0-9-]+|ecdsa-sha2-nistp\d+|sk-[a-z0-9@.-]+) [A-Za-z0-9+/]+={0,2}( \S.*)?$/.test(line)) return `Not a known_hosts entry (host, key type, key): ${line.slice(0, 60)}`;
  }
  return undefined;
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
  sshCredentialId: z.string().max(200).nullable().optional(),
  knownHosts: z.string().max(20_000).optional(),
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
}).superRefine((value, ctx) => {
  if (!value.sshCredentialId) return;
  if (!isSshRepository(value.repository)) ctx.addIssue({ code: 'custom', path: ['sshCredentialId'], message: 'An SSH key goes with an ssh:// or user@host:path repository' });
  const problem = knownHostsProblem(value.knownHosts ?? '');
  if (problem) ctx.addIssue({ code: 'custom', path: ['knownHosts'], message: problem });
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

/**
 * The token git gets: `tokenFor`'s, with `$secrets` resolved when the credential's field reads an external secret
 * (`{{ $secrets.vault.git.token }}`), right before each push, pull or promotion (same cache and redaction).
 */
export async function resolvedTokenFor(config: SourceControlConfig): Promise<ReturnType<typeof tokenFor>> {
  const found = tokenFor(config);
  if (!found.token || !hasSecretReference(found.token)) return found;
  try {
    const { token } = await resolveSecretFields({ token: found.token }, `Credential “${found.credentialName ?? 'source control'}”`);
    return { ...found, token };
  } catch (error) {
    throw new SourceControlError((error as Error).message);
  }
}

/** The private key (and passphrase) of the SSH credential, with `$secrets` resolved. */
export async function resolvedSshKeyFor(credentialId: string): Promise<{ privateKey: string; passphrase?: string; credentialName: string }> {
  const detail = vault.get(credentialId);
  if (!detail) throw new SourceControlError('The SSH key credential was deleted: pick another one in Settings → Source control');
  const data = vault.dataFor({ id: detail.id, name: detail.name }, detail.type);
  const strings = Object.entries(data).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '');
  const field = SSH_KEY_FIELDS.find((name) => data[name] !== undefined && typeof data[name] === 'string' && data[name]) ?? strings.find(([, value]) => PEM_PRIVATE_KEY.test(value))?.[0];
  if (!field) throw new SourceControlError(`Credential “${detail.name}” has no private key (a field holding -----BEGIN … PRIVATE KEY-----)`);
  const fields: Record<string, string> = { privateKey: String(data[field]) };
  if (typeof data.passphrase === 'string' && data.passphrase) fields.passphrase = data.passphrase;
  let resolved = fields;
  if (Object.values(fields).some((v) => hasSecretReference(v))) {
    try {
      resolved = await resolveSecretFields(fields, `Credential “${detail.name}”`);
    } catch (error) {
      throw new SourceControlError((error as Error).message);
    }
  }
  // A key pasted into a form often loses its final newline; ssh refuses a key file without one.
  const privateKey = resolved.privateKey.replace(/\r\n/g, '\n').trim();
  if (!PEM_PRIVATE_KEY.test(privateKey)) throw new SourceControlError(`Credential “${detail.name}”: the private key isn’t a PEM key (-----BEGIN … PRIVATE KEY-----)`);
  return { privateKey: `${privateKey}\n`, ...(resolved.passphrase && { passphrase: resolved.passphrase }), credentialName: detail.name };
}

/** What git needs to reach `config`'s repository: the HTTPS token, or the SSH key and the pinned host keys. */
export async function gitAuthFor(config: SourceControlConfig): Promise<GitAuth> {
  if (config.sshCredentialId && isSshRepository(config.repository)) {
    const problem = knownHostsProblem(config.knownHosts ?? '');
    if (problem) throw new SourceControlError(`SSH with a key from a credential needs pinned host keys: ${problem}`);
    const { privateKey, passphrase } = await resolvedSshKeyFor(config.sshCredentialId);
    return { ssh: { privateKey, passphrase, knownHosts: config.knownHosts!.trim() + '\n' } };
  }
  const { token } = await resolvedTokenFor(config);
  return { token, username: config.username };
}

export function sourceControlView(): SourceControlView {
  const stored = read();
  const view: SourceControlView = { configured: Boolean(stored.config), tokenSource: 'none', workingCopy: workingCopyDir() };
  if (stored.config) {
    view.config = stored.config;
    view.transport = isSshRepository(stored.config.repository) ? 'ssh' : /^https?:\/\//i.test(stored.config.repository) ? 'https' : 'local';
    if (stored.config.sshCredentialId) view.sshCredentialName = vault.get(stored.config.sshCredentialId)?.name;
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
  if (input.sshCredentialId && !vault.get(input.sshCredentialId)) throw new SourceControlError('SSH key credential not found', 404);
  const stored = read();
  const config: SourceControlConfig = {
    repository: input.repository,
    branch: input.branch,
    directory: input.directory,
    ...(input.credentialId && { credentialId: input.credentialId }),
    ...(input.sshCredentialId && { sshCredentialId: input.sshCredentialId, knownHosts: (input.knownHosts ?? '').trim() }),
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

export interface GitAuth {
  token?: string;
  username?: string;
  /** An SSH key from a credential and the pinned host keys: written to a private temporary directory for the call. */
  ssh?: { privateKey: string; passphrase?: string; knownHosts: string };
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

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The ssh command for a key from a credential: only that key (no agent, no agent forwarding, no host ssh config,
 * no other identities), only the pinned host keys, no password logins, no forwarding of any kind.
 */
export function sshCommand(files: { key: string; knownHosts: string }, passphrase: boolean): string {
  const options = [
    `-F ${devNull}`,
    `-i ${shellQuote(files.key)}`,
    'IdentitiesOnly=yes',
    'IdentityAgent=none',
    'ForwardAgent=no',
    'ForwardX11=no',
    'ClearAllForwardings=yes',
    'StrictHostKeyChecking=yes',
    `UserKnownHostsFile=${shellQuote(files.knownHosts)}`,
    `GlobalKnownHostsFile=${devNull}`,
    'UpdateHostKeys=no',
    'VerifyHostKeyDNS=no',
    'CheckHostIP=no',
    'ProxyCommand=none',
    'ProxyJump=none',
    'ControlMaster=no',
    'ControlPath=none',
    'PreferredAuthentications=publickey',
    'PasswordAuthentication=no',
    'KbdInteractiveAuthentication=no',
    'ConnectTimeout=20',
    'LogLevel=ERROR',
    // A passphrase is answered through SSH_ASKPASS; BatchMode would refuse to ask.
    ...(passphrase ? ['NumberOfPasswordPrompts=1'] : ['BatchMode=yes']),
  ];
  return `ssh ${options.map((o) => (o.startsWith('-') ? o : `-o ${o}`)).join(' ')}`;
}

/** Write the key and the host keys into a fresh private directory, run `fn`, and delete them. */
async function withSshFiles<T>(ssh: NonNullable<GitAuth['ssh']>, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  mkdirSync(baseDir(), { recursive: true, mode: 0o700 });
  const dir = join(baseDir(), `ssh-${randomBytes(8).toString('hex')}`);
  mkdirSync(dir, { mode: 0o700 });
  const key = join(dir, 'id');
  const knownHosts = join(dir, 'known_hosts');
  try {
    writeFileSync(key, ssh.privateKey, { mode: 0o600 });
    writeFileSync(knownHosts, ssh.knownHosts, { mode: 0o600 });
    const env: Record<string, string> = { GIT_SSH_COMMAND: sshCommand({ key, knownHosts }, Boolean(ssh.passphrase)) };
    if (ssh.passphrase) {
      env.SSH_ASKPASS = askpassScript();
      env.SSH_ASKPASS_REQUIRE = 'force';
      env.LANDFLOW_GIT_USERNAME = '';
      env.LANDFLOW_GIT_PASSWORD = ssh.passphrase;
    }
    return await fn(env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Settings every call carries: no credential helpers, no hooks, no `ext::`, and symlinks checked out as plain files. */
export const SAFE_CONFIG = ['-c', 'credential.helper=', '-c', `core.hooksPath=${devNull}`, '-c', 'protocol.ext.allow=never', '-c', 'commit.gpgSign=false', '-c', 'core.symlinks=false'];

export function git(args: string[], options: { cwd: string; auth?: GitAuth }): Promise<{ stdout: string; stderr: string }> {
  const run = (extra: Record<string, string> = {}) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const env = { ...gitEnvironment(options.auth), ...extra } as NodeJS.ProcessEnv;
      execFile('git', [...SAFE_CONFIG, ...args], { cwd: options.cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (!error) return resolve({ stdout: String(stdout), stderr: String(stderr) });
        const text = String(stderr || stdout || error.message).trim();
        // Never echo a token or passphrase back, should git ever print one.
        const clean = [options.auth?.token, options.auth?.ssh?.passphrase].reduce<string>((t, secret) => (secret ? t.split(secret).join('***') : t), text);
        // The pinned host keys are the one thing the reader must hear about, whatever else git adds after it.
        const hostKey = options.auth?.ssh && /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(clean) ? 'The server’s SSH host key is not one of the pinned host keys (Host key verification failed). ' : '';
        reject(new SourceControlError(`git ${args.find((a) => !a.startsWith('-')) ?? ''}: ${hostKey}${clean.split('\n').slice(-3).join(' ').slice(0, 500)}`, 502));
      });
    });
  return options.auth?.ssh ? withSshFiles(options.auth.ssh, run) : run();
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

/** The base for the next pull's conflict check after a push: everything for a full push; for some workflows only theirs (and their folders') move. */
function basisAfter(previous: Record<string, string> | undefined, exported: Record<string, string>, picked: string[] | undefined): Record<string, string> | undefined {
  if (!picked) return exported;
  // Never synced as a whole: there is no base to update (the files simply win on the next pull).
  if (!previous) return undefined;
  const state = currentState();
  const folderIds = new Set<string>();
  const byId = new Map(state.folders.map((f) => [f.id, f]));
  for (const id of picked) {
    for (let f = byId.get(state.workflows.find((w) => w.id === id)?.folderId ?? ''), guard = 0; f && guard < 100; f = f.parentId ? byId.get(f.parentId) : undefined, guard++) folderIds.add(f.id);
  }
  const keys = [...picked.map((id) => entityKey('workflow', id)), ...[...folderIds].map((id) => entityKey('folder', id))];
  return { ...previous, ...Object.fromEntries(keys.filter((k) => exported[k] !== undefined).map((k) => [k, exported[k]])) };
}

/**
 * Write the picked workflows' files (and their folders') into `root` and nothing else: other workflows, variables, tables
 * stay as the branch has them. A picked workflow whose file moved (renamed, or moved to another folder) loses its old file.
 */
function writePicked(root: string, files: Array<{ path: string; content: string }>, picked: string[]) {
  const wanted = files.filter((f) => f.path === MANIFEST_FILE || f.path.startsWith(`${WORKFLOWS_DIR}/`));
  const keep = new Set(wanted.map((f) => f.path));
  // Old files of the picked workflows (found by the id inside) that are no longer where the workflow's file goes.
  for (const file of readSyncDir(root)) {
    if (!file.path.endsWith(WORKFLOW_SUFFIX) || keep.has(file.path)) continue;
    let id: unknown;
    try {
      id = (JSON.parse(file.content) as { id?: unknown }).id;
    } catch {
      continue;
    }
    if (typeof id === 'string' && picked.includes(id)) unlinkSync(join(root, file.path));
  }
  // writeSyncDir would delete every other managed file: write these one by one instead.
  const only = readSyncDir(root).filter((f) => !keep.has(f.path));
  writeSyncDir(root, [...only, ...wanted]);
}

/**
 * Export the instance into the working copy, commit and push. A dry run stops before the commit and reports what it
 * would hold. Nothing to commit: `committed: false`.
 */
export function pushToRepository(input: { message?: string; dryRun?: boolean; workflowIds?: string[] } = {}): Promise<SourceControlPushResult> {
  return exclusive(async () => {
    const { stored, config } = requireConfig();
    const auth = await gitAuthFor(config);
    // Some workflows only: each must exist; the commit holds their files (and their folders), nothing else.
    const picked = input.workflowIds?.length ? [...new Set(input.workflowIds)] : undefined;
    if (picked) {
      const missing = picked.filter((id) => !store.getWorkflow(id));
      if (missing.length) throw new SourceControlError(`Workflow not found: ${missing.join(', ')}`, 404);
    }
    const cwd = await workingCopy(config);
    await syncBranch(cwd, config, auth);
    const target = config.directory ? join(cwd, config.directory) : cwd;
    mkdirSync(target, { recursive: true });
    const exported = exportState({ values: config.includeVariableValues, ...(picked && { workflowIds: picked }) });
    if (picked) writePicked(target, exported.files, picked);
    else writeSyncDir(target, exported.files);
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
      // Nothing to commit: the branch already holds the instance (or the picked workflows), so it is the base for the next pull.
      if (!files.length && !input.dryRun && commit) write({ ...read(), hashes: basisAfter(stored.hashes, exported.hashes, picked) });
      return { ...base, committed: false, ...(commit && { commit }) };
    }
    const message =
      input.message?.trim() ||
      (picked?.length === 1 ? `Update “${store.getWorkflow(picked[0])!.name}” from Landflow` : `Update from Landflow (${exported.summary.workflows} workflow${exported.summary.workflows === 1 ? '' : 's'})`);
    await git(['-c', `user.name=${config.authorName}`, '-c', `user.email=${config.authorEmail}`, 'commit', '-q', '--no-verify', '-m', message], { cwd });
    const commit = (await head(cwd))!;
    try {
      await git(['push', '-q', 'origin', `HEAD:refs/heads/${config.branch}`], { cwd, auth });
    } catch (caught) {
      const text = (caught as Error).message;
      if (/rejected|non-fast-forward|fetch first/i.test(text)) throw new SourceControlError(`The branch ${config.branch} moved on while pushing; push again`, 409);
      throw caught;
    }
    write({ ...read(), lastPush: { at: new Date().toISOString(), commit, message, count: files.length }, hashes: basisAfter(stored.hashes, exported.hashes, picked) });
    return { ...base, committed: true, commit };
  });
}

/**
 * Fetch the branch and apply its files (creates and updates by id; deletes with `prune`). A change the instance made
 * since the last push or pull is a conflict and stops the pull unless `force`. A dry run only plans.
 */
export function pullFromRepository(input: { dryRun?: boolean; prune?: boolean; force?: boolean; by?: string; publish?: PlanOptions['publish']; updateCredentials?: boolean } = {}): Promise<SourceControlPullResult> {
  return exclusive(async () => {
    const { stored, config } = requireConfig();
    const auth = await gitAuthFor(config);
    const cwd = await workingCopy(config);
    if (!(await syncBranch(cwd, config, auth))) throw new SourceControlError(`The branch ${config.branch} isn’t in the repository yet: push first`, 404);
    const commit = (await head(cwd))!;
    const files = readSyncDir(config.directory ? join(cwd, config.directory) : cwd);
    if (!files.some((f) => f.path === MANIFEST_FILE)) throw new SourceControlError(`No Landflow files (${MANIFEST_FILE}) in ${config.directory || 'the repository root'} on ${config.branch}`, 404);
    const note = `Source control pull (${commit.slice(0, 7)})`;
    const result = await applySync(files, { dryRun: input.dryRun, prune: input.prune, force: input.force, by: input.by, note, ...(input.updateCredentials && { updateCredentials: true }), ...(input.publish && { publish: input.publish }), ...(stored.hashes && { base: stored.hashes }) });
    if (result.applied) {
      write({ ...read(), lastPull: { at: new Date().toISOString(), commit, count: result.appliedCount }, hashes: result.hashes });
    }
    return { ...result, commit, branch: config.branch };
  });
}

// ---------------------------------------------------------------------------
// A workflow's history in Git
// ---------------------------------------------------------------------------

const COMMIT = /^[0-9a-f]{7,40}$/;
const FIELD = '\x1f';
const RECORD = '\x1e';

/** Where a workflow's file is in the repository (relative to its root) on `ref`: the id inside identifies it, not the name. */
async function pathOnRef(cwd: string, config: SourceControlConfig, workflowId: string, ref: string): Promise<string | undefined> {
  const prefix = config.directory ? `${config.directory}/` : '';
  // The file as the instance would write it now: the fast and usual case.
  const expected = renderState(currentState(), { workflowKeys: workflowKeys(), workflowIds: [workflowId] }).workflowPaths[workflowId];
  if (expected) {
    const exists = await git(['cat-file', '-e', `${ref}:${prefix}${expected}`], { cwd }).then(
      () => true,
      () => false,
    );
    if (exists) return `${prefix}${expected}`;
  }
  // Renamed or moved since: find it by its id.
  const found = await git(['grep', '-l', '-F', '-e', `"id": ${JSON.stringify(workflowId)}`, ref, '--', `${prefix}${WORKFLOWS_DIR}`], { cwd }).then(
    (r) => r.stdout,
    () => '',
  );
  const hit = found
    .split('\n')
    .map((line) => line.slice(ref.length + 1))
    .find((path) => path.endsWith(WORKFLOW_SUFFIX));
  return hit || undefined;
}

/** The workflow document at `commit` for `path`, when that file holds this workflow (never another one's). */
async function documentAt(cwd: string, commit: string, path: string, workflowId: string): Promise<string | undefined> {
  const text = await git(['show', `${commit}:${path}`], { cwd }).then(
    (r) => r.stdout,
    () => undefined,
  );
  if (text === undefined) return undefined;
  try {
    return (JSON.parse(text) as { id?: unknown }).id === workflowId ? text : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `path` is a workflow file inside the configured directory (so a request can't name another file). */
function workflowPathOk(config: SourceControlConfig, path: string): boolean {
  if (!isSafePath(path) || !path.endsWith(WORKFLOW_SUFFIX)) return false;
  const prefix = config.directory ? `${config.directory}/` : '';
  return path.startsWith(`${prefix}${WORKFLOWS_DIR}/`) && isManagedPath(path.slice(prefix.length));
}

/** The commits that touched one workflow's file, newest first (renames followed), after fetching the branch. */
export function workflowGitHistory(workflowId: string, options: { limit?: number } = {}): Promise<GitHistory> {
  return exclusive(async () => {
    const { config } = requireConfig();
    if (!store.getWorkflow(workflowId)) throw new SourceControlError('Workflow not found', 404);
    const auth = await gitAuthFor(config);
    const cwd = await workingCopy(config);
    if (!(await syncBranch(cwd, config, auth))) return { branch: config.branch, commits: [], branchMissing: true };
    const path = await pathOnRef(cwd, config, workflowId, 'HEAD');
    if (!path) return { branch: config.branch, commits: [] };
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const prefix = config.directory ? `${config.directory}/` : '';
    // Every path this workflow's file ever had: the commits that added or removed a file holding its id (renames show as
    // a delete and an add). `--follow` is no use here: it also follows *copies*, and workflows often start as copies.
    const paths = [
      ...new Set(
        (await git(['log', '-S', `"id": ${JSON.stringify(workflowId)}`, '--no-renames', '--no-color', '--name-only', '--format=', '--', `${prefix}${WORKFLOWS_DIR}`], { cwd })).stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.endsWith(WORKFLOW_SUFFIX)),
      ),
    ];
    if (!paths.includes(path)) paths.push(path);
    const out = (await git(['log', '--no-renames', `-n${limit * 2}`, '--no-color', `--format=${RECORD}%H${FIELD}%an${FIELD}%ae${FIELD}%aI${FIELD}%s`, '--name-status', '--', ...paths], { cwd })).stdout;
    const candidates = out
      .split(RECORD)
      .filter(Boolean)
      .map((chunk) => {
        const [head, ...rest] = chunk.split('\n');
        const [commit, author, email, at, subject] = head.split(FIELD);
        const touched = rest.map((l) => l.trim().split('\t')).filter((p) => p.length === 2);
        // A commit that moved the file lists the old path (D) and the new one (A): the new one is where the file is then.
        const entry = touched.find(([status]) => status !== 'D') ?? touched[0];
        return { commit, shortCommit: commit.slice(0, 7), author, email, at, subject, path: entry?.[1] ?? path, deleted: entry?.[0] === 'D' };
      });
    // A path can be reused by another workflow later: keep only the commits whose file is this workflow's (at the commit, or just before a delete).
    const verified = await Promise.all(candidates.map(async (c) => ((await documentAt(cwd, c.deleted ? `${c.commit}^` : c.commit, c.path, workflowId)) !== undefined ? c : undefined)));
    const commits = verified.flatMap((c) => (c ? [{ commit: c.commit, shortCommit: c.shortCommit, author: c.author, email: c.email, at: c.at, subject: c.subject, path: c.path }] : [])).slice(0, limit);
    return { branch: config.branch, path, commits };
  });
}

/** One commit's effect on the workflow: its message, the diff of its file, and the workflow as it was then. */
export function workflowGitCommit(workflowId: string, commit: string, path: string): Promise<GitCommitDetail> {
  return exclusive(async () => {
    const { config } = requireConfig();
    if (!COMMIT.test(commit)) throw new SourceControlError('Not a commit id', 400);
    if (!workflowPathOk(config, path)) throw new SourceControlError('Not a workflow file of this repository', 400);
    const cwd = await workingCopy(config);
    // The file has to be this workflow's, at the commit or (when the commit deleted it) just before.
    const document = await documentAt(cwd, commit, path, workflowId);
    const before = document ?? (await documentAt(cwd, `${commit}^`, path, workflowId));
    if (before === undefined) throw new SourceControlError('That commit has no file of this workflow', 404);
    const meta = (await git(['show', '-s', '--no-color', `--format=%H${FIELD}%an${FIELD}%ae${FIELD}%aI${FIELD}%s${FIELD}%b`, commit], { cwd })).stdout.replace(/\n$/, '').split(FIELD);
    const diff = (await git(['show', '--no-color', '--format=', '--no-ext-diff', '--no-textconv', commit, '--', path], { cwd })).stdout;
    let workflow: GitCommitDetail['workflow'];
    if (document) {
      const doc = JSON.parse(document) as { name?: unknown; nodes?: unknown; active?: unknown };
      workflow = { name: String(doc.name ?? ''), nodes: Array.isArray(doc.nodes) ? doc.nodes.length : 0, active: Boolean(doc.active) };
    }
    return { commit: meta[0], shortCommit: meta[0].slice(0, 7), author: meta[1], email: meta[2], at: meta[3], subject: meta[4], body: (meta[5] ?? '').trim(), path, diff, ...(workflow && { workflow }) };
  });
}

/**
 * Restore the workflow as `commit` had it, as a new draft (a version of its history; nothing is published, its folder
 * and activation stay). Credentials are matched by name and type as in a pull.
 */
export function restoreWorkflowFromCommit(workflowId: string, commit: string, path: string, by?: string): Promise<{ workflow: ReturnType<typeof restoreWorkflow>['workflow']; warnings: string[]; commit: string }> {
  return exclusive(async () => {
    const { config } = requireConfig();
    if (!COMMIT.test(commit)) throw new SourceControlError('Not a commit id', 400);
    if (!workflowPathOk(config, path)) throw new SourceControlError('Not a workflow file of this repository', 400);
    const cwd = await workingCopy(config);
    const text = await documentAt(cwd, commit, path, workflowId);
    if (text === undefined) throw new SourceControlError('That commit has no file of this workflow to restore', 404);
    try {
      const restored = restoreWorkflow(workflowId, text, path);
      return { ...restored, commit };
    } catch (error) {
      if (error instanceof SourceControlError) throw error;
      throw new SourceControlError((error as Error).message, 422);
    }
  });
}

// ---------------------------------------------------------------------------
// SSH host keys
// ---------------------------------------------------------------------------

/** The SHA256 fingerprint ssh prints for a public key blob (base64). */
function fingerprint(base64: string): string {
  return `SHA256:${createHash('sha256').update(Buffer.from(base64, 'base64')).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Ask an SSH server for its host keys (ssh-keyscan) so the person can compare the fingerprints with the ones the
 * server's owner publishes, then pin them. This is the one place trust is given: the settings keep only what was pinned.
 */
export function scanHostKeys(repository: string): Promise<HostKeyScan> {
  const where = isSshRepository(repository) ? sshHostOf(repository) : undefined;
  if (!where || !/^[A-Za-z0-9._:-]+$/.test(where.host) || where.host.startsWith('-')) return Promise.reject(new SourceControlError('Enter an ssh:// or user@host:path repository first'));
  return new Promise((resolve, reject) => {
    execFile('ssh-keyscan', ['-T', '10', '-p', String(where.port), '-t', 'ed25519,ecdsa,rsa', where.host], { timeout: 20_000, env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv }, (error, stdout) => {
      const lines = String(stdout)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
      if (!lines.length) return reject(new SourceControlError(`No host keys from ${where.host}:${where.port}${error ? `: ${error.message.split('\n')[0]}` : ''}`, 502));
      const keys = lines.flatMap((line) => {
        const [, type, key] = line.split(/\s+/);
        return type && key ? [{ type, fingerprint: fingerprint(key), line }] : [];
      });
      resolve({ host: where.host, port: where.port, keys, knownHosts: lines.join('\n') });
    });
  });
}
