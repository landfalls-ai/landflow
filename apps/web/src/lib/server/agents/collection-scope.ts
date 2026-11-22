/**
 * C21: the knowledge bases an agent's draft may name. Like credential-scope.ts: a NEW base on a collection the agent's project can't
 * read is refused when the draft is saved, so the person hears it in the builder, not in a failed run.
 */
import { isNodeKnowledge, type KnowledgeBaseToolConfig } from '../../shared/agents';
import { homeProjectId } from '../projects/store';
import { collectionAccess } from '../rag/collection-access';
import { collectionKeyOf } from './knowledge';
import { agentStore } from './store';

/**
 * C21: the collections of knowledge bases in `incoming` (an agent's tools) that are new to the stored draft of `agentId` and that the
 * agent's project can't read. A base the draft already holds stays (as with credentials), so a grant revoked later never blocks a save.
 */
export function refusedCollections(agentId: string, incoming: unknown): string[] {
  const tools = (incoming as { tools?: unknown })?.tools;
  if (!Array.isArray(tools)) return [];
  const held = new Set(
    (agentStore.get(agentId)?.tools ?? []).flatMap((t) => (t.type === 'knowledge' && !isNodeKnowledge(t) ? [`${t.store}\u0000${t.collection}`] : [])),
  );
  const project = homeProjectId('agent', agentId);
  const refused: string[] = [];
  for (const raw of tools as KnowledgeBaseToolConfig[]) {
    if (raw?.type !== 'knowledge' || isNodeKnowledge(raw) || typeof raw.collection !== 'string' || !raw.collection.trim()) continue;
    if (held.has(`${raw.store}\u0000${raw.collection}`)) continue;
    try {
      if (collectionAccess(collectionKeyOf(raw), project) === 'none') refused.push(raw.collection.trim());
    } catch {
      // a base whose store can't be reached is refused when it is used
    }
  }
  return refused;
}
