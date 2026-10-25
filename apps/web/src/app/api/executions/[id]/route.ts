import { error, handler, json } from '@/lib/server/http';
import { cancelExecution, cancelWaitingExecution, liveExecution } from '@/lib/server/runner';
import { store } from '@/lib/server/store';
import { traceUrl } from '@/lib/server/telemetry';

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
  return json({ execution, ...(link && { traceUrl: link }) });
});

/** DELETE cancels a running or waiting execution, or removes a finished one from history. */
export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (liveExecution(id)) return json({ canceled: cancelExecution(id) });
  if (store.getExecution(id)?.status === 'waiting') return json({ canceled: cancelWaitingExecution(id) });
  return store.deleteExecution(id) ? json({ deleted: true }) : error('Execution not found', 404);
});
