/**
 * The engine under the Agent Shell node: just-bash (a simulated bash in this process) over an in-memory filesystem.
 *
 * What is and is not reachable, by construction:
 *  - the filesystem is an `InMemoryFs`, never an Overlay/ReadWrite/Mountable one, so no host path is mounted;
 *  - `network` is never passed, so `curl` and `html-to-markdown` do not exist; `python` and `javascript` stay off;
 *  - the shell's environment is built here from scratch (HOME, USER, nothing from `process.env`);
 *  - every call has a wall-clock deadline (just-bash's and ours), a command count, a command length cap, an output cap
 *    and a filesystem size cap.
 */
import { Bash, InMemoryFs } from 'just-bash';

export const HOME = '/home/user';

export const LIMITS = {
  /** Longest command accepted, characters. */
  maxCommandChars: 8_000,
  /** Default and ceiling of the per-call deadline, ms. */
  defaultTimeoutMs: 10_000,
  maxTimeoutMs: 60_000,
  /** stdout and stderr are each cut at this many characters. */
  defaultMaxOutputChars: 64_000,
  maxOutputChars: 512_000,
  /** Seed files: how many and how many bytes in all. */
  maxSeedFiles: 200,
  maxSeedBytes: 2 * 1024 * 1024,
  /** Everything the filesystem may hold in one call (or one persisted run). */
  defaultMaxFsBytes: 4 * 1024 * 1024,
  maxFsBytes: 32 * 1024 * 1024,
  /** Persisted filesystems: how many runs at once, and how long one is kept after its last call. */
  maxSessions: 64,
  sessionTtlMs: 30 * 60_000,
  /** In a result's `files`: text up to this long is included, longer text is cut. */
  fileContentChars: 2_000,
  maxReportedFiles: 100,
} as const;

export class ShellError extends Error {}

export interface ShellOptions {
  command: string;
  /** name -> text, written under /home/user (a name may hold folders: `data/a.csv`). */
  files?: Record<string, string>;
  timeoutMs?: number;
  maxOutputChars?: number;
  maxFsBytes?: number;
  /** Keep the filesystem for later calls with the same key (the execution id). */
  persistKey?: string;
}

export type FileChange = {
  path: string;
  size: number;
  change: 'created' | 'modified' | 'deleted';
  /** Small text files only. */
  content?: string;
  contentTruncated?: boolean;
};

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  files: FileChange[];
  filesOmitted: number;
  persisted: boolean;
  fsBytes: number;
}

interface Session {
  fs: InMemoryFs;
  bash: Bash;
  touched: number;
  /** Calls on one session run one after the other. */
  tail: Promise<unknown>;
}

const sessions = new Map<string, Session>();

const clamp = (value: number | undefined, fallback: number, max: number) =>
  Number.isFinite(value) && (value as number) > 0 ? Math.min(Math.floor(value as number), max) : fallback;

/** A seed file name, made into an absolute path under HOME. Absolute names stay inside the sandbox, `..` is refused. */
export function seedPath(name: string): string {
  const parts = String(name)
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..') || String(name).includes('\0')) throw new ShellError(`Bad file name: ${JSON.stringify(String(name).slice(0, 80))}`);
  return `${HOME}/${parts.join('/')}`;
}

function newSession(maxFsBytes: number, timeoutMs: number, maxOutputChars: number): Session {
  const fs = new InMemoryFs();
  const bash = new Bash({
    fs,
    cwd: HOME,
    // Not process.env: the shell starts with only these.
    env: { HOME, USER: 'user', LOGNAME: 'user', PWD: HOME },
    executionLimitProfile: 'hardened',
    executionLimits: {
      maxExecutionTimeMs: timeoutMs,
      maxOutputSize: Math.max(maxOutputChars * 4, 4 * 1024 * 1024),
      maxFileSystemBytes: maxFsBytes,
      maxSourceBytes: LIMITS.maxCommandChars * 4,
    },
  });
  return { fs, bash, touched: Date.now(), tail: Promise.resolve() };
}

function sweep(now = Date.now()) {
  for (const [key, session] of sessions) if (now - session.touched > LIMITS.sessionTtlMs) sessions.delete(key);
  // Over the limit: drop the least recently used.
  while (sessions.size >= LIMITS.maxSessions) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].touched - b[1].touched)[0];
    if (!oldest) break;
    sessions.delete(oldest[0]);
  }
}

export const dropSession = (key: string) => sessions.delete(key);
export const sessionCount = () => sessions.size;
export const clearSessions = () => sessions.clear();

/** Every regular file of the filesystem outside the built-in system folders, as path -> bytes. */
async function snapshot(fs: InMemoryFs): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const path of fs.getAllPaths()) {
    if (/^\/(bin|usr|dev|proc)(\/|$)/.test(path)) continue;
    try {
      const stat = await fs.lstat(path);
      if (stat.isFile) out.set(path, await fs.readFile(path));
    } catch {
      /* gone or unreadable: not a file we can report */
    }
  }
  return out;
}

const bytesOf = (files: Map<string, string>) => [...files.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0);

function cut(text: string, max: number): [string, boolean] {
  return text.length > max ? [text.slice(0, max), true] : [text, false];
}

