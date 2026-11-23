/** Which version of an agent kagent runs (split from deploy.ts so the memory key line can read it without an import cycle). */
import type { Agent, AgentConfig } from '../../shared/agents';

/** The config kagent runs: the deployed version's, else the published one. */
export function deployedConfig(agent: Agent): { config: AgentConfig; version: number } | undefined {
  const version = agent.kagent?.version;
  const found = version !== undefined ? (agent.published?.version === version ? agent.published : agent.history.find((v) => v.version === version)) : undefined;
  const chosen = found ?? agent.published;
  return chosen && { config: chosen.config, version: chosen.version };
}
