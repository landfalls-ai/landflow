import { z } from 'zod';
import { dataTables } from '@/lib/server/datatables';
import { dataTableRoute } from '@/lib/server/datatables/http';
import { json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; column: string }> };

/** PATCH { name } renames the column, keeping its values. */
export const PATCH = dataTableRoute(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, z.object({ name: z.string() }));
  if (!body.ok) return body.response;
  const { id, column } = await params;
  return json({ table: dataTables().renameColumn(id, column, body.data.name) });
});

/** Deletes the column and its values. */
export const DELETE = dataTableRoute(async (_request: Request, { params }: Ctx) => {
  const { id, column } = await params;
  return json({ table: dataTables().deleteColumn(id, column) });
});
