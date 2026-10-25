/**
 * Stop every execution: running ones are aborted (saved as canceled), waiting and queued ones
 * canceled, pending automatic retries dropped. Answers how many of each.
 */
import { handler, json } from '@/lib/server/http';
import { stopAllExecutions } from '@/lib/server/runner';

export const dynamic = 'force-dynamic';

export const POST = handler(async () => json(stopAllExecutions()));
