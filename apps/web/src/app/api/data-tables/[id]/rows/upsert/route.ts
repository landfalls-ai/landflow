import { z } from 'zod';
import { dataTables } from '@/lib/server/datatables';
import { dataTableRoute, rowValuesSchema } from '@/lib/server/datatables/http';
import { json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** POST { matchColumns, rows }: rows that match an existing row on `matchColumns` update it, the others are inserted. */
export const POST = dataTableRoute(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, z.object({ matchColumns: z.array(z.string()).min(1).max(20), rows: z.array(rowValuesSchema).min(1).max(10_000) }));
  if (!body.ok) return body.response;
  return json(dataTables().upsertRows((await params).id, body.data.matchColumns, body.data.rows));
});
