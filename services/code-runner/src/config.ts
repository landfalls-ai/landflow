/**
 * Code runner settings, all from the environment (every one has a default except the secret).
 *
 * A request may lower the timeout; it can never raise a limit.
 */
import { availableParallelism, tmpdir } from 'node:os';
import type { RunnerLimits } from './protocol';

export interface RunnerConfig {
  host: string;
  port: number;
  /** Shared with the host (`LANDFLOW_CODE_RUNNER_SECRET`); required. */
  secret: string;
  limits: RunnerLimits;
  /** Snippets running at once; more wait in a queue of `maxQueue`, beyond that the runner answers 503. */
  concurrency: number;
  maxQueue: number;
  maxRequestBytes: number;
  nodePath: string;
  pythonPath: string;
  /** Parent of each snippet's private work directory (the container's tmpfs `/tmp`). */
  tmpDir: string;
  /** In-process guards in the child (network and signal stubs in JS, the audit hook in Python). Diagnostics only: keep on. */
  guards: boolean;
  /** `sandbox-exec` on macOS, `unshare -rn` on Linux when it works; off with CODE_RUNNER_OS_SANDBOX=off. */
  osSandbox: boolean;
  /** Node built-ins a JavaScript snippet may `require` (`*`: any). Luxon is always available. */
  jsAllowBuiltins: string[];
}

export const DEFAULT_JS_BUILTINS = ['assert', 'buffer', 'crypto', 'events', 'path', 'querystring', 'string_decoder', 'url', 'util', 'zlib'];

const MB = 1024 * 1024;

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 1): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} must be an integer ≥ ${min} (got "${raw}")`);
  return value;
}

const off = (value: string | undefined) => ['off', 'false', '0', 'no'].includes((value ?? '').trim().toLowerCase());

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  const timeoutMs = int(env, 'CODE_RUNNER_TIMEOUT_MS', 60_000, 100);
  const secret = overrides.secret ?? env.CODE_RUNNER_SECRET ?? env.LANDFLOW_CODE_RUNNER_SECRET ?? '';
  if (!secret.trim()) throw new Error('Set CODE_RUNNER_SECRET (the same value as the host’s LANDFLOW_CODE_RUNNER_SECRET)');
  const builtins = env.CODE_RUNNER_JS_ALLOW_BUILTIN?.trim();
  return {
    host: env.CODE_RUNNER_HOST?.trim() || '127.0.0.1',
    port: int(env, 'CODE_RUNNER_PORT', 7300, 0),
    limits: {
      timeoutMs,
      cpuSeconds: int(env, 'CODE_RUNNER_CPU_SECONDS', Math.ceil(timeoutMs / 1000)),
      memoryMb: int(env, 'CODE_RUNNER_MEMORY_MB', 256, 16),
      maxOutputBytes: int(env, 'CODE_RUNNER_MAX_OUTPUT_BYTES', 10 * MB, 1024),
      fileSizeMb: int(env, 'CODE_RUNNER_FILE_SIZE_MB', 16),
    },
    concurrency: int(env, 'CODE_RUNNER_CONCURRENCY', Math.min(4, availableParallelism())),
    maxQueue: int(env, 'CODE_RUNNER_QUEUE', 32, 0),
    maxRequestBytes: int(env, 'CODE_RUNNER_MAX_REQUEST_BYTES', 32 * MB, 1024),
    nodePath: env.CODE_RUNNER_NODE?.trim() || process.execPath,
    pythonPath: env.CODE_RUNNER_PYTHON?.trim() || 'python3',
    tmpDir: env.CODE_RUNNER_TMPDIR?.trim() || tmpdir(),
    guards: !off(env.CODE_RUNNER_GUARDS),
    osSandbox: !off(env.CODE_RUNNER_OS_SANDBOX),
    jsAllowBuiltins: builtins ? builtins.split(',').map((name) => name.trim()).filter(Boolean) : DEFAULT_JS_BUILTINS,
    ...overrides,
    secret,
  };
}
