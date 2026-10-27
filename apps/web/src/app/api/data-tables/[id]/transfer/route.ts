/** POST /api/data-tables/:id/transfer { projectId } — move the data table to another project (admins of its project, editors of the target). */
import { dataTables } from '@/lib/server/datatables';
import { transferRoute } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

// Names are unique per project: a table can't move where another has its name.
export const POST = transferRoute('dataTable', (id) => Boolean(dataTables().storage.getTable(id)), undefined, {
  check(id, projectId) {
    const table = dataTables().storage.getTable(id);
    const clash = table && dataTables().inProject(dataTables().listTables(), projectId).find((t) => t.id !== id && t.name.toLowerCase() === table.name.toLowerCase());
    return clash ? { status: 409, message: `That project already has a data table named “${table!.name}”: rename one of them first` } : undefined;
  },
});
