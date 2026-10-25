/** POST /api/agents/:id/transfer { projectId } — move the agent to another project (admins of its project, editors of the target). */
import { agentStore } from '@/lib/server/agents/store';
import { transferRoute } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const POST = transferRoute('agent', (id) => Boolean(agentStore.get(id)));
