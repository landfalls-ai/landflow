/**
 * A protected environment (./settings.ts `protection`): workflows and folders are read-only on this instance, and
 * change only by pull or promotion (lib/server/sync, which writes the store directly). The API guard refuses the
 * requests that would change them (`protectedWriteRefusal`, also "Use template", which creates one), and the UI
 * disables what would (lib/client/environment.ts `useWorkflowsReadOnly`); the instance MCP server's tools call
 * `assertWorkflowsWritable`. Runs, publishing (a pulled draft, a rollback, an emergency unpublish), credentials,
 * variables and data table rows stay open: they are this environment's own.
 *
 * Kept apart from the role checks and from four-eyes publishing, so each can change without the others.
 */
import { underPath } from '../../shared/auth-paths';
import { currentEnvironment, isProtectedEnvironment } from './settings';
import { HttpError } from '../errors';

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Workflow routes that only run or publish what is there, hold the editor's lock or share it: open in a protected environment. */
const OPEN = [/^\/api\/workflows\/[^/]+\/(run|execute|publish|unpublish|lock|alert|polls|shares|transfer)$/, /^\/api\/workflows\/[^/]+\/schedules(\/[^/]+)?$/, /^\/api\/workflows\/[^/]+\/(evaluations|online-evaluations)(\/.*)?$/];

/** The message for a refused change. */
export function protectedMessage(): string {
  return `${currentEnvironment() ?? 'This'} is a protected environment: workflows are read-only here and change only by pull or promotion`;
}

/** Routes outside /api/workflows that create workflows: "Use template". */
const CREATES = [/^\/api\/templates\/[^/]+\/use$/];

/** Why the guard refuses `method` on `path` here, or undefined when it may go on. */
export function protectedWriteRefusal(method: string, path: string): string | undefined {
  if (!WRITES.has(method.toUpperCase())) return undefined;
  if (CREATES.some((pattern) => pattern.test(path))) return isProtectedEnvironment() ? protectedMessage() : undefined;
  if (!underPath(path, '/api/workflows') && !underPath(path, '/api/folders')) return undefined;
  if (OPEN.some((pattern) => pattern.test(path))) return undefined;
  return isProtectedEnvironment() ? protectedMessage() : undefined;
}

export class ProtectedEnvironmentError extends HttpError {
  static readonly errorName: string = 'ProtectedEnvironmentError';
  constructor() {
    super(protectedMessage(), 403);
  }
}

/** Throw when workflows are read-only here (for writers that aren't API routes). */
export function assertWorkflowsWritable(): void {
  if (isProtectedEnvironment()) throw new ProtectedEnvironmentError();
}
