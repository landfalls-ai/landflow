'use client';
/** The Data Tables page's dialogs: the shared one (components/ui/dialog.tsx), and "Delete …?" for destructive actions. */
import type { ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';

export { Dialog };

/** "Delete …?" with a danger button. */
export function ConfirmDialog({ title, message, action = 'Delete', busy, onConfirm, onClose }: { title: string; message: ReactNode; action?: string; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={busy} autoFocus>
            <Trash2 className="size-3.5" /> {action}
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-relaxed text-t2">{message}</p>
    </Dialog>
  );
}
