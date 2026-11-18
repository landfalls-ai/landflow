/** AG21: the agent version table's writer, apart from versions.ts so the store can call it without a cycle. */
import type { Agent, AgentConfig } from '../../shared/agents';
import { parse } from '../db/rows';
import { database } from '../db';
import { logger } from '../telemetry/logger';

/** The published version's row, once (idempotent by key). */
export function recordAgentVersion(agent: Agent, by?: string): void {
  const published = agent.published;
  if (!published) return;
  try {
    database().insertNew('agent_versions', { agent_id: agent.id, version: published.version, published_at: published.publishedAt, published_by: by ?? null, config: JSON.stringify(published.config) });
  } catch (error) {
    logger.warn('could not record an agent version', { error, 'landflow.agent.id': agent.id });
  }
}

/** One version's config from the versions table (a version older than the 20 kept in an agent's `history` is only here). */
export function agentVersionRow(agentId: string, version: number): AgentConfig | undefined {
  return parse<AgentConfig>(database().get<{ config: string }>('SELECT config FROM agent_versions WHERE agent_id = ? AND version = ?', agentId, version)?.config);
}
