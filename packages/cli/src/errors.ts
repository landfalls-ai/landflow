/**
 * CLI errors and exit codes. Every failure is a CliError with a stable `code`; under `--json` it is printed as
 * `{ "ok": false, "error": { "code", "message", "status"?, "details"? } }` and the process exits with its code.
 */

export const EXIT = {
  ok: 0,
  /** Anything else: a server error, a failed execution, sync errors, a file that can't be read. */
  error: 1,
  /** Bad arguments or an unknown command. */
  usage: 2,
  notFound: 3,
  /** 401 or 403. */
  auth: 4,
  /** 409/423, sync conflicts, a pull that would overwrite local edits. */
  conflict: 5,
  /** The host can't be reached. */
  network: 6,
  /** `--wait` gave up. */
  timeout: 7,
} as const;

export type ErrorCode =
  | 'usage'
  | 'config'
  | 'io'
  | 'network'
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'not_supported'
  | 'server_error'
  | 'execution_failed'
  | 'sync_failed'
  | 'timeout'
  /** A bug in the CLI. */
  | 'internal';

const EXIT_FOR: Record<ErrorCode, number> = {
  usage: EXIT.usage,
  config: EXIT.usage,
  io: EXIT.error,
  network: EXIT.network,
  bad_request: EXIT.error,
  unauthorized: EXIT.auth,
  forbidden: EXIT.auth,
  not_found: EXIT.notFound,
  conflict: EXIT.conflict,
  not_supported: EXIT.error,
  server_error: EXIT.error,
  execution_failed: EXIT.error,
  sync_failed: EXIT.error,
  timeout: EXIT.timeout,
  internal: EXIT.error,
};

export class CliError extends Error {
  readonly status?: number;
  readonly details?: unknown;

  constructor(
    readonly code: ErrorCode,
    message: string,
    options: { status?: number; details?: unknown } = {},
  ) {
    super(message);
    this.name = 'CliError';
    if (options.status !== undefined) this.status = options.status;
    if (options.details !== undefined) this.details = options.details;
  }

  get exitCode(): number {
    return EXIT_FOR[this.code];
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.status !== undefined && { status: this.status }), ...(this.details !== undefined && { details: this.details }) };
  }
}

export const usage = (message: string) => new CliError('usage', message);
