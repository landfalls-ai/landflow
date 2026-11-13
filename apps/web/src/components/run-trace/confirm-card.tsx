'use client';
/**
 * An Ask a Person node's request (lib/server/nodes/confirm.ts) in the Run Trace's Needs you: "Waiting for <person>:
 * <title>", the draft, a box to change it when the node allows editing, a comment, and Approve / Reject. The answer goes to
 * POST /api/executions/:id/approvals; the run continues with it.
 */
import { useState } from 'react';
import { Check, Hourglass, Pencil, X } from 'lucide-react';
import { toast } from 'sonner';
import { decideConfirm } from '@/lib/client/run-trace';
import { Button } from '../ui/button';
import { Textarea } from '../ui/inputs';
import { Card, clock } from './parts';

export interface ConfirmRequest {
  title: string;
  text: string;
  allowEdit: boolean;
  approvers?: string[];
}

export const isConfirm = (value: unknown): value is ConfirmRequest => Boolean(value) && typeof value === 'object' && typeof (value as ConfirmRequest).title === 'string' && typeof (value as ConfirmRequest).text === 'string';

export function ConfirmCard({ executionId, request, nodeName, since, onDecided, open }: { executionId: string; request: ConfirmRequest; nodeName: string; since: string; onDecided: () => void; open?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(request.text);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject'>();
  const who = request.approvers?.length ? request.approvers.join(', ') : 'a person';
  const changed = editing && text !== request.text;

  const send = async (approved: boolean) => {
    if (approved && editing && !text.trim()) return toast.error('The text can’t be empty');
    setBusy(approved ? 'approve' : 'reject');
    try {
      await decideConfirm(executionId, { approved, ...(approved && changed && { text }), ...(comment.trim() && { comment: comment.trim() }) });
      toast.success(approved ? (changed ? 'Approved with your changes' : 'Approved') : 'Rejected');
      onDecided();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Card tone="warn" className="bg-warndim">
      <div data-testid="confirm-card" className="flex flex-col gap-2">
        <div className="flex items-start gap-2 text-[13px] text-t1">
          <Hourglass className="mt-0.5 size-3.5 shrink-0 text-warn" />
          <div className="min-w-0">
            <b data-testid="confirm-title">{request.approvers?.length ? `Waiting for ${who}` : 'Needs you'} · {request.title}</b>
            <span className="text-t2"> · {nodeName} · since {clock(since)}</span>
          </div>
          {open && (
            <button type="button" onClick={open} className="ml-auto shrink-0 text-[12px] font-semibold text-ac hover:underline max-md:min-h-11">
              Details
            </button>
          )}
        </div>
        {editing ? (
          <Textarea aria-label="Text" rows={Math.min(14, Math.max(4, text.split('\n').length + 1))} value={text} onChange={(e) => setText(e.target.value)} data-testid="confirm-editor" />
        ) : (
          <blockquote className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl border border-warnbd/70 bg-sf px-3 py-2 text-[13px] leading-5 text-t1" data-testid="confirm-text">
            {request.text}
          </blockquote>
        )}
        <Textarea aria-label="Comment" rows={1} placeholder="Add a comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={busy === 'approve'} disabled={Boolean(busy)} onClick={() => send(true)} data-testid="confirm-approve">
            <Check className="size-3.5" strokeWidth={3} /> {changed ? 'Approve with these changes' : 'Approve'}
          </Button>
          {request.allowEdit && !editing && (
            <Button variant="outline" disabled={Boolean(busy)} onClick={() => setEditing(true)} data-testid="confirm-edit">
              <Pencil className="size-3.5" /> Edit
            </Button>
          )}
          {editing && (
            <Button
              variant="ghost"
              disabled={Boolean(busy)}
              onClick={() => {
                setEditing(false);
                setText(request.text);
              }}
            >
              Cancel
            </Button>
          )}
          <Button variant="danger" loading={busy === 'reject'} disabled={Boolean(busy)} onClick={() => send(false)} data-testid="confirm-reject">
            <X className="size-3.5" /> Reject
          </Button>
        </div>
      </div>
    </Card>
  );
}
