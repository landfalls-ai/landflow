'use client';
/** Dialogs of the workflows list: name a folder (create / rename) and move a workflow to a folder. */
import { useMemo, useState } from 'react';
import { Folder as FolderIcon, FolderInput, FolderPlus, Home } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Folder } from '@/lib/shared/types';
import { Dialog } from '../agents/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/inputs';

/** Folders as a tree, depth-first and sorted by name: [{ folder, depth }]. */
export function folderTree(folders: Folder[]): Array<{ folder: Folder; depth: number }> {
  const out: Array<{ folder: Folder; depth: number }> = [];
  const known = new Set(folders.map((f) => f.id));
  const visit = (parentId: string | undefined, depth: number) => {
    for (const folder of folders.filter((f) => (f.parentId && known.has(f.parentId) ? f.parentId : undefined) === parentId).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({ folder, depth });
      visit(folder.id, depth + 1);
    }
  };
  visit(undefined, 0);
  return out;
}

export function FolderNameDialog({
  title,
  initial = '',
  confirm,
  onSubmit,
  onClose,
}: {
  title: string;
  initial?: string;
  confirm: string;
  onSubmit: (name: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const ok = await onSubmit(name.trim());
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Dialog
      title={title}
      icon={<FolderPlus className="size-5 text-t2" />}
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!name.trim()}>
            {confirm}
          </Button>
        </>
      }
    >
      <Input
        autoFocus
        value={name}
        maxLength={120}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void submit()}
        placeholder="Folder name"
        aria-label="Folder name"
      />
    </Dialog>
  );
}

export function MoveDialog({
  name,
  folders,
  current,
  onMove,
  onClose,
}: {
  name: string;
  folders: Folder[];
  current?: string;
  onMove: (folderId: string | null) => Promise<boolean>;
  onClose: () => void;
}) {
  const [target, setTarget] = useState<string | null>(current ?? null);
  const [busy, setBusy] = useState(false);
  const tree = useMemo(() => folderTree(folders), [folders]);
  const move = async () => {
    setBusy(true);
    const ok = await onMove(target);
    setBusy(false);
    if (ok) onClose();
  };
  const row = (id: string | null, label: string, depth: number, icon: React.ReactNode) => (
    <button
      key={id ?? 'root'}
      role="radio"
      aria-checked={target === id}
      onClick={() => setTarget(id)}
      onDoubleClick={() => {
        setTarget(id);
        void onMove(id).then((ok) => ok && onClose());
      }}
      className={cn('flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 text-left text-[13px] transition-colors', target === id ? 'bg-acdim font-semibold text-t1' : 'text-t2 hover:bg-acdim')}
      style={{ paddingLeft: 10 + depth * 18 }}
    >
      {icon}
      <span className="truncate">{label}</span>
      {(current ?? null) === id && <span className="ml-auto shrink-0 text-[11px] font-normal text-t3">current</span>}
    </button>
  );
  return (
    <Dialog
      title={`Move “${name}”`}
      icon={<FolderInput className="size-5 text-t2" />}
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void move()} loading={busy} disabled={(current ?? null) === target}>
            Move
          </Button>
        </>
      }
    >
      <div role="radiogroup" aria-label="Destination folder" className="max-h-[360px] space-y-0.5 overflow-y-auto">
        {row(null, 'Top level', 0, <Home className="size-3.5 shrink-0 text-t3" />)}
        {tree.map(({ folder, depth }) => row(folder.id, folder.name, depth + 1, <FolderIcon className="size-3.5 shrink-0 text-t3" />))}
        {!folders.length && <p className="px-2.5 py-2 text-[12px] text-t3">No folders yet. Create one with “New folder”.</p>}
      </div>
    </Dialog>
  );
}
