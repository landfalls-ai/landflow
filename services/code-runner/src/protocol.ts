/**
 * The code runner's HTTP contract, shared with the host's Code node (type-only import).
 *
 *   GET  /health   → { status: 'ok' }                                (no secret: container healthchecks)
 *   GET  /v1/info  → RunnerInfo                                      (secret)
 *   POST /v1/run   → RunResponse for a RunRequest body                (secret)
 *
 * The host sends the shared secret in `X-Landflow-Runner-Secret`. A snippet that fails (a thrown error, a timeout,
 * a limit) is still HTTP 200 with `ok: false`; non-200 answers are about the request itself (401 secret, 400 body,
 * 413 too large, 503 busy).
 */

export const SECRET_HEADER = 'x-landflow-runner-secret';

export type Language = 'javascript' | 'python';

/** n8n's Code node modes: `all` = "Run once for all items", `each` = "Run once for each item". */
export type RunMode = 'all' | 'each';

/** An n8n/Landflow item. Only `json` is read; `pairedItem` and `binary` are passed through when the snippet keeps them. */
export interface RunItem {
  json: Record<string, unknown>;
  pairedItem?: unknown;
  binary?: unknown;
}

export interface RunRequest {
  language: Language;
  mode: RunMode;
  code: string;
  /** Main input 0: `$input.all()` / `_input.all()`, `items`. */
  items: RunItem[];
  /** What `$('Node')` / `_('Node')` read: each node's latest output, by node name. */
  nodeOutputs?: Record<string, RunItem[]>;
  /** `$vars` / `_vars`. */
  variables?: Record<string, string>;
  /** `$execution` / `_execution`. */
  execution?: { id: string; mode: string };
  /** `$workflow` / `_workflow`. */
  workflow?: { id?: string; name?: string };
  /** The Code node, for error messages. */
  node?: { name: string };
  /** IANA zone for `$now`, `$today` and Luxon's default zone (`_now` in Python). Default: UTC. */
  timezone?: string;
  /** Wall-clock limit; capped at the runner's own limit. */
  timeoutMs?: number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** One line of console output (`console.log`, `print`): it becomes a node log on the host. */
export interface RunLog {
  level: LogLevel;
  message: string;
}

/**
 * - `error`: the snippet threw; `syntax`: it doesn't compile;
 * - `timeout`, `cpu`, `memory`, `output`: a limit stopped it;
 * - `crash`: the process died without an answer; `unavailable`: the language isn't installed on this runner.
 */
export type RunErrorKind = 'error' | 'syntax' | 'timeout' | 'cpu' | 'memory' | 'output' | 'crash' | 'unavailable';

export interface RunError {
  kind: RunErrorKind;
  message: string;
  /** `TypeError`, `KeyError`, … */
  name?: string;
  /** 1-based line and column in the snippet. */
  line?: number;
  column?: number;
  /** "Run once for each item": the item being processed. */
  itemIndex?: number;
  /** The snippet's own frames only. */
  stack?: string;
}

export type RunResponse =
  | { ok: true; items: RunItem[]; logs: RunLog[]; durationMs: number }
  | { ok: false; error: RunError; logs: RunLog[]; durationMs: number };

export interface RunnerLimits {
  timeoutMs: number;
  cpuSeconds: number;
  memoryMb: number;
  maxOutputBytes: number;
  fileSizeMb: number;
}

export interface RunnerInfo {
  version: string;
  languages: { javascript: { version: string }; python: { version: string } | null };
  limits: RunnerLimits;
  /** Which isolation layers this runner applies to every snippet (see isolation.ts). */
  isolation: Record<string, boolean | string>;
}
