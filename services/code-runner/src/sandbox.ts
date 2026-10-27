/**
 * One snippet, one fresh process.
 *
 *   [sandbox-exec -p <profile> | unshare -rn]  /bin/sh -c 'ulimit -c 0 -t <cpu> -f <size> [-v <kb>]; exec "$@"'
 *       node --permission … child/js-runner.mjs        or        python3 -I -S -B child/py_runner.py
 *
 * Each run gets a private work directory (its cwd, HOME and TMPDIR, deleted afterwards), an empty environment, its
 * own process group (killed as a whole when the run ends), a wall-clock timer, a resident-memory watch and a cap on
 * everything it writes back. The job goes in on stdin; logs and the answer come back as JSON lines on fd 3.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunnerConfig } from './config';
import type { Isolation } from './isolation';
import type { RunError, RunErrorKind, RunItem, RunLog, RunRequest, RunResponse } from './protocol';

const CHILD_DIR = realpathSync(fileURLToPath(new URL('../child/', import.meta.url)));
const JS_RUNNER = join(CHILD_DIR, 'js-runner.mjs');
const PY_RUNNER = join(CHILD_DIR, 'py_runner.py');

/** Luxon's package directory (read access for the JavaScript child) and its entry file. */
const LUXON = (() => {
  const main = realpathSync(createRequire(import.meta.url).resolve('luxon'));
  let dir = dirname(main);
  while (!existsSync(join(dir, 'package.json')) && dirname(dir) !== dir) dir = dirname(dir);
  return { dir, main };
})();

/** Resident memory a runtime needs on top of the snippet's own budget (V8 and libuv, or the interpreter). */
const OVERHEAD_MB = { javascript: 128, python: 64 } as const;
const MEMORY_POLL_MS = 100;
const STDERR_TAIL = 16 * 1024;

/**
 * macOS Seatbelt profile: everything a plain process may do, minus the network, writes outside the work directory
 * and signals to other processes. Children inherit it.
 */
const SEATBELT_PROFILE = `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write* (subpath (param "WORK")))
(allow file-write-data (literal "/dev/null"))
(deny signal)
(allow signal (target self))`;

export interface SandboxEnv {
  config: RunnerConfig;
  isolation: Isolation;
}

function interpreter(request: RunRequest, work: string, { config, isolation }: SandboxEnv): string[] {
  if (request.language === 'python') return [isolation.python!.path, '-I', '-S', '-B', PY_RUNNER];
  const permission = isolation.node.permission
    ? [
        '--permission',
        `--allow-fs-read=${CHILD_DIR}`,
        `--allow-fs-read=${LUXON.dir}`,
        `--allow-fs-read=${work}`,
        `--allow-fs-write=${work}`,
        // Guards off is for checking the outer layers: then the permission model leaves the network to them.
        ...(!config.guards && isolation.node.netPermission ? ['--allow-net'] : []),
      ]
    : [];
  return [config.nodePath, ...permission, '--disallow-code-generation-from-strings', `--max-old-space-size=${config.limits.memoryMb}`, '--no-warnings', JS_RUNNER];
}

/** `sh -c` prefix that applies the rlimits this OS supports, then execs the interpreter (same pid). */
function limitsWrapper(request: RunRequest, { config, isolation }: SandboxEnv, cpuSeconds: number): string[] {
  const limits = [];
  if (isolation.ulimit.core) limits.push('ulimit -c 0');
  // SIGXCPU at the soft limit, SIGKILL at the hard one a second later (equal limits make Linux send SIGKILL). Soft
  // first: macOS refuses a hard limit below the current soft one.
  if (isolation.ulimit.cpu) limits.push(`ulimit -S -t ${cpuSeconds}`, `ulimit -H -t ${cpuSeconds + 1}`);
  if (isolation.ulimit.fileSize) limits.push(`ulimit -f ${Math.floor((config.limits.fileSizeMb * 1024 * 1024) / isolation.ulimit.fileSizeBlock)}`);
  // V8 reserves far more address space than it uses, so only Python gets an address-space cap.
  if (isolation.ulimit.addressSpace && request.language === 'python') limits.push(`ulimit -v ${(config.limits.memoryMb + OVERHEAD_MB.python) * 1024}`);
  const script = `${limits.map((limit) => `${limit} || exit 90`).join('; ')}${limits.length ? '; ' : ''}exec "$@"`;
  return ['/bin/sh', '-c', script, 'sh'];
}

