'use client';
/**
 * My requests: each one with its state word, what was asked, who decides, the reason of a denial or a failure, Cancel while it waits and
 * Give it back on a live grant. `RequestRows` is the list; `RequestsView` loads it.
 */
import { useState } from 'react';
import { Inbox } from 'lucide-react';
import { toast } from 'sonner';
import { accessApi, useLoaded } from '@/lib/client/access';
import { durationText, requestState, type AccessRequestView } from '@/lib/shared/access';
import { cn } from '@/lib/utils';
import { Card } from '../shell/page-header';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { StateBadge } from './state-badge';

/** "until 11:05" for a live grant, "no end" for an unlimited one. */
export function untilText(until: string | null | undefined): string {
  if (until === null) return 'no end';
  if (!until) return '';
  return `until ${new Date(until).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}

/** The sentence under a request's title: why it ended as it did, or what it waits for. */
function detail(request: AccessRequestView, state: ReturnType<typeof requestState>): string | undefined {
  if (state === 'denied') return request.decisions.find((d) => d.outcome === 'deny')?.comment || request.note || 'The approver said no.';
  if (state === 'failed') return request.grant?.lastError || request.note;
  if (state === 'waiting') return `Waiting for ${request.approverNames.length ? request.approverNames.join(', ') : 'an approver'}`;
  if (state === 'approved') return request.grant?.system === 'manual' ? 'Approved. Someone will set it up by hand.' : 'Approved.';
  if (state === 'granted') {
    const minutes = request.approvedMinutes === undefined ? request.durationMinutes : request.approvedMinutes;
    return minutes === null ? 'With no end' : `${durationText(minutes)}, ${untilText(request.grant?.until)}`;
  }
  if (state === 'expired' && request.grant) return 'Ended: the time was up';
  if (state === 'removed') return [request.grant?.endReason ? `Ended: ${request.grant.endReason.replace(/_/g, ' ')}` : '', request.note].filter(Boolean).join('. ') || undefined;
  return request.note;
}

export function RequestRows({ requests, viewerId, highlight, onCancel, onGiveBack, onRetry }: { requests: AccessRequestView[]; viewerId: string; highlight?: string; onCancel: (request: AccessRequestView) => void; onGiveBack: (request: AccessRequestView) => void; onRetry?: (request: AccessRequestView) => void }) {
  if (requests.length === 0) {
    return (
      <Card>
        <EmptyState icon={<Inbox />} title="No requests yet" hint="When you ask for access it shows here, with who has to say yes." />
      </Card>
    );
  }
  return (
    <ul className="flex max-w-[860px] flex-col gap-2" data-testid="access-requests">
      {requests.map((request) => {
        const state = requestState(request);
        const text = detail(request, state);
        const mine = request.requester.id === viewerId;
        return (
          <li key={request.id} id={`request-${request.id}`} className={cn('flex flex-wrap items-start gap-x-3 gap-y-2 rounded-2xl border bg-sf px-4 py-3', highlight && (highlight === request.id || highlight === request.grant?.id) ? 'border-ac' : 'border-hair')}>
            <div className="min-w-0 flex-1 basis-60">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-semibold text-t1">{request.entryName}</span>
                <StateBadge state={state} />
                <span className="text-[12px] text-t3">{durationText(request.durationMinutes)}</span>
              </div>
              {!mine && <p className="text-[12px] text-t3">{request.requester.name}</p>}
              <p className="mt-0.5 text-[13px] text-t2 [overflow-wrap:anywhere]">{request.reason}</p>
              {text && <p className={cn('mt-1 text-[13px] [overflow-wrap:anywhere]', state === 'failed' || state === 'denied' ? 'text-rd' : 'text-t2')}>{text}</p>}
            </div>
            <div className="flex shrink-0 gap-2 max-md:w-full">
              {request.canCancel && state === 'waiting' && <Button size="sm" variant="outline" onClick={() => onCancel(request)} className="max-md:h-11 max-md:flex-1">Cancel</Button>}
              {request.grant?.canRetry && onRetry && <Button size="sm" variant="outline" onClick={() => onRetry(request)} className="max-md:h-11 max-md:flex-1">Retry</Button>}
              {request.grant?.canRevoke && <Button size="sm" variant="outline" onClick={() => onGiveBack(request)} className="max-md:h-11 max-md:flex-1">Give it back</Button>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function RequestsView({ viewerId, highlight, tick }: { viewerId: string; highlight?: string; tick?: number }) {
  const { data, error, reload } = useLoaded(() => accessApi.requests('mine'), [tick]);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<unknown>, done: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
      toast.success(done);
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (error && !data) return <Card><EmptyState title="Requests not available" hint={error} /></Card>;
  if (!data) return <p className="text-[13px] text-t3">Loading…</p>;
  return (
    <RequestRows
      requests={data.items}
      viewerId={viewerId}
      highlight={highlight}
      onCancel={(r) => run(() => accessApi.cancel(r.id), 'Cancelled')}
      onGiveBack={(r) => r.grant && run(() => accessApi.grantAction(r.grant!.id, 'revoke'), 'Given back')}
      onRetry={(r) => r.grant && run(() => accessApi.grantAction(r.grant!.id, 'retry'), 'Tried again')}
    />
  );
}
