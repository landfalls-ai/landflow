import { recordAudit } from '@/lib/server/audit';
import { dataTables } from '@/lib/server/datatables';
import { dataTableRoute } from '@/lib/server/datatables/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Every row as a CSV download: id, the columns, createdAt, updatedAt. */
export const GET = dataTableRoute(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  const service = dataTables();
  const table = service.getTable(id);
  const file = `${table.name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'data-table'}.csv`;
  const csv = service.exportCsv(id);
  recordAudit({ action: 'datatable.export', target: { type: 'data_table', id, name: table.name }, summary: `Exported the data table ${table.name} as CSV`, details: { rows: service.storage.countRows(id), columns: table.columns.length, bytes: Buffer.byteLength(csv) } });
  return new Response(csv, {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${file}"`, 'cache-control': 'no-store' },
  });
});
