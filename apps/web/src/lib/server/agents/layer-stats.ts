/**
 * What the router and the response cache did for an agent lately (docs/agents.md "Model router", "Response cache").
 * Read from the sessions' own notices, so nothing is counted twice and no extra storage is needed.
 */
import type { AgentSession } from '../../shared/agents';
import { priceOverrides } from '../ai-usage/prices';
import { estimateSavings, type Savings } from './layer-savings';
import { agentStore, configOf } from './store';

export interface LayerStats {
  /** Sessions looked at (the newest ones). */
  sessions: number;
  /** Messages people (or callers) sent. */
  requests: number;
  /** Requests the router sent to the cheap model. */
  routed: number;
  /** Requests answered from the response cache, with no model call. */
  cached: number;
  /** Estimated USD saved by routing and by the cache (docs/agents.md "Layers"); only where prices are known. */
  saved?: Savings;
}

const SESSIONS_SCANNED = 200;

/** Counts one set of sessions; with `since` (an ISO time), only the steps from then on. */
export function countLayerEvents(sessions: AgentSession[], since?: string): LayerStats {
  const stats: LayerStats = { sessions: sessions.length, requests: 0, routed: 0, cached: 0 };
  for (const session of sessions) {
    for (const entry of session.timeline) {
      if (since && entry.at < since) continue;
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
  return { ...countLayerEvents(sessions), saved: savingsOf(agentStore.get(agentId), sessions) };
}

function savingsOf(agent: ReturnType<typeof agentStore.get>, sessions: AgentSession[], since?: string): Savings {
  const model = agent ? configOf(agent).model : undefined;
  return estimateSavings(sessions, model?.model ? { provider: model.provider, model: model.model } : undefined, priceOverrides(), since);
}

/** Every agent's numbers added up, for the Insights page: the steps since `since`, in each agent's newest sessions. */
export function layerTotals(since: string): LayerStats {
  const total: LayerStats = { sessions: 0, requests: 0, routed: 0, cached: 0, saved: { routing: 0, cache: 0 } };
  for (const agent of agentStore.list()) {
    const sessions = agentStore
      .listSessions(agent.id, SESSIONS_SCANNED)
      .filter((summary) => summary.updatedAt >= since)
      .map((summary) => agentStore.getSession(summary.id))
      .filter((session): session is AgentSession => Boolean(session));
    const stats = countLayerEvents(sessions, since);
    total.sessions += stats.sessions;
    total.requests += stats.requests;
    total.routed += stats.routed;
    total.cached += stats.cached;
    const saved = savingsOf(agent, sessions, since);
    total.saved!.routing += saved.routing;
    total.saved!.cache += saved.cache;
  }
  return total;
}
