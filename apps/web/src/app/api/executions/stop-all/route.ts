/**
 * Stop every execution: running ones are aborted (saved as canceled), waiting and queued ones
 * canceled, pending automatic retries dropped. Answers how many of each.
 */
import { handler, json } from '@/lib/server/http';
import { stopAllExecutions } from '@/lib/server/runner';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';

export const POST = handler(async () => {
  const result = stopAllExecutions();
  recordAudit({ action: 'execution.stop_all', target: { type: 'execution' }, summary: `Stopped all executions (${result.running} running, ${result.waiting} waiting, ${result.queued} queued)`, details: { ...result } });
  return json(result);
});
