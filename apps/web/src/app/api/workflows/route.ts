import { nanoid } from 'nanoid';
import type { Workflow } from '@landflow/engine';
import { handler, json, parseBody } from '@/lib/server/http';
import { workflowSchema } from '@/lib/server/schemas';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json({ workflows: store.workflowSummaries(), stats: store.stats() }));

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, workflowSchema);
  if (!body.ok) return body.response;
  const id = body.data.id && !store.getWorkflow(body.data.id) ? body.data.id : `wf_${nanoid(10)}`;
  return json({ workflow: store.saveWorkflow({ ...body.data, id } as Workflow) }, 201);
});
