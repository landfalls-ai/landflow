/**
 * POST /api/executions/:id/stop — cancel a running, waiting or queued execution → `{ executionId, stopped, status }`
 * (`status`: what it was). Unlike DELETE it never removes a finished execution: one that already ended answers 409.
 */
import { error, handler, json } from '@/lib/server/http';
import { cancelExecution, cancelQueuedExecution, cancelWaitingExecution, liveExecution } from '@/lib/server/runner';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  const live = liveExecution(id);
  if (live) return json({ executionId: id, stopped: cancelExecution(id), status: live.status });
  const status = store.getExecution(id)?.status;
  if (!status) return error('Execution not found', 404);
  if (status === 'waiting') return json({ executionId: id, stopped: cancelWaitingExecution(id), status });
  if (status === 'queued') return json({ executionId: id, stopped: cancelQueuedExecution(id), status });
  return error(`The execution isn't running (it ended with status ${status})`, 409, { executionId: id, status });
});
