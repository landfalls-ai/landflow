'use client';
/**
 * "Export project" (docs/marketplace.md#export-a-project): the files of the Claude Code plugin a project becomes
 * (PROJECT.md, its home agents and their skills), listed as a tree from `?preview=1`, then the zip. On a phone the
 * shared dialog is a bottom sheet.
 */
import { useEffect, useMemo, useState } from 'react';
import { Download, File, Folder, Package } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { treeRows } from '../agents/export-plugin-dialog';

interface Preview {
  name: string;
  files: Array<{ path: string; bytes: number }>;
}

const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

export function ExportProjectDialog({ projectId, title, onClose }: { projectId: string; title: string; onClose: () => void }) {
  const [marketplace, setMarketplace] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const base = `/api/projects/${encodeURIComponent(projectId)}/export`;
  const query = `format=claude-plugin${marketplace ? '&marketplace=1' : ''}`;

  useEffect(() => {
    setPreview(undefined);
    setError(undefined);
    let stale = false;
    fetch(`${base}?${query}&preview=1`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `${response.status} ${response.statusText}`);
        const next = (await response.json()) as Preview;
        if (!stale) setPreview(next);
      })
      .catch((e: Error) => {
        if (!stale) setError(e.message);
      });
    return () => {
      stale = true;
    };
  }, [base, query]);

  const rows = useMemo(() => (preview ? treeRows(preview.files) : []), [preview]);

  const download = async () => {
    setBusy(true);
    try {
      const response = await fetch(`${base}?${query}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `${response.status} ${response.statusText}`);
      const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'project.zip';
      const url = URL.createObjectURL(await response.blob());
      const link = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success(`Downloaded ${name}`);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Export project"
      subtitle={title}
      icon={<Package className="size-5 text-t2" />}
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" loading={busy} disabled={!preview} onClick={() => void download()}>
            <Download className="size-3.5" /> Download {preview ? `${preview.name}.zip` : 'zip'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[12px] leading-snug text-t2">
          A Claude Code plugin: <code className="font-mono">PROJECT.md</code> with the brief and the goals, next to the agents whose home is this project and their skills. People, ids, settings, the workspace and secrets are not included.
        </p>
        <label className="flex items-center gap-2 text-[13px] text-t1">
          <input type="checkbox" checked={marketplace} onChange={(e) => setMarketplace(e.target.checked)} />
          As a one-plugin marketplace
        </label>
        {error ? (
          <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>
        ) : !preview ? (
          <div className="h-[140px] animate-pulse-soft rounded-[10px] border border-hair bg-wl" />
        ) : (
          <ul aria-label="Files in the plugin" className="max-h-[300px] overflow-auto rounded-[10px] border border-hair bg-wl py-1.5 font-mono text-[12px]">
            <li className="flex items-center gap-1.5 px-3 py-0.5 font-semibold text-t1">
              <Folder className="size-3.5 text-t3" /> {preview.name}/
            </li>
            {rows.map((row) => (
              <li key={row.key} className="flex items-center gap-1.5 px-3 py-0.5 text-t2" style={{ paddingLeft: 12 + (row.depth + 1) * 16 }}>
                {row.bytes === undefined ? <Folder className="size-3.5 shrink-0 text-t3" /> : <File className="size-3.5 shrink-0 text-t3" />}
                <span className="min-w-0 flex-1 truncate">{row.name}</span>
                {row.bytes !== undefined && <span className="shrink-0 text-[11px] text-t3">{size(row.bytes)}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

/** The header's "Export" (an icon on a phone): opens the dialog. */
export function ExportProjectButton({ project }: { project: { id: string; name: string } }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" aria-label="Export project" onClick={() => setOpen(true)}>
        <Download className="size-3.5" />
        <span className="max-md:hidden">Export</span>
      </Button>
      {open && <ExportProjectDialog projectId={project.id} title={project.name} onClose={() => setOpen(false)} />}
    </>
  );
}