function diff(before: Map<string, string>, after: Map<string, string>): FileChange[] {
  const changes: FileChange[] = [];
  for (const [path, text] of after) {
    const old = before.get(path);
    if (old === text) continue;
    const [content, contentTruncated] = cut(text, LIMITS.fileContentChars);
    changes.push({
      path,
      size: Buffer.byteLength(text),
      change: old === undefined ? 'created' : 'modified',
      // Only text that is really text: no NULs.
      ...(text.includes('\0') ? {} : { content, ...(contentTruncated ? { contentTruncated } : {}) }),
    });
  }
  for (const path of before.keys()) if (!after.has(path)) changes.push({ path, size: 0, change: 'deleted' });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

async function seed(fs: InMemoryFs, files: Record<string, string>) {
  const entries = Object.entries(files);
  if (entries.length > LIMITS.maxSeedFiles) throw new ShellError(`Too many files to seed (${entries.length}, the limit is ${LIMITS.maxSeedFiles})`);
  const total = entries.reduce((sum, [, text]) => sum + Buffer.byteLength(String(text)), 0);
  if (total > LIMITS.maxSeedBytes) throw new ShellError(`The files to seed are ${total} bytes, the limit is ${LIMITS.maxSeedBytes}`);
  for (const [name, text] of entries) {
    const path = seedPath(name);
    const dir = path.slice(0, path.lastIndexOf('/'));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path, String(text));
  }
}

async function runOn(session: Session, options: ShellOptions, timeoutMs: number, maxOutputChars: number, maxFsBytes: number, persisted: boolean): Promise<ShellResult> {
  if (options.files) await seed(session.fs, options.files);
  const before = await snapshot(session.fs);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ShellError('timeout'));
    }, timeoutMs + 250);
  });
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    const result = await Promise.race([session.bash.exec(options.command, { signal: controller.signal, env: { HOME, USER: 'user' }, cwd: HOME }), deadline]);
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = result.exitCode;
  } catch (error) {
    if (timedOut) {
      exitCode = 124;
      stderr = `Timed out after ${timeoutMs} ms`;
    } else {
      // The limits (commands, output, size) surface as exceptions in some paths: report them as the shell's own failure.
      exitCode = 126;
      stderr = (error as Error).message;
    }
  } finally {
    clearTimeout(timer);
  }
  if (/timed out|timeout|deadline|aborted/i.test(stderr) && exitCode !== 0 && !timedOut) timedOut = /execution time|timed out|timeout/i.test(stderr);
  if (timedOut && exitCode !== 124) exitCode = 124;
  const after = await snapshot(session.fs);
  const fsBytes = bytesOf(after);
  if (fsBytes > maxFsBytes) {
    throw new ShellError(`The filesystem holds ${fsBytes} bytes, over the limit of ${maxFsBytes}`);
  }
  const [out, stdoutTruncated] = cut(stdout, maxOutputChars);
  const [err, stderrTruncated] = cut(stderr, maxOutputChars);
  const changes = diff(before, after);
  return {
    stdout: out,
    stderr: err,
    exitCode,
    stdoutTruncated,
    stderrTruncated,
    timedOut,
    files: changes.slice(0, LIMITS.maxReportedFiles),
    filesOmitted: Math.max(0, changes.length - LIMITS.maxReportedFiles),
    persisted,
    fsBytes,
  };
}

/** Runs one command. A fresh filesystem each call, unless `persistKey` names a run whose filesystem is kept. */
export async function runShell(options: ShellOptions): Promise<ShellResult> {
  if (typeof options.command !== 'string' || !options.command.trim()) throw new ShellError('The command is empty');
  if (options.command.length > LIMITS.maxCommandChars) throw new ShellError(`The command is ${options.command.length} characters, the limit is ${LIMITS.maxCommandChars}`);
  const timeoutMs = clamp(options.timeoutMs, LIMITS.defaultTimeoutMs, LIMITS.maxTimeoutMs);
  const maxOutputChars = clamp(options.maxOutputChars, LIMITS.defaultMaxOutputChars, LIMITS.maxOutputChars);
  const maxFsBytes = clamp(options.maxFsBytes, LIMITS.defaultMaxFsBytes, LIMITS.maxFsBytes);

  const key = options.persistKey;
  if (!key) return runOn(newSession(maxFsBytes, timeoutMs, maxOutputChars), options, timeoutMs, maxOutputChars, maxFsBytes, false);

  sweep();
  let session = sessions.get(key);
  if (!session) {
    session = newSession(maxFsBytes, timeoutMs, maxOutputChars);
    sessions.set(key, session);
  }
  const current = session;
  current.touched = Date.now();
  const run = current.tail.then(() => runOn(current, options, timeoutMs, maxOutputChars, maxFsBytes, true));
  current.tail = run.catch(() => undefined);
  try {
    return await run;
  } catch (error) {
    // A run that went over its size cap loses its filesystem rather than keep growing.
    if (error instanceof ShellError && /over the limit/.test(error.message)) sessions.delete(key);
    throw error;
  } finally {
    current.touched = Date.now();
  }
}
