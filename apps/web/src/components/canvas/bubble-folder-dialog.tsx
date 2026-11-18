'use client';
/** AG16: "Knowledge from a folder…": the folder (of the host's files directory) to index into a new knowledge base of the agent. */
import { useState } from 'react';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { Input } from '../ui/inputs';

export function FolderDialog({ agentName, onAdd, onClose }: { agentName: string; onAdd: (folder: string) => void; onClose: () => void }) {
  const [folder, setFolder] = useState('');
  const valid = folder.trim() !== '' && !folder.includes('..') && !folder.trim().startsWith('/');
  return (
    <Dialog
      title="Knowledge from a folder"
      subtitle={`A new knowledge base for ${agentName}, searched by keywords`}
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={!valid} onClick={() => onAdd(folder.trim())}>
            Add and index
          </Button>
        </>
      }
    >
      <label className="flex flex-col gap-1.5 text-[13px] text-t1">
        Folder, inside the files directory
        <Input autoFocus value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="runbooks" onKeyDown={(e) => e.key === 'Enter' && valid && onAdd(folder.trim())} />
      </label>
      <p className="mt-2 text-[12px] leading-snug text-t3">Markdown, text, PDF, DOCX, HTML, CSV and JSON files are indexed; the folder is not changed.</p>
    </Dialog>
  );
}
