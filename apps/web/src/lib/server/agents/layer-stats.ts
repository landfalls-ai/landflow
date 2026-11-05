/**
 * What the router and the response cache did for an agent lately (docs/agents.md "Model router", "Response cache").
 * Read from the sessions' own notices, so nothing is counted twice and no extra storage is needed.
 */
import type { AgentSession } from '../../shared/agents';
import { agentStore } from './store';

export interface LayerStats {
  /** Sessions looked at (the newest ones). */
  sessions: number;
  /** Messages people (or callers) sent. */
  requests: number;
  /** Requests the router sent to the cheap model. */
  routed: number;
  /** Requests answered from the response cache, with no model call. */
  cached: number;
}

const SESSIONS_SCANNED = 200;

/** Counts one set of sessions. */
export function countLayerEvents(sessions: AgentSession[]): LayerStats {
  const stats: LayerStats = { sessions: sessions.length, requests: 0, routed: 0, cached: 0 };
  for (const session of sessions) {
    for (const entry of session.timeline) {
      if (entry.type === 'user') stats.requests++;
      else if (entry.type === 'notice') {
        if (entry.message.startsWith('Routed to ')) stats.routed++;
        else if (entry.message.startsWith('Answered from the response cache')) stats.cached++;
      }
    }
  }
  return stats;
}

export function layerStats(agentId: string): LayerStats {
  const sessions = agentStore
    .listSessions(agentId, SESSIONS_SCANNED)
    .map((summary) => agentStore.getSession(summary.id))
    .filter((session): session is AgentSession => Boolean(session));
  return countLayerEvents(sessions);
}
