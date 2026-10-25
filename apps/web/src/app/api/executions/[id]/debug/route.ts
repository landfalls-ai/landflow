/**
 * Control a run that was started in debug mode: continue, step, stop, or
 * replace its breakpoints while it runs.
 */
import { z } from 'zod';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { debugExecution } from '@/lib/server/runner';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const debugSchema = z.object({
  command: z.enum(['continue', 'step', 'stop']).optional(),
  breakpoints: z.array(z.string()).optional(),
});

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, debugSchema);
  if (!body.ok) return body.response;
  const result = debugExecution((await params).id, body.data);
  return result.ok ? json(result) : error(result.error, result.status);
});
