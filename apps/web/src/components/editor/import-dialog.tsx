'use client';
/**
 * One Import dialog (the ⋯ menu's "Import…"): a paste box and a file drop in the same view, for a workflow file or pasted
 * JSON (Landflow, n8n or Flowise), into the open workflow. The server converts it (POST /api/workflows/import with
 * `create: false`); the nodes are added next to what is on the canvas, with
 * fresh ids and unique names, and the import report is shown.
 */
import { useRef, useState } from 'react';
import { FileUp, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import type { ImportReport, Workflow } from '@/lib/shared/types';
import { Dialog } from '../agents/dialog';
import { Button } from '../ui/button';
import { Textarea } from '../ui/inputs';
import { ImportReportView } from './import-report';
import { useEditor } from './store';

/** Read a picked or dropped file as text (workflow JSON files are small). */
export async function readJsonFile(file: File): Promise<string> {
  if (file.size > 5 * 1024 * 1024) throw new Error('The file is larger than 5 MB');
  return file.text();
}

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [report, setReport] = useState<ImportReport>();
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const run = async (source: string) => {
    setError(undefined);
    let data: unknown;
    try {
      data = JSON.parse(source);
    } catch (e) {
      setError(`That isn’t valid JSON: ${(e as Error).message}`);
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ workflow: Workflow; report: ImportReport }>('/api/workflows/import', { method: 'POST', json: { data, create: false } });
      const count = useEditor.getState().mergeWorkflow(result.workflow);
      setReport(result.report);
      toast.success(`Imported ${count} element${count === 1 ? '' : 's'} into this workflow`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pick = async (file?: File) => {
    if (!file) return;
    setFileName(file.name);
    try {
      await run(await readJsonFile(file));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (report) {
    return (
      <Dialog
        title="Import report"
        subtitle={fileName ?? 'Pasted JSON'}
        icon={<FileUp className="size-5 text-t2" />}
        onClose={onClose}
        width={620}
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <ImportReportView report={report} />
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Import into this workflow"
      subtitle="Landflow, n8n or Flowise workflow JSON. The nodes are added next to the ones already here."
      icon={<FileUp className="size-5 text-t2" />}
      onClose={onClose}
      width={600}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void run(text)} loading={busy} disabled={!text.trim()}>
            Import
          </Button>
        </>
      }
    >
      <div
        className="space-y-3"
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void pick(e.dataTransfer.files[0]);
        }}
      >
        <Textarea
          autoFocus
          rows={9}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Workflow JSON"
          placeholder={'Paste JSON here\n{ "nodes": [ … ], "connections": { … } }'}
          className="code-area min-h-[180px]"
        />
        <button
          type="button"
          onClick={() => picker.current?.click()}
          className={cn(
            'flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-4 py-4 text-center text-[13px] transition-colors',
            over ? 'border-ac bg-acdim' : 'border-bd hover:border-ac',
          )}
        >
          <Upload className="size-4 shrink-0 text-t3" strokeWidth={1.6} />
          <span className="font-semibold text-t1">{busy ? 'Importing…' : (fileName ?? 'Drop a .json file here, or choose one')}</span>
        </button>
        <input ref={picker} type="file" accept=".json,application/json" className="hidden" onChange={(e) => void pick(e.target.files?.[0] ?? undefined)} />
        {error && <div className="rounded-lg border border-rdbd bg-rddim px-3 py-2 text-[12px] text-rd [overflow-wrap:anywhere]">{error}</div>}
      </div>
    </Dialog>
  );
}
