/**
 * GET /api/mcp/files/<binary id>?exp=…&t=…&c=…&sig=…: the file behind a `resource_link` of an MCP tool result
 * (lib/server/mcp/files.ts). No session: the signature (the id, the expiry, the tool and the caller the host signed
 * it for) is the permission, and it stops working at `exp`. Public path (under /api/mcp), like the MCP endpoints.
 */
import { Readable } from 'node:stream';
import { recordAudit } from '@/lib/server/audit';
import { binaryStore } from '@/lib/server/binary/access';
import { fileResponseHeaders } from '@/lib/server/binary/http';
import { error, handler } from '@/lib/server/http';
import { verifyFileUrl } from '@/lib/server/mcp/files';
import { BINARY_ID } from '@landflow/protocol';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

async function serve(request: Request, { params }: Ctx, withBody: boolean): Promise<Response> {
  const { id } = await params;
  const check = BINARY_ID.test(id) ? verifyFileUrl(id, new URL(request.url).searchParams) : ({ ok: false, reason: 'invalid' } as const);
  if (!check.ok) return error(check.reason === 'expired' ? 'This link has expired: call the tool again for a new one' : 'The link is invalid', check.reason === 'expired' ? 410 : 403);
  const binary = await binaryStore();
  const headers = (meta: Parameters<typeof fileResponseHeaders>[0]) => {
    const out = fileResponseHeaders(meta, request);
    out.set('cache-control', 'private, no-store');
    return out;
  };
  if (!withBody) {
    const meta = await binary.head(id);
    return meta ? new Response(null, { headers: headers(meta) }) : error('No such file (its execution may have been deleted)', 404);
  }
  const file = await binary.open(id);
  if (!file) return error('No such file (its execution may have been deleted)', 404);
  try {
    recordAudit({
      action: 'mcp.file.download',
      target: { type: 'binary', id, ...(file.meta.fileName && { name: file.meta.fileName }) },
      summary: `Downloaded ${file.meta.fileName ?? 'a file'} from the result of MCP tool ${check.subject.tool}`,
      details: { tool: check.subject.tool, caller: check.subject.caller, size: file.meta.fileSize },
      actor: 'anonymous',
      project: null,
    });
  } catch {}
  return new Response(Readable.toWeb(file.stream) as ReadableStream<Uint8Array>, { headers: headers(file.meta) });
}

export const GET = handler((request: Request, ctx: Ctx) => serve(request, ctx, true));
export const HEAD = handler((request: Request, ctx: Ctx) => serve(request, ctx, false));
