/**
 * The live event feed (/api/events) per viewer: owners and admins get every event; members get registry events and
 * the execution, lock and agent events of the workflows and agents they see. Access is cached briefly per resource,
 * since streaming runs send many events.
 */
import type { BusEvent } from '../bus';
import { canResource, isInstanceAdmin, type Actor } from './access';

const TTL_MS = 5_000;

export function liveEventFilter(actor: Actor): (event: BusEvent) => boolean {
  if (isInstanceAdmin(actor)) return () => true;
  const cache = new Map<string, { ok: boolean; at: number }>();
  const sees = (kind: 'workflow' | 'agent', id: string) => {
    const key = `${kind}:${id}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.ok;
    const ok = canResource(actor, kind, id, 'read');
    cache.set(key, { ok, at: Date.now() });
    return ok;
  };
  return (event) => {
    if ('workflowId' in event && typeof event.workflowId === 'string') return sees('workflow', event.workflowId);
    if ('agentId' in event && typeof event.agentId === 'string') return sees('agent', event.agentId);
    return true;
  };
}
