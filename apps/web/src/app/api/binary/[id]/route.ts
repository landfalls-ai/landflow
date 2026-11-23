/**
 * GET /api/binary/<id>: the bytes of a stored file (docs/protocol.md §11), with its Content-Type, size and name
 * (`?download=1` makes it an attachment).
 * Single `Range` requests get a 206 (a 416 when unsatisfiable), so video and audio can seek. A plugin sends its `binaryAccess` token and may read the files of its
 * execution and of the call's input items. Without a token it is the editor or the execution viewer asking, with a
 * session or API key: a file that belongs to an execution (or to a workflow's evaluation dataset) needs the right to open
 * that workflow, else 404 (not 403, so ids aren't confirmed); owners and admins see everything. Files with no owner to
 * derive (editor uploads, agent knowledge) stay readable by any signed-in caller (docs/limitations.md).
 */
import { Readable } from 'node:stream';
import { binaryStore, tokenCanRead, verifyBinaryToken } from '@/lib/server/binary/access';
import { binaryScopeOf } from '@landflow/protocol';
import { isDatasetScope } from '@/lib/server/evaluations/store';
import { canResource, executionWorkflowId } from '@/lib/server/projects';
import { routeActor } from '@/lib/server/projects/http';
import { liveExecution } from '@/lib/server/runner';
import { bearerToken, fileResponseHeaders, parseRange, rangeHeaders } from '@/lib/server/binary/http';
import { error, handler } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Whether the caller may open the workflow the file belongs to (files with no derivable owner: yes). */
function canOpenFile(id: string): boolean {
  const actor = routeActor();
  const scope = binaryScopeOf(id);
  if (!scope) return true;
  const workflowId = executionWorkflowId(scope) ?? liveExecution(scope)?.workflowId ?? datasetWorkflow(scope);
  return !workflowId || canResource(actor, 'workflow', workflowId, 'read');
}

function datasetWorkflow(scope: string): string | undefined {
  let found: string | undefined;
  isDatasetScope(scope, (workflowId) => ((found = workflowId), true));
  return found;
}

async function serve(request: Request, { params }: Ctx, withBody: boolean): Promise<Response> {
  const { id } = await params;
  const token = bearerToken(request);
  if (token !== undefined) {
    const claims = verifyBinaryToken(token);
    if (!claims) return error('The binary token is invalid or expired', 401);
    if (!tokenCanRead(claims, id)) return error('This token can’t read that file', 403);
  }
  const binary = await binaryStore();
  const meta = await binary.head(id);
  if (!meta) return error(withBody ? 'No such file (its execution may have been deleted)' : 'No such file', 404);
  if (token === undefined && !canOpenFile(id)) return error('No such file (its execution may have been deleted)', 404);
  // One byte range (`Range: bytes=a-b`, `a-`, `-n`) gets a 206; anything unsatisfiable a 416; anything odd the whole file.
  const range = parseRange(request, meta.fileSize);
  const headers = fileResponseHeaders(meta, request);
  if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: rangeHeaders(headers, meta.fileSize) });
  if (range) rangeHeaders(headers, meta.fileSize, range);
  if (!withBody) return new Response(null, { status: range ? 206 : 200, headers });
  const file = await binary.open(id, range);
  if (!file) return error('No such file (its execution may have been deleted)', 404);
  return new Response(Readable.toWeb(file.stream) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers });
}

export const GET = handler((request: Request, ctx: Ctx) => serve(request, ctx, true));
export const HEAD = handler((request: Request, ctx: Ctx) => serve(request, ctx, false));
