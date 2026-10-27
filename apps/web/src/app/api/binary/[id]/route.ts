/**
 * GET /api/binary/<id>: the bytes of a stored file (docs/protocol.md §11), with its Content-Type, size and name
 * (`?download=1` makes it an attachment).
 * Single `Range` requests get a 206 (a 416 when unsatisfiable), so video and audio can seek. A plugin sends its `binaryAccess` token and may read the files of its
 * execution and of the call's input items. Without a token it is the editor or the execution viewer asking:
 * Landflow has no sign-in yet, like the rest of the API (with sign-in this needs a session).
 */
import { Readable } from 'node:stream';
import { binaryStore, tokenCanRead, verifyBinaryToken } from '@/lib/server/binary/access';
import { bearerToken, fileResponseHeaders, parseRange, rangeHeaders } from '@/lib/server/binary/http';
import { error, handler } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

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