function osSandbox(work: string, { isolation }: SandboxEnv): string[] {
  if (isolation.osSandbox === 'sandbox-exec') return ['/usr/bin/sandbox-exec', '-D', `WORK=${work}`, '-p', SEATBELT_PROFILE];
  if (isolation.osSandbox === 'unshare') return ['unshare', '-rn'];
  return [];
}

/** Resident set size in MB, or undefined when it can't be read (the process is gone). */
async function residentMb(pid: number, how: Isolation['rssWatch']): Promise<number | undefined> {
  if (how === 'proc') {
    try {
      const match = /VmRSS:\s+(\d+) kB/.exec(await readFile(`/proc/${pid}/status`, 'utf8'));
      return match ? Number(match[1]) / 1024 : undefined;
    } catch {
      return undefined;
    }
  }
  if (how === 'ps') {
    return new Promise((resolve) =>
      execFile('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 2_000 }, (error, stdout) => {
        const kb = Number(stdout.trim());
        resolve(error || !stdout.trim() || Number.isNaN(kb) ? undefined : kb / 1024);
      }),
    );
  }
  return undefined;
}

const LIMIT_MESSAGES: Partial<Record<RunErrorKind, (config: RunnerConfig, timeoutMs: number, cpuSeconds: number) => string>> = {
  timeout: (_config, timeoutMs) => `Code timed out after ${timeoutMs / 1000} s`,
  cpu: (_config, _timeoutMs, cpuSeconds) => `Code used more than ${cpuSeconds} s of CPU time`,
  memory: (config) => `Code ran out of memory (limit ${config.limits.memoryMb} MB)`,
  output: (config) => `Code output exceeded the ${(config.limits.maxOutputBytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB limit`,
};

