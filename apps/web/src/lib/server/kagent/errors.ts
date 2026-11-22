/** A deploy or status request kagent's side can't take, with the words for the person (the route answers it as is). */
import { HttpError } from '../errors';

export class KagentError extends HttpError {
  static readonly errorName: string = 'KagentError';
  constructor(
    message: string,
    status = 400,
  ) {
    super(message, status, { expose: true });
  }
}
