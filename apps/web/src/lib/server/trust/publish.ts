/**
 * C27: what publishing an agent records about its MCP servers (docs/agents.md#changed-mcp-tools-are-held): each server config's tools are
 * listed (in parallel, each given 10 s) and their snapshot is approved as the publisher. A server that does not answer is left for
 * its first run (`first seen at run`), so publishing never waits on a slow server. Kept apart from ./mcp-tools because it lists
 * through agents/tools.ts, which in turn filters through ./mcp-tools.
 */
import type { JsonObject } from '@landflow/protocol';
import type { Agent } from '../../shared/agents';
import type { Actor } from '../projects/access';
import { listMcpConfigTools } from '../agents/tools';
import { logger } from '../telemetry/logger';
import { snapshotOf, toolsHash } from './canonical';
import { mcpSubject } from './mcp-tools';
import { approve, currentApproval } from './store';

export const PUBLISH_LIST_TIMEOUT_MS = 10_000;

export interface PublishTrust {
  /** The tool config ids whose snapshot is approved. */
  recorded: string[];
  /** The ones that did not answer in time, or failed: snapshotted at their first run. */
  deferred: string[];
}

/** List one server's tools, or give up after `ms`. */
async function listWithin<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)));
  try {
    return await Promise.race([work.catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** At publish: approve the snapshot of every MCP server config of the published version as `actor`. */
export async function approveOnPublish(actor: Pick<Actor, 'id'> | undefined, agent: Agent, options: { timeoutMs?: number } = {}): Promise<PublishTrust> {
  const configs = (agent.published?.config.tools ?? agent.tools).filter((tool) => tool.type === 'mcp');
  const result: PublishTrust = { recorded: [], deferred: [] };
  await Promise.all(
    configs.map(async (config) => {
      const listed = await listWithin(listMcpConfigTools(config), options.timeoutMs ?? PUBLISH_LIST_TIMEOUT_MS);
      if (!listed || 'error' in listed) {
        result.deferred.push(config.id);
        return;
      }
      const subject = mcpSubject(agent.id, config.id);
      const hash = toolsHash(listed.selected);
      try {
        // Already approved as it is: nothing to record again.
        if (currentApproval('mcp-tools', subject)?.hash !== hash) approve(actor, 'mcp-tools', subject, hash, snapshotOf(listed.selected) as unknown as JsonObject, 'published');
        result.recorded.push(config.id);
      } catch (error) {
        logger.warn('Could not record the MCP tools approved at publish', { agentId: agent.id, toolId: config.id, error: (error as Error).message });
        result.deferred.push(config.id);
      }
    }),
  );
  result.recorded.sort();
  result.deferred.sort();
  return result;
}
