'use client';
/**
 * One data table as an editable grid: click a cell to edit it (Enter or Tab
 * saves, Esc cancels; booleans toggle), add rows and columns, rename or delete
 * columns from their header menu, sort by a column, search, page through rows,
 * select and delete rows, and import or export CSV.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Columns3, Download, Ellipsis, Loader2, Pencil, Plus, Search, Trash2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { COLUMN_TYPES, type ColumnType, type CsvImportResult, type DataTable, type DataTableColumn, type DataTableRow, type RowPage } from '@/lib/shared/data-tables';
import { PageHeader } from '../shell/page-header';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { FieldLabel, Input, Select } from '../ui/inputs';
import { MenuItem, MenuSeparator, Popover } from '../ui/popover';
import { formatCell, toLocalInput, TypeIcon, TYPE_META } from './column-type';
import { ConfirmDialog } from './dialog';

type TableInfo = DataTable & { rowCount: number };
type Sort = { column: string; direction: 'asc' | 'desc' } | undefined;
type Confirm = { kind: 'rows' } | { kind: 'table' } | { kind: 'column'; name: string };

const PAGE_SIZES = [25, 50, 100, 250];
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** Text input for one cell. `onCommit(undefined)` = unchanged. */
function CellEditor({ column, value, onCommit, onCancel }: { column: DataTableColumn; value: unknown; onCommit: (value: unknown, move?: 1 | -1) => void; onCancel: () => void }) {
  const initial = column.type === 'date' ? toLocalInput(value as string) : value === null || value === undefined ? '' : String(value);
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const commit = (move?: 1 | -1) => {
    if (done.current) return;
    done.current = true;
    if (text === initial) return onCommit(undefined, move);
    if (!text.trim() && column.type !== 'string') return onCommit(null, move);
    onCommit(column.type === 'date' ? new Date(text).toISOString() : text === '' ? null : text, move);
  };
  return (
    <input
      autoFocus
      type={column.type === 'date' ? 'datetime-local' : 'text'}
      inputMode={column.type === 'number' ? 'decimal' : undefined}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          done.current = true;
          onCancel();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          commit(e.shiftKey ? -1 : 1);
        }
      }}
      className={cn('h-8 w-full rounded-md border border-ac bg-sf px-2 text-[13px] text-t1 outline-none', column.type !== 'string' && 'font-mono')}
    />
  );
}

function AddColumn({ onAdd }: { onAdd: (name: string, type: ColumnType) => Promise<boolean> }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<ColumnType>('string');
  const [busy, setBusy] = useState(false);
  return (
    <Popover
      align="end"
      className="w-[280px] p-3"
      trigger={({ toggle }) => (
        <Button size="sm" onClick={toggle}>
          <Columns3 className="size-3.5" /> Add column
        </Button>
      )}
    >
      {(close) => {
        const submit = async () => {
          if (!name.trim()) return;
          setBusy(true);
          const ok = await onAdd(name.trim(), type);
          setBusy(false);
          if (ok) {
            setName('');
            close();
          }
        };
        return (
          <div className="space-y-3">
            <div>
              <FieldLabel>Name</FieldLabel>
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} placeholder="email" className="font-mono" />
            </div>
            <div>
              <FieldLabel>Type</FieldLabel>
              <Select value={type} onChange={(e) => setType(e.target.value as ColumnType)}>
                {COLUMN_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_META[t].label}
                  </option>
                ))}
              </Select>
            </div>
            <Button variant="primary" size="sm" className="w-full" onClick={submit} loading={busy} disabled={!name.trim()}>
              <Plus className="size-3.5" /> Add column
            </Button>
          </div>
        );
      }}
    </Popover>
  );
}

function InlineRename({ value, onSave, onCancel, className }: { value: string; onSave: (name: string) => void; onCancel: () => void; className?: string }) {
  const [text, setText] = useState(value);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save && text.trim() && text.trim() !== value) onSave(text.trim());
    else onCancel();
  };
  return (
    <input
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
      className={cn('rounded-md border border-ac bg-sf px-2 text-t1 outline-none', className)}
    />
  );
}

