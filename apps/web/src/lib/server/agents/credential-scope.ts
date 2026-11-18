/**
 * Which credentials an agent's save may NEWLY attach: only ones its home project can use. A credential the draft already holds
 * is left alone (an agent that holds a legacy out-of-scope pick can still be renamed or edited: clients send the whole draft), so
 * the rule refuses the new reference, not the agent. One rule for `PUT /api/agents/:id` and the MCP `update_agent` tool.
 */
import { homeProjectId, usableCredentialIds } from '../projects';
import { agentStore, configOf } from './store';

/** Every credential id a config refers to: any `credential` ({ id }) or `credentials` ({ slot: { id } }) anywhere in it (tools, model, channels, guardrail judge, kagent). */
export function credentialIdsIn(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) credentialIdsIn(item, into);
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      const id = (inner as { id?: unknown } | null)?.id;
      if (key === 'credential' && typeof id === 'string' && id) into.add(id);
      else if (key === 'credentials' && inner && typeof inner === 'object' && !Array.isArray(inner)) {
        for (const ref of Object.values(inner as Record<string, { id?: unknown } | null>)) if (typeof ref?.id === 'string' && ref.id) into.add(ref.id);
      } else credentialIdsIn(inner, into);
    }
  }
  return into;
}

/** The credential ids in `incoming` that are new to the stored draft of `agentId` and that the agent's project may not use. */
export function refusedCredentials(agentId: string, incoming: unknown): string[] {
  const stored = agentStore.get(agentId);
  if (!stored) return [];
  const held = credentialIdsIn(configOf(stored));
  const added = [...credentialIdsIn(incoming)].filter((id) => !held.has(id));
  if (!added.length) return [];
  const usable = usableCredentialIds(homeProjectId('agent', agentId), added);
  return added.filter((id) => !usable.has(id));
}

/** For a NEW agent every reference is new: the ids in `incoming` that the project it is created in may not use. */
export function refusedForNewAgent(projectId: string | undefined, incoming: unknown): string[] {
  const ids = [...credentialIdsIn(incoming)];
  if (!ids.length) return [];
  const usable = usableCredentialIds(projectId, ids);
  return ids.filter((id) => !usable.has(id));
}

export const REFUSED_CREDENTIAL_MESSAGE = 'A credential this agent’s project can’t use is picked: share it with the project, or pick one the project owns';
