/** Errors of the practices store (docs/practices.md). `handler()` answers each with its status and `code`. */
import type { PracticeConflict as ConflictInfo } from '../../shared/practices';
import { HttpError } from '../errors';

/** Invalid (400), not allowed (403) or unknown (404). The message is for the person. */
export class PracticeError extends HttpError {
  static readonly errorName: string = 'PracticeError';
  constructor(message: string, status: 400 | 403 | 404 = 400) {
    super(message, status, { expose: true });
  }
}

/** The handle is used by another practice of the same level (and project). */
export class PracticeHandleTaken extends HttpError {
  static readonly errorName: string = 'PracticeHandleTaken';
  constructor(handle: string) {
    super(`The handle “${handle}” is already used here`, 409, { expose: true });
  }
}

/** Approving needs an answer for each approved practice this one overlaps. */
export class PracticeConflict extends HttpError {
  static readonly errorName: string = 'PracticeConflict';
  constructor(readonly conflicts: ConflictInfo[]) {
    super('This practice overlaps approved ones: answer each with Supersede or Keep both', 409, { expose: true, details: { conflicts } });
  }
}

/** A tainted version (read from outside) is approved only by someone who read it against its sources. */
export class PracticeNeedsReview extends HttpError {
  static readonly errorName: string = 'PracticeNeedsReview';
  constructor() {
    super('Read its rules against their sources first', 409, { expose: true });
  }
}
