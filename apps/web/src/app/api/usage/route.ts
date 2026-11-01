/**
 * GET /api/usage — a grouped report of the usage ledger (docs/second-brain.md):
 * `?groupBy=day|kind|workflow|nodeType|signature|agent|model&kinds=node.failed,ai.call&from=&to=&workflowId=&agentId=&nodeType=&signature=&limit=`.
 * Members see the workflows and agents they can open.
 */
import type { UsageGroup } from '@/lib/shared/brain';
import { agentStore } from '@/lib/server/agents/store';
import { scopeForActor } from '@/lib/server/brain/scope';
import { handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';
import { store } from '@/lib/server/store';
import { usageFilter, usageReport } from '@/lib/server/usage/query';

export const dynamic = 'force-dynamic';

const GROUPS: UsageGroup[] = ['day', 'kind', 'workflow', 'nodeType', 'signature', 'agent', 'model'];

export const GET = handler(async (request: Request) => {
  const url = new URL(request.url);
  const requested = url.searchParams.get('groupBy') as UsageGroup;
  const groupBy = GROUPS.includes(requested) ? requested : 'kind';
  const limit = Number(url.searchParams.get('limit') ?? 50) || 50;
  const labels = (group: UsageGroup, key: string) => (group === 'workflow' ? store.getWorkflow(key)?.name : group === 'agent' ? agentStore.get(key)?.name : undefined);
  return json(usageReport(usageFilter(url), groupBy, { scope: scopeForActor(routeActor()), limit, labels }));
});
