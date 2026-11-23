/**
 * POST /api/settings/networks/:id/runners { name, allowedIps? } registers a runner and answers `{ runner, token }`: the
 * token (`lf_run_…`) is in this answer only; a later read never has it (C29). A built-in admin's.
 */
import { requireUser } from '@/lib/server/auth';
import { handler, json, parseBody } from '@/lib/server/http';
import { registerRunner } from '@/lib/server/networks/store';
import { runnerCreateSchema } from '@/lib/server/networks/schema';

export const dynamic = 'force-dynamic';

export const POST = handler(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const me = await requireUser('settings:manage');
  const body = await parseBody(request, runnerCreateSchema);
  if (!body.ok) return body.response;
  return json(registerRunner((await params).id, body.data, me), 201);
});
