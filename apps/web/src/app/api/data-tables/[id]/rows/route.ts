import { z } from 'zod';
import { dataTables } from '@/lib/server/datatables';
import { dataTableRoute, rowFilterSchema, rowQueryFrom, rowValuesSchema } from '@/lib/server/datatables/http';
import { error, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** GET ?offset&limit (≤ 1000, default 50)&sortBy&sortDirection=asc|desc&search&filter=<JSON { type, conditions, ids }> */
export const GET = dataTableRoute(async (request: Request, { params }: Ctx) => {
  const query = rowQueryFrom(new URL(request.url));
  if ('error' in query) return error(query.error);
  return json(dataTables().listRows((await params).id, query));
});

/** POST { rows: [{ column: value }] } inserts rows; values are coerced to the column types. */
export const POST = dataTableRoute(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, z.object({ rows: z.array(rowValuesSchema).min(1).max(10_000) }));
  if (!body.ok) return body.response;
  return json({ rows: dataTables().insertRows((await params).id, body.data.rows) }, 201);
});

/** PATCH { filter, values } updates every row the filter matches. */
export const PATCH = dataTableRoute(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, z.object({ filter: rowFilterSchema, values: rowValuesSchema }));
  if (!body.ok) return body.response;
  if (!body.data.filter.ids?.length && !body.data.filter.conditions?.length) return error('Give row ids or conditions');
  return json({ rows: dataTables().updateRows((await params).id, body.data.filter, body.data.values) });
});

/** DELETE { ids } or { filter } deletes the matching rows. */
export const DELETE = dataTableRoute(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, z.object({ ids: z.array(z.number().int()).max(10_000).optional(), filter: rowFilterSchema.optional() }));
  if (!body.ok) return body.response;
  const filter = { ...body.data.filter, ...(body.data.ids && { ids: body.data.ids }) };
  if (!filter.ids?.length && !filter.conditions?.length) return error('Give row ids or conditions');
  const deleted = dataTables().deleteRows((await params).id, filter);
  return json({ deleted: deleted.length, ids: deleted.map((row) => row.id) });
});
