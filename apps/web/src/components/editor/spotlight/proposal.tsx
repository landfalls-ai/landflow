'use client';
/** Changes as cards and rows, and the autonomous switch (docs/assistant.md#the-spotlight-panel). */
import { useState } from 'react';
import { Check, ChevronRight, Loader2, Undo2, Wrench, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { opsTitle } from '@/lib/shared/assistant-ops';
import { Button } from '../../ui/button';
import { useAutonomous } from '../autonomous';
import { applyChanges, sendFeedback, undos, useAssistant, type Proposal } from '../assistant';
import { LeftOut, OpsDiff, Warnings } from '../suggestions-card';

/** A change waiting for Apply (autonomous mode off). */
export function ProposalCard({ itemId, proposal }: { itemId: string; proposal: Proposal }) {
  const decide = (state: 'applied' | 'dismissed') => useAssistant.getState().setProposalState(itemId, proposal.id, state);
  return (
    <div className={cn('animate-fade-up space-y-2 rounded-xl border bg-sf p-2.5', proposal.state === 'applied' ? 'border-gnbd' : 'border-acbd')}>
      <div className="text-[13px] font-semibold leading-snug text-t1">{proposal.summary}</div>
      <OpsDiff ops={proposal.ops} />
      <Warnings warnings={proposal.warnings} />
      <LeftOut reasons={proposal.dropped} />
      <div className="flex items-center gap-1.5">
        {proposal.state === 'applied' ? (
          <span className="flex animate-pop items-center gap-1 text-[12px] font-semibold text-gn">
            <Check className="size-3.5" /> Applied
          </span>
        ) : proposal.state === 'dismissed' ? (
          <span className="text-[12px] text-t3">Dismissed</span>
        ) : (
          <>
            <Button size="sm" variant="primary" onClick={() => applyChanges([{ ops: proposal.ops, kind: 'proposal' }], proposal.summary) && decide('applied')}>
              Apply
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                decide('dismissed');
                sendFeedback('proposal', 'dismissed');
              }}
            >
              Dismiss
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A change as a row of the timeline: applied by Spotlight (autonomous mode, a fix). Its title says what it did, read from
 * its ops; the model's words and the diff open on a click. The latest one has Undo (a phone has no ⌘Z).
 */
export function ProposalRow({ itemId, proposal, fix }: { itemId: string; proposal: Proposal; fix: boolean }) {
  const [open, setOpen] = useState(false);
  // Re-read on each render: the newest undo is the only one that is safe to use.
  const latest = useAssistant((s) => s.items.length) >= 0 && [...undos.keys()].at(-1) === proposal.id;
  const verb = proposal.state === 'applied' ? (fix ? 'Fixed' : 'Done') : proposal.state === 'dismissed' ? 'Not applied' : proposal.state === 'undone' ? 'Undone' : 'Applying';
  const undo = () => {
    undos.get(proposal.id)?.();
    undos.delete(proposal.id);
    useAssistant.getState().setProposalState(itemId, proposal.id, 'undone');
  };
  return (
    <div className="animate-in">
      <div className="flex items-start gap-1">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-h-7 min-w-0 flex-1 items-start gap-1.5 rounded-md py-0.5 text-left text-[12.5px] leading-snug hover:bg-acdim">
          {proposal.state === 'applied' ? (
            <Wrench className="mt-px size-3.5 shrink-0 text-viz-7" />
          ) : proposal.state ? (
            <Undo2 className="mt-px size-3.5 shrink-0 text-t3" />
          ) : (
            <Loader2 className="mt-px size-3.5 shrink-0 animate-spin text-t3" />
          )}
          <span className={cn('min-w-0 flex-1 [overflow-wrap:anywhere]', proposal.state === 'undone' && 'line-through decoration-t3')}>
            <span className="font-semibold text-t1">{verb}</span>
            <span className="text-t2"> · {opsTitle(proposal.ops)}</span>
            {proposal.skipped ? <span className="text-warn"> ({proposal.skipped} part{proposal.skipped === 1 ? '' : 's'} skipped)</span> : null}
          </span>
          <ChevronRight className={cn('mt-px size-3.5 shrink-0 text-t3 transition-transform', open && 'rotate-90')} />
        </button>
        {proposal.state === 'applied' && latest && (
          <button type="button" onClick={undo} className="min-h-7 shrink-0 rounded-full px-2 text-[11.5px] font-semibold text-ac hover:bg-acdim max-md:min-h-11 max-md:px-3">
            Undo
          </button>
        )}
      </div>
      {open && (
        <div className="mt-1.5 space-y-1.5 pl-5">
          <p className="text-[12px] leading-snug text-t2">{proposal.summary}</p>
          <OpsDiff ops={proposal.ops} />
          <Warnings warnings={proposal.warnings} />
          {proposal.dropped.length > 0 && <p className="text-[11px] text-t3">Left out: {proposal.dropped.join('; ')}</p>}
        </div>
      )}
    </div>
  );
}

/** Autonomous mode's switch: on, Spotlight applies its changes and tests and fixes the flow without waiting for a click. */
export function AutonomousSwitch({ compact }: { compact?: boolean }) {
  const { on, set } = useAutonomous();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Autonomous"
      title={on ? 'Autonomous: Spotlight applies its changes and tests and fixes the flow by itself. Click to ask first.' : 'Asks before applying and testing. Click to let Spotlight do it by itself.'}
      onClick={() => set(!on)}
      className={cn(
        'flex h-7 shrink-0 items-center gap-1 rounded-full border px-2 text-[11.5px] font-semibold transition-colors max-md:h-11 max-md:px-3',
        on ? 'border-transparent bg-ac2 text-on-ac hover:bg-ac2-hover' : 'border-bd text-t2 hover:text-t1',
      )}
    >
      <Zap className="size-3" fill={on ? 'currentColor' : 'none'} /> <span className={cn('max-md:sr-only', compact && 'sr-only')}>Autonomous</span>
    </button>
  );
}
