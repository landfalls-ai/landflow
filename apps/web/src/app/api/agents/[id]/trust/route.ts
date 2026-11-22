/**
 * An agent's held MCP tools (docs/agents.md#changed-mcp-tools-are-held).
 *
 * GET → `{ holdChangedTools, held: [{ subjectId, toolConfigName, hash, firstSeenAt, changes: [{ name, change, before?, after, fields }] }] }`:
 * the tools a server changed (or added, when the agent takes all its tools) since the agent was published, with the old and the new
 * content. Anyone who can read the agent may call it.
 * POST `{ subjectId, hash, decision: 'approve' | 'reject' }` → `{ record }`: Approve makes the new content the approved one, so the
 * next run offers the tools; Reject keeps them held. Whoever may publish the agent (update access) may decide; a viewer gets 403 and anyone who cannot see the agent 404. A hash that is not pending for this agent's server is 409.
 */
import { z } from 'zod';
import { agentStore } from '@/lib/server/agents/store';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { canResource } from '@/lib/server/projects/access';
import { routeActor } from '@/lib/server/projects/http';
import { agentSubjects, heldViewOf } from '@/lib/server/trust/mcp-tools';
import { approve, recordOf, reject } from '@/lib/server/trust/store';
import type { AgentTrustView } from '@/lib/shared/trust';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const id = (await params).id;
  const agent = agentStore.get(id);
  if (!agent || !canResource(routeActor(), 'agent', id, 'read')) return error('Agent not found', 404);
  const view: AgentTrustView = { holdChangedTools: Boolean((agent.published?.config ?? agent).holdChangedTools), held: heldViewOf(agent) };
  return json(view);
});

const decisionSchema = z.object({ subjectId: z.string().min(1).max(300), hash: z.string().regex(/^[0-9a-f]{64}$/), decision: z.enum(['approve', 'reject']) });

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const id = (await params).id;
  const actor = routeActor();
  const agent = agentStore.get(id);
  if (!agent || !canResource(actor, 'agent', id, 'update')) return error('Agent not found', 404);
  const body = await parseBody(request, decisionSchema);
  if (!body.ok) return body.response;
  const { subjectId, hash, decision } = body.data;
  const pending = subjectId.startsWith(agentSubjects(id)) ? recordOf('mcp-tools', subjectId, hash) : undefined;
  if (!pending || pending.state !== 'pending') return error('That change is not waiting for a decision. It may have been decided, or the server changed again.', 409);
  if (decision === 'reject') {
    reject(actor, 'mcp-tools', subjectId, hash);
    return json({ record: recordOf('mcp-tools', subjectId, hash) });
  }
  return json({ record: approve(actor, 'mcp-tools', subjectId, hash, pending.snapshot, pending.summary) });
});
