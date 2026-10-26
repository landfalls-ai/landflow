/**
 * POST /api/workflows/import — Landflow, n8n or Flowise (chatflow / agentflow)
 * workflow JSON (also n8n's clipboard JSON) → a new workflow, or with `create: false` just the converted
 * document, for importing into the open workflow or pasting n8n nodes.
 */
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { Workflow } from '@landflow/engine';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { importWorkflowJson } from '@/lib/server/n8n-import';
import { createInProject, projectParam, targetProject } from '@/lib/server/projects/http';
import { registry } from '@/lib/server/plugins/registry';
import { workflowSchema } from '@/lib/server/schemas';
import { store } from '@/lib/server/store';
import { currentActorId } from '@/lib/server/auth/context';
import { scopeFor, workflowViolations } from '@/lib/server/governance/policy';
import { governedSave } from '@/lib/server/governance/saves';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  /** Parsed JSON or the JSON text. */
  data: z.unknown(),
  name: z.string().min(1).max(200).optional(),
  folderId: z.string().optional(),
  /** false: convert only, nothing is saved. */
  create: z.boolean().default(true),
});

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  const { data, name, folderId, create } = body.data;
  if (data === undefined || data === null || data === '') return error('Nothing to import: send the workflow JSON as "data"');

  const descriptors = new Map(registry.nodeTypes().map((t) => [t.type, t.descriptor]));
  let result: ReturnType<typeof importWorkflowJson>;
  try {
    result = importWorkflowJson(data, { resolveType: (type) => descriptors.get(type) });
  } catch (caught) {
    return error((caught as Error).message);
  }

  const converted = { ...result.workflow, ...(name && { name }), ...(folderId && { folderId }) };
  const valid = workflowSchema.safeParse(converted);
  if (!valid.success) {
    const issue = valid.error.issues[0];
    return error(`The imported workflow is invalid: ${issue?.path.join('.') || 'workflow'}: ${issue?.message}`, 400, { issues: valid.error.issues.slice(0, 10), report: result.report });
  }
  const imported = valid.data as Omit<Workflow, 'id'>;
  // Settings → Governance: nodes the policy blocks are reported (the import goes through; publishing is refused).
  // The project it goes to may narrow the list (its allowed nodes).
  const blocked = workflowViolations(imported, undefined, scopeFor({ projectId: create ? targetProject(request, folderId) : (projectParam(request) ?? undefined) })).map((v) => ({ name: v.nodeName, type: v.nodeType, reason: v.message }));
  const report = blocked.length ? { ...result.report, blocked } : result.report;
  if (!create) return json({ workflow: { ...imported, id: '' }, report });
  let extras = {};
  const id = `wf_${nanoid(10)}`;
  const workflow = createInProject(request, 'workflow', () => {
    const saved = governedSave({ ...imported, id } as Workflow, undefined, (w) => store.saveWorkflow(w), { by: currentActorId(), action: 'workflow.import', source: result.report.format });
    extras = saved.extras;
    return saved.workflow;
  }, (w) => w.id, { folderId, id });
  return json({ workflow, report, ...extras }, 201);
});
