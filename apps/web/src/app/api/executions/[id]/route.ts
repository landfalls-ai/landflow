import { executionFeedback } from '@/lib/server/chat-feedback';
import { error, handler, json } from '@/lib/server/http';
import { cancelExecution, cancelQueuedExecution, cancelWaitingExecution, liveExecution } from '@/lib/server/runner';
import { store } from '@/lib/server/store';
import { traceUrl } from '@/lib/server/telemetry';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  const found = liveExecution(id) ?? store.getExecution(id);
  if (!found) return error('Execution not found', 404);
  // The engine state of a waiting run stays on the server.
  const { resumeState: _state, ...execution } = found;
  // The trace link is built here, so LANDFLOW_TRACE_URL stays a plain server setting.
  const link = traceUrl(execution.traceId);
  // A chat answer's thumbs up/down (hosted chat, widget, editor).
  const chatFeedback = executionFeedback(id);
  return json({ execution: { ...execution, ...(chatFeedback && { chatFeedback }) }, ...(link && { traceUrl: link }) });
});

/** DELETE cancels a running, waiting or queued execution, or removes a finished one from history. */
export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  const record = liveExecution(id) ?? store.getExecution(id);
  const target = { type: 'execution', id, ...(record?.workflowName && { name: record.workflowName }) };
  const details = { workflowId: record?.workflowId, status: record?.status };
  if (liveExecution(id)) {
    const canceled = cancelExecution(id);
    recordAudit({ action: 'execution.stop', target, details });
    return json({ canceled });
  }
  const status = store.getExecution(id)?.status;
  if (status === 'waiting' || status === 'queued') {
    const canceled = status === 'waiting' ? cancelWaitingExecution(id) : cancelQueuedExecution(id);
    recordAudit({ action: 'execution.stop', target, details });
    return json({ canceled });
  }
  if (!store.deleteExecution(id)) return error('Execution not found', 404);
  recordAudit({ action: 'execution.delete', target, details });
  return json({ deleted: true });
});
