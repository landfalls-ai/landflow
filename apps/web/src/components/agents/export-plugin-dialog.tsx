'use client';
/**
 * "Export as Claude Code plugin" (docs/marketplace.md#export-agents-as-plugins): lists the files the zip will hold as a
 * tree, then downloads it. `base` is `/api/agents/<id>` or `/api/agent-teams/<id>`; the server writes the plugin.
 */
import { useEffect, useMemo, useState } from 'react';
import { Download, File, Folder, Package } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { Dialog } from './dialog';

interface Preview {
  name: string;
  files: Array<{ path: string; bytes: number }>;
}

interface Row {
  key: string;
  depth: number;
  name: string;
  bytes?: number;
}

/** The files as indented rows, folders first at each level. */
export function treeRows(files: Preview['files']): Row[] {
  const rows: Row[] = [];
  const walk = (entries: Preview['files'], prefix: string, depth: number) => {
    const folders = [...new Set(entries.filter((f) => f.path.includes('/')).map((f) => f.path.slice(0, f.path.indexOf('/'))))].sort();
    for (const folder of folders) {
      rows.push({ key: `${prefix}${folder}/`, depth, name: `${folder}/` });
      walk(
        entries.filter((f) => f.path.startsWith(`${folder}/`)).map((f) => ({ ...f, path: f.path.slice(folder.length + 1) })),
        `${prefix}${folder}/`,
        depth + 1,
      );
    }
    for (const file of entries.filter((f) => !f.path.includes('/')).sort((a, b) => a.path.localeCompare(b.path))) rows.push({ key: `${prefix}${file.path}`, depth, name: file.path, bytes: file.bytes });
  };
  walk(files, '', 0);
  return rows;
}

const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

export function ExportPluginDialog({ base, title, onClose }: { base: string; title: string; onClose: () => void }) {
  const [marketplace, setMarketplace] = useState(true);
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const query = `format=claude-plugin${marketplace ? '&marketplace=1' : ''}`;

  useEffect(() => {
    setPreview(undefined);
    fetch(`${base}/export?${query}&preview=1`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `${response.status} ${response.statusText}`);
        setPreview((await response.json()) as Preview);
      })
      .catch((e: Error) => setError(e.message));
  }, [base, query]);

  const rows = useMemo(() => (preview ? treeRows(preview.files) : []), [preview]);

  const download = async () => {
    setBusy(true);
    try {
      const response = await fetch(`${base}/export?${query}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `${response.status} ${response.statusText}`);
      const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'plugin.zip';
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
      title="Export as Claude Code plugin"
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
          A plugin folder Claude Code installs as it is. What only Landflow uses (persona parts, tools, avatar, model provider
          {base.includes('agent-teams') ? ', who reports to whom' : ''}) goes in <code className="font-mono">.landflow/</code>, which Claude Code ignores; installing the plugin in Landflow brings it back. Credentials, schedules and channels are left out.
        </p>
        <label className="flex items-center gap-2 text-[13px] text-t1">
          <input type="checkbox" checked={marketplace} onChange={(e) => setMarketplace(e.target.checked)} />
          Include <code className="font-mono text-[12px]">marketplace.json</code> (publish the folder as a one-plugin marketplace)
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
