import { HttpError } from '../errors';

/**
 * The error a route handler (or a check it calls, such as project access in lib/server/projects) throws to answer
 * 401/403/404/423 as JSON; `handler` (lib/server/http.ts) turns it into `{ error }`. Its own module so code below the
 * guard can throw it without importing the guard.
 */
export class AuthError extends HttpError {
  static readonly errorName: string = 'AuthError';
  declare readonly status: 401 | 403 | 404 | 423;

  constructor(message: string, status: 401 | 403 | 404 | 423 = 401) {
    super(message, status);
  }
}
