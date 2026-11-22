/** The second factor's errors: an `HttpError` whose message is safe to show (it never carries a secret, code or credential). */
import { HttpError } from '../../errors';

export class MfaError extends HttpError {
  static readonly errorName: string = 'MfaError';
  constructor(message: string, status = 400, code?: string) {
    super(message, status, { expose: true, ...(code && { code }) });
  }
}
