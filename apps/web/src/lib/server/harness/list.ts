/**
 * Who sees which harness sessions (C04 FR-9): the caller's own sessions, and the sessions of Landflow agents the caller may read
 * (every agent for an instance admin). The visibility is part of the query (store.ts `listSessions`), not a filter after it.
 */
import type { HarnessSessionView } from '../../shared/harness';
import { agentStore } from '../agents/store';
import { filterVisible, isInstanceAdmin, type Actor } from '../projects/access';
import { listSessions, viewOf } from './store';

export function harnessSessions(actor: Actor, options: { limit: number; cursor?: string; agentId?: string; open?: boolean }, now = Date.now()): { sessions: HarnessSessionView[]; nextCursor?: string } {
  const readable = isInstanceAdmin(actor) ? undefined : new Set(filterVisible(actor, 'agent', agentStore.list()).map((agent) => agent.id));
  const { rows, nextCursor } = listSessions({ userId: actor.id, readableAgents: readable, ...options });
  return { sessions: rows.map((row) => viewOf(row, now)), ...(nextCursor && { nextCursor }) };
}