/** Runs `request` and resolves with the snippet's outcome; only an unusable runner rejects. */
export async function runSnippet(request: RunRequest, env: SandboxEnv, signal?: AbortSignal): Promise<RunResponse> {
  const { config, isolation } = env;
  const started = Date.now();
  const logs: RunLog[] = [];
  const done = (error: RunError): RunResponse => ({ ok: false, error, logs, durationMs: Date.now() - started });
  if (request.language === 'python' && !isolation.python) {
    return done({ kind: 'unavailable', message: `Python isn't available on this code runner (${config.pythonPath} doesn't run)` });
  }
  const timeoutMs = Math.min(request.timeoutMs && request.timeoutMs > 0 ? request.timeoutMs : config.limits.timeoutMs, config.limits.timeoutMs);
  const cpuSeconds = Math.max(1, Math.min(config.limits.cpuSeconds, Math.ceil(timeoutMs / 1000)));

  // realpath: macOS hands out /var/… for /private/var/…, and the Seatbelt and permission paths must match.
  const work = realpathSync(await mkdtemp(join(config.tmpDir, 'code-runner-')));
  try {
    const argv = [...osSandbox(work, env), ...limitsWrapper(request, env, cpuSeconds), ...interpreter(request, work, env)];
    const child = spawn(argv[0], argv.slice(1), {
      cwd: work,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: work, TMPDIR: work, LANG: 'C.UTF-8', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      detached: true,
    });

    let killedFor: RunErrorKind | undefined;
    let outputBytes = 0;
    let stderrTail = '';
    let final: { type: 'result'; items: RunItem[] } | { type: 'error'; error: RunError } | undefined;
    const kill = (reason: RunErrorKind) => {
      killedFor ??= reason;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const count = (bytes: number) => {
      outputBytes += bytes;
      if (outputBytes > config.limits.maxOutputBytes) kill('output');
    };

    // fd 3: JSON lines from the runner script.
    let pending = '';
    const channel = child.stdio[3] as NodeJS.ReadableStream;
    channel.setEncoding('utf8');
    channel.on('data', (chunk: string) => {
      count(Buffer.byteLength(chunk));
      if (killedFor) return;
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (message.type === 'log') logs.push({ level: message.level, message: String(message.message) });
          else if (message.type === 'result' || message.type === 'error') final ??= message;
        } catch {
          // Not ours (or cut short by a kill): ignore.
        }
      }
    });
    // Raw stdout (os.write(1, …), C extensions) still becomes logs; stderr is kept for crash reports.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      count(Buffer.byteLength(chunk));
      if (!killedFor) for (const line of chunk.split('\n')) if (line) logs.push({ level: 'info', message: line });
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      count(Buffer.byteLength(chunk));
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(
      JSON.stringify({
        language: request.language,
        mode: request.mode,
        code: request.code,
        items: request.items,
        nodeOutputs: request.nodeOutputs ?? {},
        variables: request.variables ?? {},
        execution: request.execution ?? null,
        workflow: request.workflow ?? null,
        timezone: request.timezone ?? null,
        binary: request.binary ?? {},
        binarySkipped: request.binarySkipped ?? {},
        maxBinaryBytes: Math.min(request.maxBinaryBytes && request.maxBinaryBytes > 0 ? request.maxBinaryBytes : config.limits.maxBinaryBytes, config.limits.maxBinaryBytes),
        workDir: work,
        guards: config.guards,
        ...(request.language === 'javascript' && { luxonPath: LUXON.main, allowBuiltins: config.jsAllowBuiltins }),
      }),
    );

    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    const memoryLimitMb = config.limits.memoryMb + OVERHEAD_MB[request.language];
    let polling = false;
    const watch = isolation.rssWatch
      ? setInterval(async () => {
          if (polling) return;
          polling = true;
          const mb = await residentMb(child.pid!, isolation.rssWatch);
          polling = false;
          if (mb !== undefined && mb > memoryLimitMb) kill('memory');
        }, MEMORY_POLL_MS)
      : undefined;
    const onAbort = () => kill('crash');
    signal?.addEventListener('abort', onAbort, { once: true });

    const { code, signalName } = await new Promise<{ code: number | null; signalName: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => {
        // Anything the snippet left running in its process group goes too, so the pipes close.
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          // already gone
        }
      });
      child.once('close', (exitCode, exitSignal) => resolve({ code: exitCode, signalName: exitSignal }));
    }).finally(() => {
      clearTimeout(timer);
      if (watch) clearInterval(watch);
      signal?.removeEventListener('abort', onAbort);
    });

    const limitMessage = killedFor && LIMIT_MESSAGES[killedFor];
    if (limitMessage) return done({ kind: killedFor!, message: limitMessage(config, timeoutMs, cpuSeconds) });
    if (killedFor) return done({ kind: 'crash', message: 'The run was canceled' });
    if (final?.type === 'result') return { ok: true, items: final.items, logs, durationMs: Date.now() - started };
    if (final?.type === 'error') {
      const error = final.error;
      if (error.kind === 'memory') return done({ ...error, message: `${LIMIT_MESSAGES.memory!(config, timeoutMs, cpuSeconds)}: ${error.name ?? 'MemoryError'}` });
      return done(error);
    }
    if (signalName === 'SIGXCPU') return done({ kind: 'cpu', message: LIMIT_MESSAGES.cpu!(config, timeoutMs, cpuSeconds) });
    // Not our kill: the CPU hard limit, or the kernel's OOM killer when the container's memory runs out.
    if (signalName === 'SIGKILL') return done({ kind: 'crash', message: 'The code process was killed (SIGKILL): it hit the CPU limit or the machine ran out of memory' });
    if (signalName === 'SIGXFSZ') return done({ kind: 'error', name: 'Error', message: `Code wrote a file larger than the ${config.limits.fileSizeMb} MB limit` });
    if (/heap out of memory|Reached heap limit|allocation failed/i.test(stderrTail)) return done({ kind: 'memory', message: LIMIT_MESSAGES.memory!(config, timeoutMs, cpuSeconds) });
    if (code === 90) return done({ kind: 'crash', message: 'The code runner could not apply its resource limits' });
    const detail = stderrTail.trim().split('\n').slice(-8).join('\n');
    return done({ kind: 'crash', message: `The code process stopped without an answer (${signalName ?? `exit code ${code}`})`, ...(detail && { stack: detail }) });
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
