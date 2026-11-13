'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Plus, Table2 } from 'lucide-react';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { DataTableSummary } from '@/lib/shared/data-tables';
import { CreateTableDialog } from '@/components/data-tables/create-table-dialog';
import { TypeIcon } from '@/components/data-tables/column-type';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { SearchInput } from '@/components/ui/inputs';

/** /data-tables: every built-in table, and "New table". */
export default function DataTablesPage() {
  const [tables, setTables] = useState<DataTableSummary[]>();
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    api<{ tables: DataTableSummary[] }>('/api/data-tables')
      .then((r) => setTables(r.tables))
      .catch((e: Error) => setError(e.message));
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (tables ?? []).filter((t) => !q || t.name.toLowerCase().includes(q) || t.columns.some((c) => c.name.toLowerCase().includes(q)));
  }, [tables, query]);
  const rows = (tables ?? []).reduce((sum, t) => sum + t.rowCount, 0);

  return (
    <>
      <PageHeader
        title="Data tables"
        meta={tables && <span>{tables.length} {tables.length === 1 ? 'table' : 'tables'} · {rows.toLocaleString()} rows</span>}
        actions={
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" /> New table
          </Button>
        }
      />
      <PageBody width="narrow">
        {error && <div className="mb-4 rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>}
        {tables && tables.length > 5 && (
          <SearchInput value={query} onChange={setQuery} placeholder="Search tables and columns" className="mb-3 w-64" />
        )}
        {tables && tables.length === 0 ? (
          <Card className="py-6">
            <EmptyState
              title="No data tables yet"
              hint="Built-in tables for the data your workflows keep: leads, processed ids, settings, results. Read and write them with the Data Table node, here, or as an AI agent tool."
              action={
                <Button onClick={() => setCreating(true)}>
                  <Plus className="size-3.5" /> New table
                </Button>
              }
            />
          </Card>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-hair bg-sf">
            {!tables &&
              [0, 1, 2].map((i) => (
                <div key={i} className="border-b border-hair px-4 py-4 last:border-b-0">
                  <div className="h-4 rounded bg-acdim animate-pulse-soft" style={{ width: `${60 - i * 10}%`, animationDelay: `${i * 90}ms` }} />
                </div>
              ))}
            {shown.map((table, index) => (
              <Link
                key={table.id}
                href={`/data-tables/${table.id}`}
                style={{ animationDelay: `${Math.min(index, 12) * 25}ms` }}
                className="group flex items-center gap-3.5 border-b border-hair px-4 py-3 transition-colors last:border-b-0 hover:bg-acdim animate-fade-up"
              >
                <span className="grid size-[34px] shrink-0 place-items-center rounded-[9px] border border-hair bg-sf2 text-t2">
                  <Table2 className="size-4" strokeWidth={1.8} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-t1">{table.name}</span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-2.5 truncate text-[12px] text-t3">
                    {table.columns.length === 0 && 'No columns yet'}
                    {table.columns.slice(0, 5).map((column) => (
                      <span key={column.name} className="inline-flex items-center gap-1">
                        <TypeIcon type={column.type} className="size-3" />
                        {column.name}
                      </span>
                    ))}
                    {table.columns.length > 5 && <span>+{table.columns.length - 5}</span>}
                  </span>
                </span>
                <span className="w-28 shrink-0 text-right font-mono text-[12px] text-t2">{table.rowCount.toLocaleString()} rows</span>
                <span className="w-28 shrink-0 text-right text-[12px] text-t3">Updated {timeAgo(table.updatedAt)}</span>
                <ChevronRight className="size-4 shrink-0 text-t3 transition-transform group-hover:translate-x-0.5" />
              </Link>
            ))}
            {tables && tables.length > 0 && !shown.length && <EmptyState compact className="py-8" title="No table matches" />}
          </div>
        )}
      </PageBody>
      {creating && <CreateTableDialog onClose={() => setCreating(false)} existingNames={(tables ?? []).map((t) => t.name)} />}
    </>
  );
}