export function DataTableView({ tableId }: { tableId: string }) {
  const router = useRouter();
  const [table, setTable] = useState<TableInfo>();
  const [missing, setMissing] = useState(false);
  const [page, setPage] = useState<RowPage>();
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(50);
  const [sort, setSort] = useState<Sort>();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<{ rowId: number; column: string }>();
  const [editNewRow, setEditNewRow] = useState<number>();
  const [renamingTable, setRenamingTable] = useState(false);
  const [renamingColumn, setRenamingColumn] = useState<string>();
  const [confirm, setConfirm] = useState<Confirm>();
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const latest = useRef(0);

  const loadTable = useCallback(
    () =>
      api<{ table: TableInfo }>(`/api/data-tables/${tableId}`)
        .then((r) => setTable(r.table))
        .catch((e: Error) => (e instanceof ApiError && e.status === 404 ? setMissing(true) : toast.error(e.message))),
    [tableId],
  );

  useEffect(() => {
    void loadTable();
  }, [loadTable]);

  useEffect(() => {
    const request = ++latest.current;
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    if (sort) {
      params.set('sortBy', sort.column);
      params.set('sortDirection', sort.direction);
    }
    if (query) params.set('search', query);
    setLoading(true);
    api<RowPage>(`/api/data-tables/${tableId}/rows?${params}`)
      .then((result) => {
        if (request !== latest.current) return;
        // Past the last page (after deleting rows): step back.
        if (!result.rows.length && result.total > 0 && offset > 0) return setOffset(Math.floor((result.total - 1) / limit) * limit);
        setPage(result);
      })
      .catch((e: Error) => request === latest.current && !(e instanceof ApiError && e.status === 404) && toast.error(e.message))
      .finally(() => request === latest.current && setLoading(false));
  }, [tableId, offset, limit, sort, query, reload]);

  // Search as you type, a moment after the last key.
  useEffect(() => {
    const next = search.trim();
    if (next === query) return;
    const timer = setTimeout(() => {
      setQuery(next);
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search, query]);

  useEffect(() => setSelected(new Set()), [offset, limit, sort, query]);

  // A row just added opens its first cell for editing once its page is loaded.
  useEffect(() => {
    if (editNewRow === undefined || !page?.rows.some((r) => r.id === editNewRow)) return;
    if (table?.columns[0]) setEditing({ rowId: editNewRow, column: table.columns[0].name });
    setEditNewRow(undefined);
  }, [page, editNewRow, table]);

  const refresh = () => {
    setReload((n) => n + 1);
    void loadTable();
  };

  const columns = table?.columns ?? [];
  const rows = page?.rows ?? [];
  const total = page?.total ?? 0;

  const saveCell = async (row: DataTableRow, column: DataTableColumn, value: unknown) => {
    try {
      const { row: saved } = await api<{ row: DataTableRow }>(`/api/data-tables/${tableId}/rows/${row.id}`, { method: 'PATCH', json: { values: { [column.name]: value } } });
      setPage((p) => p && { ...p, rows: p.rows.map((r) => (r.id === saved.id ? saved : r)) });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const commitCell = (row: DataTableRow, column: DataTableColumn, value: unknown, move?: 1 | -1) => {
    const index = columns.findIndex((c) => c.name === column.name);
    const next = move ? columns[index + move] : undefined;
    setEditing(next ? { rowId: row.id, column: next.name } : undefined);
    if (value !== undefined) void saveCell(row, column, value);
  };

  const addRow = async () => {
    try {
      const { rows: added } = await api<{ rows: DataTableRow[] }>(`/api/data-tables/${tableId}/rows`, { method: 'POST', json: { rows: [{}] } });
      setSearch('');
      setQuery('');
      setSort(undefined);
      // Rows are in id order without a sort, so the new row is the last of the whole (unfiltered) table.
      setOffset(Math.floor((table?.rowCount ?? total) / limit) * limit);
      setEditNewRow(added[0].id);
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const addColumn = async (name: string, type: ColumnType) => {
    try {
      const { table: next } = await api<{ table: DataTable }>(`/api/data-tables/${tableId}/columns`, { method: 'POST', json: { name, type } });
      setTable((t) => t && { ...t, ...next });
      toast.success(`Added column ${name}`);
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }
  };

  const renameColumn = async (from: string, to: string) => {
    setRenamingColumn(undefined);
    try {
      const { table: next } = await api<{ table: DataTable }>(`/api/data-tables/${tableId}/columns/${encodeURIComponent(from)}`, { method: 'PATCH', json: { name: to } });
      setTable((t) => t && { ...t, ...next });
      if (sort?.column === from) setSort({ ...sort, column: to });
      setReload((n) => n + 1);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const renameTable = async (name: string) => {
    setRenamingTable(false);
    try {
      const { table: next } = await api<{ table: DataTable }>(`/api/data-tables/${tableId}`, { method: 'PATCH', json: { name } });
      setTable((t) => t && { ...t, ...next });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const runConfirmed = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === 'rows') {
        const { deleted } = await api<{ deleted: number }>(`/api/data-tables/${tableId}/rows`, { method: 'DELETE', json: { ids: [...selected] } });
        toast.success(`Deleted ${plural(deleted, 'row')}`);
        setSelected(new Set());
        refresh();
      } else if (confirm.kind === 'column') {
        const { table: next } = await api<{ table: DataTable }>(`/api/data-tables/${tableId}/columns/${encodeURIComponent(confirm.name)}`, { method: 'DELETE' });
        setTable((t) => t && { ...t, ...next });
        if (sort?.column === confirm.name) setSort(undefined);
        toast.success(`Deleted column ${confirm.name}`);
        setReload((n) => n + 1);
      } else {
        await api(`/api/data-tables/${tableId}`, { method: 'DELETE' });
        toast.success(`Deleted ${table?.name ?? 'the table'}`);
        router.push('/data-tables');
      }
      setConfirm(undefined);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const importCsv = async (file: File) => {
    setBusy(true);
    try {
      const result = await api<CsvImportResult>(`/api/data-tables/${tableId}/import`, { method: 'POST', body: await file.text(), headers: { 'content-type': 'text/csv' } });
      const added = result.columnsAdded.length ? ` and ${plural(result.columnsAdded.length, 'new column')}` : '';
      toast.success(`Imported ${plural(result.inserted, 'row')}${added}`, result.skipped.length ? { description: `Skipped: ${result.skipped.join(', ')}` } : undefined);
      refresh();
    } catch (e) {
      toast.error(`Import failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const toggleSort = (column: string) =>
    setSort((current) => (current?.column !== column ? { column, direction: 'asc' } : current.direction === 'asc' ? { column, direction: 'desc' } : undefined));

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  const toggleRow = (id: number) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (missing) {
    return (
      <>
        <PageHeader title="Data table" />
        <EmptyState
          title="This data table doesn’t exist"
          hint="It may have been deleted."
          action={
            <Button onClick={() => router.push('/data-tables')}>
              <ChevronLeft className="size-3.5" /> All data tables
            </Button>
          }
        />
      </>
    );
  }

  const sortIcon = (column: string) =>
    sort?.column === column ? sort.direction === 'asc' ? <ArrowUp className="size-3 shrink-0 text-t1" /> : <ArrowDown className="size-3 shrink-0 text-t1" /> : null;
  const header = (name: string, label: string, type: ColumnType, extra?: string) => (
    <th key={name} scope="col" className={cn('group border-b border-r border-hair bg-sf2 px-2.5 py-0 text-left font-semibold last:border-r-0', extra)}>
      <button onClick={() => toggleSort(name)} className="flex h-9 w-full min-w-0 items-center gap-1.5 text-[12px] text-t2 hover:text-t1" title={`Sort by ${label}`}>
        <TypeIcon type={type} className="size-3.5 shrink-0 text-t3" />
        <span className="truncate">{label}</span>
        {sortIcon(name)}
      </button>
    </th>
  );
  const from = total ? offset + 1 : 0;
  const to = Math.min(offset + limit, total);

  return (
    <div className="flex min-h-screen flex-col">
      <PageHeader
        title={
          <span className="flex min-w-0 items-center gap-1.5">
            <Link href="/data-tables" className="text-t3 transition-colors hover:text-t1">
              Data tables
            </Link>
            <span className="text-t3">/</span>
            {renamingTable && table ? (
              <InlineRename value={table.name} onSave={renameTable} onCancel={() => setRenamingTable(false)} className="h-7 w-64 text-[15px] font-semibold" />
            ) : (
              <button onClick={() => table && setRenamingTable(true)} className="truncate rounded-md px-1 hover:bg-acdim" title="Rename table">
                {table?.name ?? '…'}
              </button>
            )}
          </span>
        }
        meta={table && <span>{plural(table.rowCount, 'row')} · {plural(table.columns.length, 'column')} · updated {timeAgo(table.updatedAt)}</span>}
        actions={
          <>
            <input ref={fileInput} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && void importCsv(e.target.files[0])} />
            <Button size="sm" onClick={() => fileInput.current?.click()} disabled={busy} title="Append rows from a CSV whose first line names the columns">
              <Upload className="size-3.5" /> Import CSV
            </Button>
            <a href={`/api/data-tables/${tableId}/export`} download className="inline-flex h-7 items-center gap-1.5 rounded-full border border-bd px-[11px] text-[12px] font-semibold text-t1 transition-colors hover:border-ac hover:text-ac">
              <Download className="size-3.5" /> Export CSV
            </a>
            <Popover
              trigger={({ toggle }) => (
                <Button size="icon-sm" variant="ghost" onClick={toggle} aria-label="More actions">
                  <Ellipsis className="size-4" />
                </Button>
              )}
            >
              {(close) => (
                <>
                  <MenuItem
                    onClick={() => {
                      setRenamingTable(true);
                      close();
                    }}
                  >
                    <Pencil /> Rename table
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    danger
                    onClick={() => {
                      setConfirm({ kind: 'table' });
                      close();
                    }}
                  >
                    <Trash2 /> Delete table
                  </MenuItem>
                </>
              )}
            </Popover>
          </>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-t3" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search rows" className="h-8 pl-8 pr-8" aria-label="Search rows" />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-full text-t3 hover:text-t1" aria-label="Clear search">
                <X className="size-3" />
              </button>
            )}
          </div>
          {loading && <Loader2 className="size-3.5 animate-spin text-t3" />}
          {selected.size > 0 && (
            <div className="flex items-center gap-2 animate-fade-up">
              <span className="text-[12px] text-t2">{plural(selected.size, 'row')} selected</span>
              <Button size="sm" variant="danger" onClick={() => setConfirm({ kind: 'rows' })}>
                <Trash2 className="size-3.5" /> Delete
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            <AddColumn onAdd={addColumn} />
            <Button size="sm" variant="primary" onClick={addRow} disabled={!table}>
              <Plus className="size-3.5" /> Add row
            </Button>
          </div>
        </div>

        <div className="max-h-[calc(100vh-190px)] min-h-[220px] overflow-auto rounded-2xl border border-hair bg-sf">
          <table className="w-full border-separate border-spacing-0 text-[13px]" style={{ minWidth: 120 + columns.length * 180 + 150 }}>
            <thead className="sticky top-0 z-10">
              <tr>
                <th scope="col" className="w-10 border-b border-r border-hair bg-sf2 px-2.5">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all rows on this page" className="size-3.5 accent-[var(--ac2)]" />
                </th>
                {header('id', 'id', 'number', 'w-[72px]')}
                {columns.map((column) =>
                  renamingColumn === column.name ? (
                    <th key={column.name} className="border-b border-r border-hair bg-sf2 px-1.5">
                      <InlineRename value={column.name} onSave={(name) => void renameColumn(column.name, name)} onCancel={() => setRenamingColumn(undefined)} className="h-7 w-full font-mono text-[12px]" />
                    </th>
                  ) : (
                    <th key={column.name} scope="col" className="group border-b border-r border-hair bg-sf2 px-2.5 py-0 text-left font-semibold">
                      <div className="flex items-center gap-1">
                        <button onClick={() => toggleSort(column.name)} className="flex h-9 min-w-0 flex-1 items-center gap-1.5 text-[12px] text-t2 hover:text-t1" title={`${TYPE_META[column.type].label} · sort by ${column.name}`}>
                          <TypeIcon type={column.type} className="size-3.5 shrink-0 text-t3" />
                          <span className="truncate">{column.name}</span>
                          {sortIcon(column.name)}
                        </button>
                        <Popover
                          trigger={({ toggle, open }) => (
                            <button onClick={toggle} aria-label={`${column.name} column menu`} className={cn('grid size-6 shrink-0 place-items-center rounded-md text-t3 transition hover:bg-acdim hover:text-t1', open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100')}>
                              <Ellipsis className="size-3.5" />
                            </button>
                          )}
                        >
                          {(close) => (
                            <>
                              <MenuItem
                                onClick={() => {
                                  setSort({ column: column.name, direction: 'asc' });
                                  close();
                                }}
                              >
                                <ArrowUp /> Sort ascending
                              </MenuItem>
                              <MenuItem
                                onClick={() => {
                                  setSort({ column: column.name, direction: 'desc' });
                                  close();
                                }}
                              >
                                <ArrowDown /> Sort descending
                              </MenuItem>
                              <MenuSeparator />
                              <MenuItem
                                onClick={() => {
                                  setRenamingColumn(column.name);
                                  close();
                                }}
                              >
                                <Pencil /> Rename column
                              </MenuItem>
                              <MenuItem
                                danger
                                onClick={() => {
                                  setConfirm({ kind: 'column', name: column.name });
                                  close();
                                }}
                              >
                                <Trash2 /> Delete column
                              </MenuItem>
                            </>
                          )}
                        </Popover>
                      </div>
                    </th>
                  ),
                )}
                {header('updatedAt', 'Updated', 'date', 'w-[150px]')}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className={cn('group/row', selected.has(row.id) ? 'bg-acdim' : 'hover:bg-sf2')}>
                  <td className="border-b border-r border-hair px-2.5">
                    <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggleRow(row.id)} aria-label={`Select row ${row.id}`} className="size-3.5 accent-[var(--ac2)]" />
                  </td>
                  <td className="border-b border-r border-hair px-2.5 font-mono text-[12px] text-t3">{row.id}</td>
                  {columns.map((column) => {
                    const value = row[column.name];
                    const isEditing = editing?.rowId === row.id && editing.column === column.name;
                    if (column.type === 'boolean') {
                      return (
                        <td key={column.name} className="h-9 border-b border-r border-hair px-2.5">
                          <input
                            type="checkbox"
                            checked={value === true}
                            ref={(el) => {
                              if (el) el.indeterminate = value === null || value === undefined;
                            }}
                            onChange={() => void saveCell(row, column, value !== true)}
                            aria-label={`${column.name} of row ${row.id}`}
                            title={value === null || value === undefined ? 'Empty — click to set' : String(value)}
                            className="size-3.5 accent-[var(--ac2)]"
                          />
                        </td>
                      );
                    }
                    return (
                      <td key={column.name} className={cn('h-9 max-w-0 border-b border-r border-hair', isEditing ? 'px-0.5' : 'cursor-text px-2.5')} onClick={() => !isEditing && setEditing({ rowId: row.id, column: column.name })}>
                        {isEditing ? (
                          <CellEditor column={column} value={value} onCommit={(next, move) => commitCell(row, column, next, move)} onCancel={() => setEditing(undefined)} />
                        ) : (
                          <div className={cn('truncate', column.type === 'number' && 'text-right font-mono text-[12px]', column.type === 'date' && 'tabular-nums')} title={value === null || value === undefined ? undefined : String(value)}>
                            {formatCell(value, column.type) || <span className="text-t3 opacity-0 group-hover/row:opacity-60">empty</span>}
                          </div>
                        )}
                      </td>
                    );
                  })}
                  <td className="border-b border-hair px-2.5 text-[12px] text-t3" title={row.updatedAt}>
                    {timeAgo(row.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {page && !rows.length && (
            <EmptyState
              compact
              className="py-12"
              title={query ? 'No row matches your search' : columns.length ? 'No rows yet' : 'Add a column to start'}
              hint={
                query
                  ? 'Search looks at the id and every column.'
                  : columns.length
                    ? 'Add a row here, import a CSV, or let a workflow insert rows with the Data Table node.'
                    : 'Columns have a name and a type: string, number, boolean or date.'
              }
              action={
                !query && columns.length ? (
                  <Button size="sm" variant="primary" onClick={addRow}>
                    <Plus className="size-3.5" /> Add row
                  </Button>
                ) : undefined
              }
            />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-[12px] text-t2">
          <span className="tabular-nums">
            {total ? `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}` : '0 rows'}
            {query && table && total !== table.rowCount && <span className="text-t3"> (filtered from {table.rowCount.toLocaleString()})</span>}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-t3">Rows per page</span>
            <div className="w-20">
              <Select
                value={limit}
                onChange={(e) => {
                  setLimit(Number(e.target.value));
                  setOffset(0);
                }}
                className="h-7 text-[12px]"
                aria-label="Rows per page"
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </Select>
            </div>
            <Button size="icon-sm" variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))} aria-label="Previous page">
              <ChevronLeft className="size-4" />
            </Button>
            <span className="tabular-nums text-t3">
              {Math.floor(offset / limit) + 1} / {Math.max(1, Math.ceil(total / limit))}
            </span>
            <Button size="icon-sm" variant="ghost" disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)} aria-label="Next page">
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      {confirm && (
        <ConfirmDialog
          title={confirm.kind === 'rows' ? `Delete ${plural(selected.size, 'row')}?` : confirm.kind === 'column' ? `Delete column ${confirm.name}?` : `Delete ${table?.name ?? 'this table'}?`}
          message={
            confirm.kind === 'rows'
              ? 'The selected rows are deleted for good.'
              : confirm.kind === 'column'
                ? `Its values in all ${plural(table?.rowCount ?? 0, 'row')} are deleted. Workflows that use the column will fail until you update them.`
                : `The table and its ${plural(table?.rowCount ?? 0, 'row')} are deleted for good. Data Table nodes that use it will fail.`
          }
          busy={busy}
          onConfirm={runConfirmed}
          onClose={() => setConfirm(undefined)}
        />
      )}
    </div>
  );
}
