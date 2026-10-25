import { z } from 'zod';
import { dataTables } from '@/lib/server/datatables';
import { dataTableRoute } from '@/lib/server/datatables/http';
import { error, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = dataTableRoute(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  const service = dataTables();
  return json({ table: { ...service.getTable(id), rowCount: service.storage.countRows(id) } });
});

/** PATCH { name } renames the table. */
export const PATCH = dataTableRoute(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, z.object({ name: z.string() }));
  if (!body.ok) return body.response;
  return json({ table: dataTables().renameTable((await params).id, body.data.name) });
});

export const DELETE = dataTableRoute(async (_request: Request, { params }: Ctx) =>
  dataTables().deleteTable((await params).id) ? json({ ok: true }) : error('Data table not found', 404),
);
