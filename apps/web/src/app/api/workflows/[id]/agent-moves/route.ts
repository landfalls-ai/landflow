/**
 * AG17: what moved from a workflow's wired sub-nodes into its agents' drafts (docs/agents.md#from-workflows).
 * GET → { moves }: the record of this flow, newest first, each moved item's `state` read against the agent now.
 * POST { updatedAt?, subNodeIds?, resolve? } (`?dryRun=1`) → AgentMoveResult: moves every movable wired sub-node (or only
 * `subNodeIds`) into the agents' drafts and saves the flow without them, in one step; 412 `workflow_conflict` when `updatedAt` is
 * not the stored one; a protected environment refuses it like any workflow write (the guard in lib/server/environments/protection.ts).
 */
import { z } from 'zod';
import { moveFlowOverrides, movesOf } from '@/lib/server/agents/flow-moves';
import { currentActorId } from '@/lib/server/auth/context';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  updatedAt: z.string().max(100).optional(),
  subNodeIds: z.array(z.string().max(200)).max(200).optional(),
  resolve: z.record(z.string().max(200), z.literal('useEverywhere')).optional(),
});

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!store.getWorkflow(id)) return error('Workflow not found', 404);
  return json({ moves: movesOf({ workflowId: id }, routeActor()) });
});

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  const actor = routeActor();
  const dryRun = new URL(request.url).searchParams.get('dryRun') === '1';
  const { updatedAt, subNodeIds, resolve } = body.data;
  return json(moveFlowOverrides(id, actor, { by: currentActorId() ?? actor.id, ...(updatedAt && { updatedAt }), ...(subNodeIds && { subNodeIds }), ...(resolve && { resolve }), dryRun }));
});
