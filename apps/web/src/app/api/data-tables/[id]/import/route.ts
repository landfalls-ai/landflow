import { dataTables } from '@/lib/server/datatables';
import { dataTableRoute } from '@/lib/server/datatables/http';
import { error, json } from '@/lib/server/http';

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
    const body = (await request.json().catch(() => undefined)) as { csv?: unknown; createColumns?: unknown } | undefined;
    if (typeof body?.csv !== 'string') return error('Send { csv: "…" } or a text/csv body');
    csv = body.csv;
    if (body.createColumns === false) createColumns = false;
  } else csv = await request.text();
  if (Buffer.byteLength(csv) > MAX_CSV_BYTES) return error('The CSV is larger than 32 MB', 413);
  if (!csv.trim()) return error('The CSV is empty');
  return json(dataTables().importCsv((await params).id, csv, { createColumns }));
});
