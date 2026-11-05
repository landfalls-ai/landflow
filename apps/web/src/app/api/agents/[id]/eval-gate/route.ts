/**
 * The eval gate of a standalone agent (docs/agents.md "Eval gate").
 * GET — the test cases and the latest runs (newest first).
 * POST { input, expected? } — add a test case.
 * PUT { version? } — run every case now on the draft (default) or a published version; the run is saved.
 * DELETE { caseId } — remove a test case.
 */
import { z } from 'zod';
import { addCase, deleteCase, EvalGateError, listCases, listEvalRuns, runEval } from '@/lib/server/agents/eval-gate';
import { agentStore } from '@/lib/server/agents/store';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const failure = (caught: unknown) => (caught instanceof EvalGateError ? error(caught.message, caught.status) : error((caught as Error).message, 500));

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!agentStore.get(id)) return error('Agent not found', 404);
  return json({ cases: listCases(id), runs: listEvalRuns(id) });
});

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!agentStore.get(id)) return error('Agent not found', 404);
  const body = await parseBody(request, z.object({ input: z.string().min(1).max(4_000), expected: z.string().max(4_000).optional() }));
  if (!body.ok) return body.response;
  try {
    return json({ case: addCase(id, body.data) }, 201);
  } catch (caught) {
    return failure(caught);
  }
});

export const PUT = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = await parseBody(request, z.object({ version: z.number().int().positive().optional() }));
  if (!body.ok) return body.response;
  try {
    return json({ run: await runEval(id, body.data.version ?? 'draft', { signal: request.signal }) });
  } catch (caught) {
    return failure(caught);
  }
});

export const DELETE = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = await parseBody(request, z.object({ caseId: z.string().min(1) }));
  if (!body.ok) return body.response;
  return deleteCase(id, body.data.caseId) ? json({ ok: true }) : error('Test case not found', 404);
});
