/**
 * Retry a failed (or canceled) execution in the background: a new execution linked to it
 * (`retryOf`, and `retriedBy` on this one). `from: 'failed'` (default) continues from the failed
 * node, reusing what ran before it (from the run's last checkpoint when it has one); `from: 'start'`
 * runs the whole workflow again with the same input. `version: 'original'` (default) runs the
 * version the execution ran, `current` the saved workflow. A pending automatic retry is dropped.
 */
import { z } from 'zod';
import { error, handler, json } from '@/lib/server/http';
import { RerunError, startRetry } from '@/lib/server/runner';
import { store } from '@/lib/server/store';
import { traceparentHeader } from '@/lib/server/telemetry';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const retrySchema = z.object({
  from: z.enum(['failed', 'start']).default('failed'),
  version: z.enum(['original', 'current']).default('original'),
});

export const POST = handler(async (request: Request, { params }: Ctx) => {
  // The body is optional: an empty one retries from the failed node on the original version.
  const raw = await request.text();
  let input: unknown = {};
  try {
    if (raw.trim()) input = JSON.parse(raw);
  } catch {
    return error('Request body must be JSON');
  }
  const body = retrySchema.safeParse(input);
  if (!body.success) return error('Invalid request', 400, { issues: body.error.issues.slice(0, 10) });
  try {
    // The retry continues in the background inside this request's trace.
    const id = (await params).id;
    // Postgres mode: an old run's data is not in memory, and the planner reads it synchronously.
    await store.promoteExecution(id);
    const executionId = await startRetry(id, body.data);
    return json({ executionId }, { status: 202, headers: traceparentHeader() });
  } catch (caught) {
    if (caught instanceof RerunError) return error(caught.message, caught.status);
    throw caught;
  }
});
