import { z } from 'zod';
import { dataTables } from '@/lib/server/datatables';
import { dataTableRoute } from '@/lib/server/datatables/http';
import { json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

/** Every data table with its columns and row count, by name. */
export const GET = dataTableRoute(async () => json({ tables: dataTables().listTables() }));

/** POST { name, columns?: [{ name, type: string | number | boolean | date }] } */
export const POST = dataTableRoute(async (request: Request) => {
  const body = await parseBody(request, z.object({ name: z.string(), columns: z.array(z.object({ name: z.string(), type: z.string() })).max(100).optional() }));
  if (!body.ok) return body.response;
  return json({ table: dataTables().createTable(body.data) }, 201);
});
