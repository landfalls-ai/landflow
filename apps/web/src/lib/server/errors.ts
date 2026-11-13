/**
 * HttpError: the one error a route (or a store below it) throws to answer with a status. `handler` (./http) turns it
 * into `{ error, code, ...details }`; anything that is not an HttpError (or a ZodError) answers a generic 500 so a SQL
 * message or a file path never reaches a client. Domain errors extend it with their own default status, keeping the
 * `(message, status)` argument order the older domain classes use, so converting one is `extends HttpError`.
 */
export interface HttpErrorOptions {
  /** A stable machine-readable name (default: the class name in snake_case). */
  code?: string;
  /** Extra fields of the response body (`current` of a workflow conflict, …). Never put anything secret in them. */
  details?: Record<string, unknown>;
  cause?: unknown;
  /** Whether the message may reach the client (default: status below 500). */
  expose?: boolean;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly expose: boolean;

  constructor(message: string, status = 400, options: HttpErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.status = status;
    this.code = options.code ?? snakeCase(new.target.name);
    if (options.details) this.details = options.details;
    this.expose = options.expose ?? status < 500;
  }
}

/** `WorkflowConflictError` → `workflow_conflict_error`. */
function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();
}
