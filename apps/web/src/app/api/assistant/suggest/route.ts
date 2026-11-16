import { z } from 'zod';
import type { Workflow } from '@landflow/engine';
import { errorText } from '@/lib/server/assistant/model';
import { allowedTypes } from '@/lib/server/assistant/scope';
import { suggestAfterRun } from '@/lib/server/assistant/suggest';
import { assistantScope, runInUsageScope } from '@/lib/server/ai-usage'; // SB19:
import { resolveSpotlightModel } from '@/lib/server/assistant/models-list'; // SB19:
import { currentPrincipal } from '@/lib/server/auth/guard'; // SB19:
import { meteredWorkflowId } from '@/lib/server/assistant/scope'; // SB19:
import { error, handler, json, parseBody } from '@/lib/server/http';
import { runDigestSchema, workflowSchema } from '@/lib/server/schemas';

export const dynamic = 'force-dynamic';

const Body = z.object({
  workflow: workflowSchema,
  nodeId: z.string().min(1),
  run: runDigestSchema,
  model: z.string().max(100).optional(),
  /** The saved workflow being edited: "next" suggestions then use only the node types it allows. */
  workflowId: z.string().max(200).optional(),
});

/** POST { workflow, nodeId, run } → suggestions for a node that just ran in the editor. */
export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const { workflow, nodeId, run, workflowId } = parsed.data;
  if (!workflow.nodes.some((n) => n.id === nodeId)) return error(`No node ${nodeId} in the workflow`, 404);
  const picked = await resolveSpotlightModel(parsed.data.model); // SB19:
  if ('error' in picked) return error(picked.error, 400); // SB19:
  try {
    // SB19: the suggestion is a Spotlight call: counted under surface `spotlight`, and the caller's caps apply.
    const userId = currentPrincipal()?.user?.id;
    const metered = meteredWorkflowId(workflowId);
    const scope = assistantScope({ surface: 'spotlight', ...(userId && { userId }), ...(metered && { workflowId: metered }) });
    return json(await runInUsageScope(scope, () => suggestAfterRun({ workflow: { id: workflowId ?? 'draft', ...workflow } as Workflow, nodeId, run, model: picked.model, types: allowedTypes(workflowId), signal: request.signal })));
  } catch (e) {
    return error(errorText(e), 502);
  }
});
