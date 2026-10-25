'use client';
/**
 * Four-eyes publish requests (Settings → Governance, the editor's publish menu): what a request would change, who
 * asked and when, and Approve / Reject for someone else allowed to, Withdraw for the requester. `usePublishRequests`
 * loads them (pending by default) and refreshes after each decision.
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, Undo2, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { PublishRequestList, PublishRequestStatus, PublishRequestView } from '@/lib/shared/governance';
import { Badge, type Tone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/inputs';

const STATUS_TONE: Record<PublishRequestStatus, Tone> = { pending: 'warning', approved: 'success', rejected: 'danger', canceled: 'muted', stale: 'neutral', failed: 'danger' };
const KIND_LABEL = { publish: 'Publish', rollback: 'Roll back', unpublish: 'Unpublish' } as const;

/** "Publish v4 (live: v3)" */
export function requestTitle(request: PublishRequestView): string {
  const version = request.versionNumber ? ` v${request.versionNumber}` : '';
  const base = request.baseVersionNumber ? ` (live: v${request.baseVersionNumber})` : request.kind !== 'unpublish' ? ' (nothing live yet)' : '';
  return `${KIND_LABEL[request.kind]}${version}${base}`;
}

export function usePublishRequests(params: { workflowId?: string; status?: string } = {}) {
  const [list, setList] = useState<PublishRequestList>();
  const search = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  const reload = useCallback(async () => {
    try {
      setList(await api<PublishRequestList>(`/api/publish-requests${search ? `?${search}` : ''}`));
    } catch {
      // Not allowed to read workflows, or the host is older: no requests to show.
      setList(undefined);
    }
  }, [search]);
  useEffect(() => void reload(), [reload]);
  return { list, reload };
}

export function PublishRequestCard({ request, onChanged, showWorkflow, className }: { request: PublishRequestView; onChanged: () => void; showWorkflow?: boolean; className?: string }) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | 'cancel'>();

  const decide = async (what: 'approve' | 'reject' | 'cancel') => {
    setBusy(what);
    try {
      await api(`/api/publish-requests/${request.id}/${what}`, { method: 'POST', json: what === 'cancel' ? {} : { ...(comment.trim() && { comment: comment.trim() }) } });
      toast.success(what === 'approve' ? (request.kind === 'unpublish' ? `Approved: ${request.workflowName} is unpublished` : `Approved: ${request.workflowName} is live`) : what === 'reject' ? 'Rejected' : 'Request withdrawn');
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
      onChanged();
    } finally {
      setBusy(undefined);
    }
  };

  const diff = request.diff;
  return (
    <div className={cn('space-y-1.5 px-4 py-3', className)}>
      <div className="flex flex-wrap items-center gap-2">
        {showWorkflow && (
          <a href={`/workflows/${request.workflowId}`} className="truncate text-[13px] font-semibold text-t1 hover:text-ac">
            {request.workflowName}
          </a>
        )}
        <span className={cn('text-[12px]', showWorkflow ? 'text-t2' : 'font-semibold text-t1')}>{requestTitle(request)}</span>
        <Badge tone={STATUS_TONE[request.status]}>{request.status}</Badge>
      </div>
      <div className="text-[12px] text-t3">
        Asked by {request.requestedByName ?? request.requestedBy} {timeAgo(request.requestedAt)}
        {request.decidedAt && ` · ${request.status} by ${request.decidedByName ?? request.decidedBy ?? 'Landflow'} ${timeAgo(request.decidedAt)}`}
      </div>
      {request.note && <div className="text-[12px] text-t1">“{request.note}”</div>}
      {diff && (
        <div className="text-[12px] text-t2" title={[...diff.nodesAdded.map((n) => `+ ${n}`), ...diff.nodesRemoved.map((n) => `− ${n}`), ...diff.nodesChanged.map((n) => `~ ${n}`)].join('\n')}>
          {diff.summary}
        </div>
      )}
      {request.comment && <div className="text-[12px] text-t2">Comment: {request.comment}</div>}
      {request.reason && request.status !== 'pending' && <div className="text-[12px] text-warn">{request.reason}</div>}
      {request.status === 'pending' && (request.canApprove || request.canCancel) && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {request.canApprove && (
            <>
              <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Comment (optional)" className="h-7 max-w-[220px] text-[12px]" aria-label="Comment" />
              <Button size="sm" variant="primary" onClick={() => void decide('approve')} loading={busy === 'approve'} disabled={Boolean(busy)}>
                <Check className="size-3.5" /> Approve
              </Button>
              <Button size="sm" variant="danger" onClick={() => void decide('reject')} loading={busy === 'reject'} disabled={Boolean(busy)}>
                <X className="size-3.5" /> Reject
              </Button>
            </>
          )}
          {request.canCancel && (
            <Button size="sm" variant="ghost" onClick={() => void decide('cancel')} loading={busy === 'cancel'} disabled={Boolean(busy)}>
              <Undo2 className="size-3.5" /> Withdraw
            </Button>
          )}
        </div>
      )}
      {request.status === 'pending' && !request.canApprove && !request.canCancel && <div className="text-[11px] text-t3">Waiting for another person to approve.</div>}
    </div>
  );
}
