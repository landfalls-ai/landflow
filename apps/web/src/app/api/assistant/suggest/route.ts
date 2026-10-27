import { z } from 'zod';
import type { Workflow } from '@landflow/engine';
import { errorText } from '@/lib/server/assistant/model';
import { allowedTypes } from '@/lib/server/assistant/scope';
import { suggestAfterRun } from '@/lib/server/assistant/suggest';
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
  const { workflow, nodeId, run, model, workflowId } = parsed.data;
  if (!workflow.nodes.some((n) => n.id === nodeId)) return error(`No node ${nodeId} in the workflow`, 404);
  try {
    return json(await suggestAfterRun({ workflow: { id: workflowId ?? 'draft', ...workflow } as Workflow, nodeId, run, model, types: allowedTypes(workflowId), signal: request.signal }));
  } catch (e) {
    return error(errorText(e), 502);
  }
});
