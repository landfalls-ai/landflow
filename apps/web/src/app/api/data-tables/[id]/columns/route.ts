import { z } from 'zod';
import { dataTables } from '@/lib/server/datatables';
import { dataTableRoute } from '@/lib/server/datatables/http';
import { json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** POST { name, type } adds a column; existing rows read it as empty. */
export const POST = dataTableRoute(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, z.object({ name: z.string(), type: z.string() }));
  if (!body.ok) return body.response;
  return json({ table: dataTables().addColumn((await params).id, body.data) }, 201);
});
