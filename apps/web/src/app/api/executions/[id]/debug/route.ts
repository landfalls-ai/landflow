/**
 * Control a run that was started in debug mode: continue, step, stop, or
 * replace its breakpoints while it runs. Queue mode: a session held by another main is reached over the
 * cluster's control channel (lib/server/cluster/debug.ts), so no sticky sessions are needed.
 */
import { z } from 'zod';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { debugAnywhere } from '@/lib/server/cluster/debug';
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
  const result = await debugAnywhere((await params).id, body.data, debugExecution);
  return result.ok ? json(result) : error(result.error, result.status);
});
