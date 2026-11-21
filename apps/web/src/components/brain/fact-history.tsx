'use client';
/**
 * A fact's history and the dialog that forgets one (docs/second-brain.md#fact-versions, #forgetting-a-fact). The history is a
 * sheet listing every version of the fact, newest first, with when it changed and who or what wrote it; the dialog asks for a
 * reason (required) and, when the fact should only go later, a date. The Notebook tab uses the dialog for notes too.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/client/api';
import { stamp } from '@/lib/client/format';
import type { BrainFact } from '@/lib/shared/brain';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog, Field } from '../ui/dialog';
import { Input, Textarea } from '../ui/inputs';
import { Sheet } from '../ui/sheet';

const WHO: Record<string, string> = { person: 'A person', notion: 'Notion', landflow: 'Landflow' };
const RELATION: Record<string, string> = { updates: 'Updated', extends: 'Extends another fact', derives: 'Derived from another fact' };

/** Every version of a fact, newest first. */
export function FactHistory({ fact, onClose }: { fact: BrainFact; onClose: () => void }) {
  const [versions, setVersions] = useState<BrainFact[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api<{ versions: BrainFact[] }>(`/api/brain/facts/${encodeURIComponent(fact.id)}/versions`)
      .then((r) => setVersions([...r.versions].reverse()))
      .catch((e: Error) => setError(e.message));
  }, [fact.id]);
  return (
    <Sheet open onClose={onClose} title={`History of ${fact.subjectName ?? fact.subjectId}: ${fact.kind}`} className="md:max-w-[560px]">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 text-[13px]">
        {error && (
          <p role="alert" className="text-rd">
            {error}
          </p>
        )}
        {!versions && !error && <div className="h-[80px] animate-pulse-soft rounded-xl border border-hair bg-sf" />}
        <ol className="flex flex-col gap-3">
          {versions?.map((v, i) => (
            <li key={v.id} className="rounded-xl border border-hair px-3 py-2">
              <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[12px] text-t3">
                <Badge tone={i === 0 ? 'success' : 'muted'}>{i === 0 ? `Version ${v.version ?? 1}, now` : `Version ${v.version ?? 1}`}</Badge>
                {v.relation && v.relation !== 'updates' && <span>{RELATION[v.relation]}</span>}
                <span>{stamp(v.firstSeen)}</span>
                {v.writtenBy && <span>· {WHO[v.writtenBy.origin] ?? 'Landflow'}</span>}
              </div>
              {v.trimmed ? <p className="italic text-t3">The words were dropped to keep the history short.</p> : <p className="leading-snug text-t1 [overflow-wrap:anywhere]">{v.statement}</p>}
            </li>
          ))}
        </ol>
      </div>
    </Sheet>
  );
}

/**
 * Asks why something is forgotten (1 to 500 characters) and optionally when it should go instead of now. `onForget` throws
 * to show the error under the form (the route's words).
 */
export function ForgetDialog({ what, onClose, onForget, children }: { what: string; onClose: () => void; onForget: (reason: string, forgetAfter?: string) => Promise<void>; children?: ReactNode }) {
  const [reason, setReason] = useState('');
  const [after, setAfter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onForget(reason.trim(), after ? new Date(after).toISOString() : undefined);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Forget this?"
      subtitle={what}
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !reason.trim()} loading={busy} onClick={() => void submit()}>
            Forget
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {children}
        <Field id="forget-reason" label="Why" required hint="It stays in the audit log with your name. Agents never read it.">
          <Textarea id="forget-reason" rows={3} maxLength={500} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="It was a one-off, or it is wrong" />
        </Field>
        <Field id="forget-after" label="Forget after" hint="Leave empty to forget it now. You can restore it later.">
          <Input id="forget-after" type="datetime-local" value={after} onChange={(e) => setAfter(e.target.value)} />
        </Field>
        {error && (
          <p role="alert" className="rounded-[12px] border border-rdbd bg-rddim px-3 py-2 text-[12px] text-rd">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
