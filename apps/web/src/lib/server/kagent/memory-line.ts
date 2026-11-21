/**
 * The first-message line that carries a person's memory key to a Landflow agent on kagent (C09 D5, kagent/memory-key.ts): added
 * by the A2A node and an agent's A2A tool to a new conversation's first message, after the practices index.
 */
import { hasMemoryUser } from '../agents/memory';
import { agentAtEndpoint } from '../notebook/binding';
import { PRACTICES_INDEX_LINE } from '../practices/remote';
import { deployedConfig } from './deployed-config';
import { memoryKeyFor } from './memory-key';

/** The line for a new conversation's first message to the Landflow agent on kagent at `endpoint`; undefined when it is not one, has memory off, or the person has none. */
export function memoryKeyLine(endpoint: string, userId: string | undefined): string | undefined {
  if (!userId || !hasMemoryUser(userId)) return undefined;
  const agent = agentAtEndpoint(endpoint);
  const deployed = agent && deployedConfig(agent);
  if (!agent || !deployed?.config.memory.crossSession) return undefined;
  return `Memory key for this person: ${memoryKeyFor(agent.id, userId)}\nPass it as memoryKey to recall_memory, remember and forget_memory. Call recall_memory first.`;
}

/** The text with the line after the practices index when it has one, else before the task: once per conversation, never twice. */
export function withMemoryKey(text: string, line: string | undefined): string {
  if (!line || text.includes('Memory key for this person:')) return text;
  const at = text.indexOf(PRACTICES_INDEX_LINE);
  if (at < 0) return `${line}\n\n${text}`;
  const end = at + PRACTICES_INDEX_LINE.length;
  return `${text.slice(0, end)}\n\n${line}${text.slice(end)}`;
}
