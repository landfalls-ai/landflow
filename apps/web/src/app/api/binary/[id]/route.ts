/**
 * GET /api/binary/<id>: the bytes of a stored file (docs/protocol.md §11), with its Content-Type, size and name
 * (`?download=1` makes it an attachment). A plugin sends its `binaryAccess` token and may read the files of its
 * execution and of the call's input items. Without a token it is the editor or the execution viewer asking:
 * Landflow has no sign-in yet, like the rest of the API (with sign-in this needs a session).
 */
import { Readable } from 'node:stream';
import { binaryStore, tokenCanRead, verifyBinaryToken } from '@/lib/server/binary/access';
import { bearerToken, fileResponseHeaders } from '@/lib/server/binary/http';
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
  if (!withBody) {
    const meta = await binary.head(id);
    return meta ? new Response(null, { headers: fileResponseHeaders(meta, request) }) : error('No such file', 404);
  }
  const file = await binary.open(id);
  if (!file) return error('No such file (its execution may have been deleted)', 404);
  return new Response(Readable.toWeb(file.stream) as ReadableStream<Uint8Array>, { headers: fileResponseHeaders(file.meta, request) });
}

export const GET = handler((request: Request, ctx: Ctx) => serve(request, ctx, true));
export const HEAD = handler((request: Request, ctx: Ctx) => serve(request, ctx, false));
