/**
 * HttpError: the one error a route (or a store below it) throws to answer with a status. `handler` (./http) turns it
 * into `{ error, code, ...details }`; anything that is not an HttpError (or a ZodError) answers a generic 500 so a SQL
 * message or a file path never reaches a client. Domain errors extend it with their own default status, keeping the
 * `(message, status)` argument order the older domain classes use, so converting one is `extends HttpError`.
 *
 * Each subclass names itself with a literal `static readonly errorName: string = 'ThatClassName'`: the production server bundle
 * minifies class names, so `new.target.name` would turn `code` into a letter such as `"v"` that changes per build (and
 * `error.name`, which the log's `exception.type` and the exception fingerprint use, with it). `test/error-mapping.test.ts`
 * fails a subclass in `lib/server` or `app` without one; a class without one (a test's own) falls back to its class name.
 */
export interface HttpErrorOptions {
  /** A stable machine-readable name (default: the class's `errorName` in snake_case). */
  code?: string;
  /** Extra fields of the response body (`current` of a workflow conflict, …). Never put anything secret in them. */
  details?: Record<string, unknown>;
  cause?: unknown;
  /** Whether the message may reach the client (default: status below 500). */
  expose?: boolean;
}

/** Marks an HttpError from any copy of this module (Symbol.for is one registry per process). */
const HTTP_ERROR = Symbol.for('landflow.HttpError');

export class HttpError extends Error {
  /** The class's own name, as a literal that survives minification. Every subclass declares its own. */
  static readonly errorName: string = 'HttpError';

  /**
   * `instanceof` across module copies. The production server bundles a module once per layer (route handlers, pages),
   * and a `singleton()` store made in one layer throws that layer's classes into another layer's `handler()`, where a
   * plain `instanceof HttpError` is false and the error would answer a generic 500. So an HttpError from another copy
   * also matches the class here, and so does a subclass, by its `errorName` along the error's class chain.
   */
  static [Symbol.hasInstance](value: unknown): boolean {
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
    if (typeof value !== 'object' || value === null || !(HTTP_ERROR in value)) return false;
    if (!Object.hasOwn(this, 'errorName')) return false;
    const wanted = (this as unknown as typeof HttpError).errorName;
    for (let type: unknown = (value as object).constructor; typeof type === 'function' && type !== Error; type = Object.getPrototypeOf(type)) {
      if (Object.hasOwn(type, 'errorName') && (type as typeof HttpError).errorName === wanted) return true;
    }
    return false;
  }

  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly expose: boolean;

  constructor(message: string, status = 400, options: HttpErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    const name = Object.hasOwn(new.target, 'errorName') ? (new.target as typeof HttpError).errorName : new.target.name;
    this.name = name;
    this.status = status;
    this.code = options.code ?? snakeCase(name);
    if (options.details) this.details = options.details;
    this.expose = options.expose ?? status < 500;
  }
}

Object.defineProperty(HttpError.prototype, HTTP_ERROR, { value: true });

/** `WorkflowConflictError` → `workflow_conflict_error`. */
function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();
}
