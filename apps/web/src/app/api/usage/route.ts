/**
 * GET /api/usage — a grouped report of the usage ledger (docs/second-brain.md):
 * `?groupBy=day|kind|workflow|nodeType|signature|agent|model|attr&kinds=node.failed,work.ticket_moved&from=&to=&workflowId=&agentId=&nodeType=&signature=&limit=`;
 * `groupBy=attr&groupAttr=team` groups by one attribute and `attr.team=billing` keeps events with that attribute value
 * (both read the raw events, not the daily rollups).
 * Members see the workflows and agents they can open.
 */
import type { UsageGroup } from '@/lib/shared/brain';
import { agentStore } from '@/lib/server/agents/store';
import { scopeForActor } from '@/lib/server/brain/scope';
import { z } from 'zod';
import { error, handler, json, parseQuery } from '@/lib/server/http';
import { limitParam } from '@/lib/server/pagination';
import { routeActor } from '@/lib/server/projects/http';
import { store } from '@/lib/server/store';
import { usageFilter, usageReport } from '@/lib/server/usage/query';

export const dynamic = 'force-dynamic';

const GROUPS: UsageGroup[] = ['day', 'kind', 'workflow', 'nodeType', 'signature', 'agent', 'model', 'attr'];

export const GET = handler(async (request: Request) => {
  const url = new URL(request.url);
  const requested = url.searchParams.get('groupBy') as UsageGroup;
  const groupBy = GROUPS.includes(requested) ? requested : 'kind';
  const query = parseQuery(request, z.object({ limit: limitParam(1000, 50) }));
  if (!query.ok) return query.response;
  const { limit } = query.data;
  const labels = (group: UsageGroup, key: string) => (group === 'workflow' ? store.getWorkflow(key)?.name : group === 'agent' ? agentStore.get(key)?.name : undefined);
  const filter = usageFilter(url);
  if (groupBy === 'attr' && !filter.attr) return error('groupBy=attr needs groupAttr, the attribute to group by (for example groupAttr=team)');
  return json(usageReport(filter, groupBy, { scope: scopeForActor(routeActor()), limit, labels }));
});
