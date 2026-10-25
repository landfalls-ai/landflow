/** POST /api/data-tables/:id/transfer { projectId } — move the data table to another project (admins of its project, editors of the target). */
import { dataTables } from '@/lib/server/datatables';
import { transferRoute } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const POST = transferRoute('dataTable', (id) => Boolean(dataTables().storage.getTable(id)));
