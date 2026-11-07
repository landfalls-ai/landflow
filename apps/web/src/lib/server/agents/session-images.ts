/**
 * Where the files (screenshots) a chat's tools return are kept when the run is not in a workflow execution.
 *
 * They used to go under the turn's run id, a scope no execution owns, so the hourly sweep deleted them an hour after the
 * turn and an older chat's images could not be shown again, though its transcript (the session's memory) was still there.
 * They now go under the session's own scope, which is held (a saved binary scope link, the way a waiting parent holds its
 * child's files) until the session is deleted, trimmed away as an agent's oldest sessions, or its agent is removed.
 */
import { deleteExecutionBinary, shareBinaryScope } from '../binary/access';

export const sessionScope = (sessionId: string): string => `session_${sessionId}`;

const held = new Set<string>();

/** Keep the session's scope out of the sweep; the link is saved, so it holds across restarts. */
export function holdSessionImages(sessionId: string): string {
  const scope = sessionScope(sessionId);
  if (!held.has(scope)) {
    held.add(scope);
    shareBinaryScope(scope, scope);
  }
  return scope;
}

/** Let go of the session's scope and delete its files (the session is gone). */
export function releaseSessionImages(sessionId: string): void {
  const scope = sessionScope(sessionId);
  held.delete(scope);
  shareBinaryScope(scope, undefined);
  void deleteExecutionBinary(scope);
}
