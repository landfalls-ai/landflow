/**
 * POST /api/executions/:id/stop — cancel a running, waiting or queued execution → `{ executionId, stopped, status }`
 * (`status`: what it was). Unlike DELETE it never removes a finished execution: one that already ended answers 409.
 */
import { error, handler, json } from '@/lib/server/http';
import { cancelExecution, cancelQueuedExecution, cancelWaitingExecution, liveExecution } from '@/lib/server/runner';
import { store } from '@/lib/server/store';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  const live = liveExecution(id);
  const record = live ?? await store.loadExecution(id);
  const audit = (status: string) => recordAudit({ action: 'execution.stop', target: { type: 'execution', id, ...(record?.workflowName && { name: record.workflowName }) }, details: { workflowId: record?.workflowId, status } });
  if (live) {
    const stopped = cancelExecution(id);
    audit(live.status);
    return json({ executionId: id, stopped, status: live.status });
  }
  const status = record?.status;
  if (!status) return error('Execution not found', 404);
  if (status === 'waiting' || status === 'queued') {
    const stopped = status === 'waiting' ? cancelWaitingExecution(id) : cancelQueuedExecution(id);
    audit(status);
    return json({ executionId: id, stopped, status });
  }
  return error(`The execution isn't running (it ended with status ${status})`, 409, { executionId: id, status });
});
