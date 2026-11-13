import { dataTables } from '@/lib/server/datatables';
import { dataTableRoute } from '@/lib/server/datatables/http';
import { z } from 'zod';
import { error, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const MAX_CSV_BYTES = 32 * 1024 * 1024;

/**
 * POST a CSV (`text/csv` body, or JSON `{ csv, createColumns? }`) whose first line names the columns.
 * Unknown headers become new columns unless `?createColumns=false`; id/createdAt/updatedAt are skipped.
 */
export const POST = dataTableRoute(async (request: Request, { params }: Ctx) => {
  const url = new URL(request.url);
  let csv: string;
  let createColumns = url.searchParams.get('createColumns') !== 'false';
  if ((request.headers.get('content-type') ?? '').includes('application/json')) {
    const body = await parseBody(request, z.object({ csv: z.string(), createColumns: z.unknown().optional() }).passthrough(), { message: 'Send { csv: "…" } or a text/csv body' });
    if (!body.ok) return body.response;
    csv = body.data.csv;
    if (body.data.createColumns === false) createColumns = false;
  } else csv = await request.text();
  if (Buffer.byteLength(csv) > MAX_CSV_BYTES) return error('The CSV is larger than 32 MB', 413);
  if (!csv.trim()) return error('The CSV is empty');
  return json(dataTables().importCsv((await params).id, csv, { createColumns }));
});
