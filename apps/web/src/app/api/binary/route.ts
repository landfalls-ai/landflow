/**
 * POST /api/binary: a plugin stores a file (docs/protocol.md §11). The body is the raw bytes, streamed; the
 * Content-Type is the file's MIME type and the name comes in `X-Landflow-File-Name` (percent-encoded) or
 * `?fileName=`. Needs the `binaryAccess` token of the call (`Authorization: Bearer …`); the file goes into the
 * token's execution scope. Answers 201 with the stored BinaryRef.
 */
import { DEFAULT_MIME_TYPE, mimeTypeFromFileName } from '@landflow/protocol';
import { binaryLimits, binaryStore, verifyBinaryToken } from '@/lib/server/binary/access';
import { bearerToken, uploadFileName } from '@/lib/server/binary/http';
import { BinaryTooLargeError } from '@/lib/server/binary/store';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async (request: Request) => {
  const claims = verifyBinaryToken(bearerToken(request));
  if (!claims) return error('A valid binary token is required (Authorization: Bearer <binaryAccess.token>)', 401);
  if (!request.body) return error('Send the file as the request body');
  const { maxBytes } = binaryLimits();
  if (Number(request.headers.get('content-length')) > maxBytes) return error(new BinaryTooLargeError(maxBytes).message, 413);
  const fileName = uploadFileName(request);
  const type = request.headers.get('content-type')?.trim();
  const mimeType = type && type !== DEFAULT_MIME_TYPE ? type : mimeTypeFromFileName(fileName);
  const ref = await (await binaryStore()).put(claims.w, request.body, { mimeType, ...(fileName && { fileName }) }, { maxBytes });
  return json(ref, 201);
});
