import { handler, json } from '@/lib/server/http';
import { pruneExecutions } from '@/lib/server/settings';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';

/** Settings → "Prune now": apply the retention settings to the stored executions. Running and waiting ones are kept. */
export const POST = handler(async () => {
  const removed = pruneExecutions();
  return json({ removed, remaining: store.listExecutions({ limit: Number.POSITIVE_INFINITY }).length });
});
