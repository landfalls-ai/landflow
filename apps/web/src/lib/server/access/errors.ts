/** Errors of access requests (docs/access-requests.md): plain sentences an `HttpError` can carry to the Access page. */
import { HttpError } from '../errors';

/** A refused or impossible access request, catalog or grant action. */
export class AccessError extends HttpError {
  static readonly errorName: string = 'AccessError';
  constructor(message: string, status = 400, details?: Record<string, unknown>) {
    super(message, status, { expose: true, ...(details && { details }) });
  }
}

/** The system's own plugin said no ("no such team", "not allowed"): its message, never a token. */
export class AccessActionError extends HttpError {
  static readonly errorName: string = 'AccessActionError';
  constructor(message: string) {
    super(message, 502, { expose: true });
  }
}
