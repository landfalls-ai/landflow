/**
 * Re-run an execution in the background: all of it with the same input, or
 * from one node (reusing everything before it), or just one node.
 */
import { z } from 'zod';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { planRerun, RerunError, startInBackground } from '@/lib/server/runner';
import { traceparentHeader } from '@/lib/server/telemetry';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const rerunSchema = z.object({
  scope: z.enum(['all', 'from', 'only']).default('all'),
  nodeId: z.string().optional(),
  version: z.enum(['current', 'original']).default('current'),
});

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, rerunSchema);
  if (!body.ok) return body.response;
  try {
    // The re-run continues in the background inside this request's trace.
    const executionId = await startInBackground(planRerun((await params).id, body.data));
    return json({ executionId }, { status: 202, headers: traceparentHeader() });
  } catch (caught) {
    if (caught instanceof RerunError) return error(caught.message, caught.status);
    throw caught;
  }
});
