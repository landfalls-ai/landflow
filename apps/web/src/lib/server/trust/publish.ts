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
import { agentStore } from '../agents/store';
import { snapshotOf, snapshotTooLarge, toolsHash } from './canonical';
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
      try {
        // Too large to snapshot: left for the run, which holds it with a note (nothing can be compared).
        if (snapshotTooLarge(listed.selected)) {
          result.deferred.push(config.id);
          return;
        }
        const hash = toolsHash(listed.selected);
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

/**
 * The one way an agent is published: the new version, then the snapshot of its MCP servers approved as the publisher. Every publish path
 * (the route, Spotlight and MCP publishes, a template's agents, the analyst) goes through here. `trust` never rejects; a caller that cannot
 * wait (a synchronous one) leaves it running, and a server that is slow is snapshotted at its first run anyway.
 */
export function publishAndTrust(agentId: string, publisher?: Pick<Actor, 'id'>): { agent: Agent; trust: Promise<PublishTrust> } | undefined {
  const agent = agentStore.publish(agentId, publisher?.id);
  if (!agent) return undefined;
  const trust = approveOnPublish(publisher, agent).catch((error): PublishTrust => {
    logger.warn('Could not record the MCP tools approved at publish', { agentId, error: (error as Error).message });
    return { recorded: [], deferred: [] };
  });
  return { agent, trust };
}
