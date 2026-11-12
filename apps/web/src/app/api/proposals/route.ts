/**
 * Suggestions (docs/second-brain.md#4-detectors-and-suggestions).
 * GET  ?status=open|applied|dismissed|snoozed|expired|all&workflowId=&agentId=&detector=&limit= — highest score first
 *      (`detector`: a built-in one or `flow:<workflowId>`); the
 *      viewer's workflows and agents only (owners and admins: also the instance's), and the ones addressed to them
 *      (`audience`). `?for=me` keeps only those addressed to the caller.
 * POST ProposalInput — (`audience`: up to 10 people, emails, user ids or Slack member ids) a suggestion from outside (an agent or a script over the API), source `analyst`; its ops are
 *      checked against the workflow, and `actions` (up to 4 buttons) go on its card. Needs edit access to the workflow or agent it is about.
 */
import { z } from 'zod';
import { isDetectorId, type ProposalStatus } from '@/lib/shared/brain';
import { canSee } from '@/lib/server/brain/audience';
import { listProposals, proposeFrom, ProposalError } from '@/lib/server/brain/proposals';
import { canProposal, scopeForActor } from '@/lib/server/brain/scope';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';
import { store } from '@/lib/server/store';
import { agentStore } from '@/lib/server/agents/store';

export const dynamic = 'force-dynamic';

const STATUSES = ['open', 'applied', 'dismissed', 'snoozed', 'expired', 'all'];

export const GET = handler(async (request: Request) => {
  const url = new URL(request.url);
  const param = (name: string) => url.searchParams.get(name)?.trim() || undefined;
  const status = STATUSES.includes(param('status') ?? '') ? (param('status') as ProposalStatus | 'all') : 'open';
  const wanted = param('detector');
  const detector = isDetectorId(wanted) ? wanted : undefined;
  const actor = routeActor();
  const proposals = listProposals({ status, workflowId: param('workflowId'), agentId: param('agentId'), detector, scope: scopeForActor(actor), limit: Number(param('limit') ?? 200) || 200, viewer: actor, forMe: param('for') === 'me' });
  return json({ proposals: proposals.filter((p) => canSee(actor, p)) });
});

const Evidence = z.object({ label: z.string().max(120), value: z.union([z.string().max(300), z.number()]).optional(), href: z.string().max(500).optional() });

const Body = z.object({
  title: z.string().trim().min(1).max(160),
  why: z.string().trim().min(1).max(2_000),
  label: z.string().max(80).optional(),
  workflowId: z.string().max(200).optional(),
  agentId: z.string().max(200).optional(),
  nodeName: z.string().max(200).optional(),
  evidence: z.array(Evidence).max(12).optional(),
  effect: z.string().max(300).optional(),
  ops: z.array(z.unknown()).max(50).optional(),
  agentChange: z.object({ always: z.array(z.string().max(200)).max(3).optional(), never: z.array(z.string().max(200)).max(3).optional() }).optional(),
  risk: z.enum(['low', 'medium', 'high']).optional(),
  confidence: z.number().min(0).max(1).optional(),
  actions: z.array(z.object({ id: z.string().max(32), label: z.string().max(40), style: z.enum(['primary', 'default']).optional(), confirm: z.string().max(200).optional() })).max(4).optional(),
  fingerprint: z.string().max(64).optional(),
  audience: z.array(z.object({ userId: z.string().max(200).optional(), email: z.string().max(200).optional(), slackUserId: z.string().max(40).optional(), name: z.string().max(80).optional() })).max(10).optional(),
});

export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const input = parsed.data;
  const actor = routeActor();
  const target = input.workflowId
    ? { type: 'workflow' as const, id: input.workflowId, exists: Boolean(store.getWorkflow(input.workflowId)) }
    : input.agentId
      ? { type: 'agent' as const, id: input.agentId, exists: Boolean(agentStore.get(input.agentId)) }
      : { type: 'instance' as const, exists: true };
  if (!target.exists) return error(`No ${target.type} ${'id' in target ? target.id : ''}`, 404);
  if (!canProposal(actor, { target }, 'update')) return error('You can’t make suggestions about this', 403);
  try {
    const proposal = proposeFrom(input, 'analyst');
    return proposal ? json({ proposal }, 201) : json({ proposal: null, reason: 'held back: the same advice is already open for this node, it was dismissed or applied recently, or the weekly cap is full' });
  } catch (caught) {
    if (caught instanceof ProposalError) return error(caught.message, caught.status);
    throw caught;
  }
});
