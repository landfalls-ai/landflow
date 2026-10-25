import { DataTableView } from '@/components/data-tables/table-view';

/** /data-tables/:id — one table as an editable grid. */
export default async function DataTablePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DataTableView key={id} tableId={id} />;
}
