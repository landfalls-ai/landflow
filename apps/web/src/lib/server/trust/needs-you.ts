/**
 * C27: held MCP tools in Needs you (appended by `needsYou()` like the budget and task items): one item per agent with changes waiting,
 * for the people who may publish the agent. The item carries no run (`executionId`, `workflowId`, `workflowName` are ''); its `href` is
 * the agent page, where the review sheet is.
 */
import { agentStore } from '../agents/store';
import type { NeedsYouItem } from '../journal/needs-you';
import { canResource, type Actor } from '../projects/access';
import type { TrustNeedsYouFields } from '../../shared/trust';
import { heldCount, heldViewOf } from './mcp-tools';
import { pendingFor } from './store';

export type TrustNeedsYouItem = NeedsYouItem & TrustNeedsYouFields;

const MAX_ITEMS = 100;

export function trustItems(actor: Actor | undefined): TrustNeedsYouItem[] {
  if (!actor) return [];
  const ids = new Set<string>();
  for (const record of pendingFor('mcp-tools', 'agent:')) ids.add(record.subjectId.slice('agent:'.length).split('/')[0]);
  const items: TrustNeedsYouItem[] = [];
  for (const id of ids) {
    if (items.length >= MAX_ITEMS) break;
    const agent = agentStore.get(id);
    if (!agent || !canResource(actor, 'agent', id, 'update')) continue;
    const view = heldViewOf(agent);
    const count = heldCount(view);
    if (!count) continue;
    items.push({
      executionId: '',
      workflowId: '',
      workflowName: '',
      kind: 'trust',
      agentId: id,
      heldCount: count,
      title: `${agent.name}: ${count} MCP tool${count === 1 ? '' : 's'} changed`,
      detail: `Held until you review ${count === 1 ? 'it' : 'them'}: ${view.map((v) => v.toolConfigName).join(', ')}`,
      href: `/agents/${id}`,
      since: view.reduce((first, v) => (v.firstSeenAt < first ? v.firstSeenAt : first), view[0].firstSeenAt),
    });
  }
  return items;
}
