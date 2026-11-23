'use client';
/** New data table: a name, its columns, and optionally a CSV to start from (its header adds the missing columns). */
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileUp, Plus, Table2, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { COLUMN_NAME, COLUMN_TYPES, type ColumnType, type CsvImportResult, type DataTable } from '@/lib/shared/data-tables';
import { Button } from '../ui/button';
import { FieldLabel, Input, Select } from '../ui/inputs';
import { TYPE_META } from './column-type';
import { Dialog } from './dialog';

interface DraftColumn {
  key: number;
  name: string;
  type: ColumnType;
}

let nextKey = 1;
const blank = (): DraftColumn => ({ key: nextKey++, name: '', type: 'string' });

export function CreateTableDialog({ onClose, existingNames, projectId }: { onClose: () => void; existingNames: string[]; /** Create it in this project (default: the viewer's personal project). */ projectId?: string }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [columns, setColumns] = useState<DraftColumn[]>([blank()]);
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);

  const named = columns.filter((c) => c.name.trim());
  const columnProblem = named.find((c) => !COLUMN_NAME.test(c.name.trim()) || ['id', 'createdat', 'updatedat'].includes(c.name.trim().toLowerCase()));
  const duplicate = named.find((c, i) => named.findIndex((o) => o.name.trim().toLowerCase() === c.name.trim().toLowerCase()) !== i);
  const nameTaken = existingNames.some((n) => n.toLowerCase() === name.trim().toLowerCase());
  const problem = !name.trim()
    ? undefined
    : nameTaken
      ? 'A table with this name exists'
      : columnProblem
        ? `“${columnProblem.name}”: start with a letter, then letters, digits or _ (id, createdAt and updatedAt are built in)`
        : duplicate
          ? `Two columns are named “${duplicate.name}”`
          : undefined;

  const update = (key: number, change: Partial<DraftColumn>) => setColumns((list) => list.map((c) => (c.key === key ? { ...c, ...change } : c)));

  const create = async () => {
    if (!name.trim() || problem) return;
    setBusy(true);
    setError(undefined);
    try {
      const { table } = await api<{ table: DataTable }>(projectId ? `/api/data-tables?projectId=${encodeURIComponent(projectId)}` : '/api/data-tables', { method: 'POST', json: { name: name.trim(), columns: named.map((c) => ({ name: c.name.trim(), type: c.type })) } });
      if (file) {
        try {
          const result = await api<CsvImportResult>(`/api/data-tables/${table.id}/import`, { method: 'POST', body: await file.text(), headers: { 'content-type': 'text/csv' } });
          toast.success(`Created ${table.name} with ${result.inserted.toLocaleString()} rows`);
        } catch (e) {
          toast.error(`Created ${table.name}, but the CSV import failed: ${(e as Error).message}`);
        }
      } else toast.success(`Created ${table.name}`);
      router.push(`/data-tables/${table.id}`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="New data table"
      subtitle="Rows that workflows read and write with the Data Table node"
      icon={
        <span className="grid size-8 place-items-center rounded-lg border border-hair bg-sf2 text-t2">
          <Table2 className="size-4" strokeWidth={1.8} />
        </span>
      }
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={create} loading={busy} disabled={!name.trim() || Boolean(problem)}>
            Create table
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <FieldLabel>Name</FieldLabel>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} placeholder="Customers" maxLength={128} />
        </div>
        <div>
          <FieldLabel>Columns</FieldLabel>
          <div className="space-y-2">
            {columns.map((column) => (
              <div key={column.key} className="flex items-center gap-2">
                <Input value={column.name} onChange={(e) => update(column.key, { name: e.target.value })} placeholder="email" className="flex-1 font-mono" aria-label="Column name" />
                <div className="w-36">
                  <Select value={column.type} onChange={(e) => update(column.key, { type: e.target.value as ColumnType })} aria-label="Column type">
                    {COLUMN_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {TYPE_META[type].label}
                      </option>
                    ))}
                  </Select>
                </div>
                <Button size="icon" variant="ghost" onClick={() => setColumns((list) => (list.length > 1 ? list.filter((c) => c.key !== column.key) : [blank()]))} aria-label="Remove column">
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => setColumns((list) => [...list, blank()])}>
            <Plus className="size-3.5" /> Add column
          </Button>
          <p className="mt-1 text-[12px] text-t3">Every row also has id, createdAt and updatedAt. You can add, rename and delete columns later.</p>
        </div>
        <div className="rounded-xl border border-dashed border-bd px-3.5 py-3">
          <input ref={fileInput} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => setFile(e.target.files?.[0])} />
          {file ? (
            <div className="flex items-center gap-2 text-[13px]">
              <FileUp className="size-4 text-t3" />
              <span className="min-w-0 flex-1 truncate font-medium text-t1">{file.name}</span>
              <span className="text-[12px] text-t3">{(file.size / 1024).toFixed(1)} KB</span>
              <Button size="icon-sm" variant="ghost" onClick={() => setFile(undefined)} aria-label="Remove file">
                <X className="size-3.5" />
              </Button>
            </div>
          ) : (
            <button onClick={() => fileInput.current?.click()} className="flex w-full items-center gap-2 text-left text-[13px] text-t2 hover:text-ac">
              <FileUp className="size-4" /> Start from a CSV file <span className="text-[12px] text-t3">(optional; its header adds the missing columns)</span>
            </button>
          )}
        </div>
        {(problem || error) && <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd animate-fade-up">{error ?? problem}</div>}
      </div>
    </Dialog>
  );
}
