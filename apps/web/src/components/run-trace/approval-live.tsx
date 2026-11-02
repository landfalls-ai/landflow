'use client';
/**
 * The approval card where the page has no Run Trace model of its own (the editor's waiting node, the execution view's phone
 * card): it reads the run's journal, finds the tool approval the member waits on and draws the same decision card as Needs you
 * (approval-card.tsx). New look only. `fallback` is drawn until the journal has the wait.
 */
import { useEffect, useMemo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useRunJournal } from '@/lib/client/run-trace';
import type { ApprovalWait } from '@/lib/shared/approval-case';
import { foldChanges } from '@/lib/shared/run-changes';
import { resolveRunProfile } from '@/lib/shared/run-profiles';
import { ApprovalCard, type ApprovalEdit } from './approval-card';

export type DecideFn = (approved: boolean, edit?: ApprovalEdit & { callId?: string }) => Promise<void>;

const same = (a: unknown, b: string | undefined) => typeof a === 'string' && Boolean(b) && a.trim().toLowerCase() === b!.trim().toLowerCase();

export function LiveApprovalCard({ executionId, member, onDecide, onDecided, fallback, className }: { executionId: string; member?: string; onDecide?: DecideFn; onDecided?: () => void; fallback?: ReactNode; className?: string }) {
  const { events, model, refresh } = useRunJournal(executionId);
  const changes = useMemo(() => foldChanges(events), [events]);
  const waits = model.needsYou.filter((n): n is ApprovalWait => n.kind === 'wait' && n.attrs.wait === 'approval');
  const wait = waits.find((n) => same(n.attrs.member, member)) ?? waits[0];
  if (!wait) return <>{fallback ?? null}</>;
  return (
    <ApprovalCard
      wait={wait}
      model={model}
      executionId={executionId}
      changes={changes}
      profile={resolveRunProfile(model.run?.attrs.profile)}
      traceHref={`/runs/${executionId}`}
      {...(onDecide && { decide: onDecide })}
      onDecided={() => {
        refresh();
        onDecided?.();
      }}
      className={className}
    />
  );
}

/** The card in a sheet over the page: the bottom of a phone, the middle of a desk. Escape or a tap outside closes it. */
export function ApprovalSheet({ executionId, member, onDecide, onClose }: { executionId: string; member?: string; onDecide?: DecideFn; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/40 sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && onClose()} data-testid="approval-sheet">
      <div role="dialog" aria-modal="true" aria-label="Approval" className="relative max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-bg p-2 shadow-pop sm:rounded-2xl">
        <button type="button" onClick={onClose} aria-label="Close" className="absolute right-3.5 top-3.5 z-10 grid size-7 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1">
          <X className="size-4" />
        </button>
        <LiveApprovalCard
          executionId={executionId}
          {...(member && { member })}
          {...(onDecide && { onDecide })}
          onDecided={onClose}
          fallback={<p className="p-4 text-[13px] text-t2">Loading the reasons…</p>}
        />
      </div>
    </div>,
    document.body,
  );
}
