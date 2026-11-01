/**
 * GET /api/runbooks[?kind=&projectId=] — the runbooks you can see (workflows tagged `runbook`), best match first when
 * `kind` (an alert title, alertname or kind slug) is given. POST — save reviewed steps as a draft runbook workflow in
 * a project (docs/runbooks.md).
 */
import { z } from 'zod';
import type { Workflow } from '@landflow/engine';
import { currentActorId } from '@/lib/server/auth/context';
import { governedSave } from '@/lib/server/governance/saves';
import { handler, json, parseBody } from '@/lib/server/http';
import { withOwnership } from '@/lib/server/projects';
import { createInProject, projectParam, routeActor } from '@/lib/server/projects/http';
import { findRunbooks, runbookView, runbookWorkflow, stepSchema } from '@/lib/server/runbooks';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';

const saveSchema = z.object({
  name: z.string().trim().min(1).max(160),
  alertKind: z.string().trim().min(1).max(120),
  description: z.string().max(1000).optional(),
  room: z.string().max(60).optional(),
  steps: z.array(stepSchema).min(1).max(60),
  background: z.object({ cause: z.string().max(600).optional(), fix: z.string().max(600).optional(), lessons: z.string().max(600).optional() }).optional(),
  folderId: z.string().optional(),
});

export const GET = handler(async (request: Request) => {
  const visible = new Set(withOwnership(routeActor(), 'workflow', store.workflowSummaries(), projectParam(request)).map((w) => w.id));
  const kind = new URL(request.url).searchParams.get('kind') ?? '';
  return json({ runbooks: findRunbooks(kind, store.listWorkflows().filter((w) => visible.has(w.id))) });
});

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, saveSchema);
  if (!body.ok) return body.response;
  const built = runbookWorkflow(body.data);
  // Always a draft (not active), in ?projectId= or the caller's personal project; governance still applies to the save.
  const workflow = createInProject(request, 'workflow', () => governedSave(built as Workflow, undefined, (w) => store.saveWorkflow(w), { by: currentActorId() }).workflow, (w) => w.id, { folderId: body.data.folderId, id: built.id });
  return json({ workflow, runbook: runbookView(workflow) }, 201);
});
