/**
 * The first-message line that carries a person's memory key to a Landflow agent on kagent (C09 D5, kagent/memory-key.ts): added
 * by the A2A node and an agent's A2A tool to a new conversation's first message, after the practices index.
 */
import { hasMemoryUser } from '../agents/memory';
import { agentStore } from '../agents/store';
import type { Agent } from '../../shared/agents';
import { PRACTICES_INDEX_LINE } from '../practices/remote';
import { deployedConfig } from './deployed-config';
import { memoryKeyFor } from './memory-key';
import { scrubKeys } from './memory-scrub';

const trimmed = (url: string) => url.trim().replace(/\/+$/, '');

/**
 * The Landflow agent whose stored kagent A2A address is exactly `endpoint`. Never the last-path-segment match the notebook uses
 * (`agentAtEndpoint`): an address Landflow did not deploy to (`https://elsewhere/x/agents/ns/<name>`) must not be sent a person's key.
 * A deployment made before the address was stored has none until it is redeployed, and gets no memory key.
 */
export function agentAtExactEndpoint(endpoint: string): Agent | undefined {
  const url = trimmed(endpoint);
  const found = agentStore.list().filter((agent) => {
    const stored = agent.kagent?.a2aUrl ?? agent.kagent?.trace?.a2aUrl;
    return Boolean(stored) && trimmed(stored!) === url;
  });
  return found.length === 1 ? found[0] : undefined;
}

/** The line for a new conversation's first message to the Landflow agent on kagent at `endpoint`; undefined when it is not one, has memory off, or the person has none. */
export function memoryKeyLine(endpoint: string, userId: string | undefined): string | undefined {
  if (!userId || !hasMemoryUser(userId)) return undefined;
  const agent = agentAtExactEndpoint(endpoint);
  const deployed = agent && deployedConfig(agent);
  if (!agent || !deployed?.config.memory.crossSession) return undefined;
  return `Memory key for this person: ${memoryKeyFor(agent.id, userId)}\nPass it as memoryKey to recall_memory, remember and forget_memory. Call recall_memory first.`;
}

/** The line as `memoryKeyLine` writes it, in full (two lines), for taking a copy of it out of a text. */
const OUR_LINE = /^Memory key for this person:.*\n(?:Pass it as memoryKey.*\n?)?\n*/gm;

/**
 * The text with the line after the practices index when it has one, else before the task. A key (or a copy of our line) a caller put in the
 * text is taken out first: a person must not be able to paste another person's key, and must not suppress ours by writing the marker.
 */
export function withMemoryKey(text: string, line: string | undefined): string {
  const clean = scrubKeys(text.replace(OUR_LINE, ''));
  if (!line) return clean;
  const at = clean.indexOf(PRACTICES_INDEX_LINE);
  if (at < 0) return `${line}\n\n${clean}`;
  const end = at + PRACTICES_INDEX_LINE.length;
  return `${clean.slice(0, end)}\n\n${line}${clean.slice(end)}`;
}
