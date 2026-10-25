import { z } from 'zod';
import { dataTables } from '@/lib/server/datatables';
import { dataTableRoute, rowValuesSchema } from '@/lib/server/datatables/http';
import { error, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; rowId: string }> };

const rowIdOf = (raw: string) => (/^\d+$/.test(raw) ? Number(raw) : undefined);

/** PATCH { values: { column: value } } changes one row. */
export const PATCH = dataTableRoute(async (request: Request, { params }: Ctx) => {
  const { id, rowId } = await params;
  const row = rowIdOf(rowId);
  if (row === undefined) return error('Row not found', 404);
  const body = await parseBody(request, z.object({ values: rowValuesSchema }));
  if (!body.ok) return body.response;
  return json({ row: dataTables().updateRow(id, row, body.data.values) });
});

export const DELETE = dataTableRoute(async (_request: Request, { params }: Ctx) => {
  const { id, rowId } = await params;
  const row = rowIdOf(rowId);
  const deleted = row === undefined ? [] : dataTables().deleteRows(id, { ids: [row] });
  return deleted.length ? json({ ok: true }) : error('Row not found', 404);
});
