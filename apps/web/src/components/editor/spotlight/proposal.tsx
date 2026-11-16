'use client';
/** Changes as cards and rows, and the autonomous switch (docs/assistant.md#the-spotlight-panel). */
import { useEffect, useState } from 'react';
import { Check, ChevronRight, Loader2, Undo2, Wrench, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { opsTitle } from '@/lib/shared/assistant-ops';
import { Button } from '../../ui/button';
import { Collapsible } from '../../ui/chat-motion';
import { Segmented } from '../../ui/segmented';
import { useAutonomous } from '../autonomous';
import { autonomyOf, useAutonomyFacts } from '../spotlight-autonomy'; // SB04:
import { useEditor } from '../store'; // SB04:
import { applyChanges, sendFeedback, undos, useAssistant, type Proposal } from '../assistant';
import { LeftOut, OpsDiff, Warnings } from '../suggestions-card';
import { ChangeDiff, hasDiff, useCanvas } from '../change-diff'; // SB08:
import { EXPLAINER_KEY, cardFolded, explainerDue, isNewestUndo, undoGroup } from './states';

/** Undo the step this proposal was applied in: every proposal applied with it goes back to 'undone' and loses its undo. */
export function undoProposal(proposalId: string): void {
  const group = undoGroup(undos, proposalId);
  if (!group.length) return;
  undos.get(proposalId)?.();
  const store = useAssistant.getState();
  for (const id of group) {
    undos.delete(id);
    for (const item of store.items) {
      if (item.role === 'assistant' && item.parts.some((p) => p.kind === 'proposal' && p.proposal.id === id)) store.setProposalState(item.id, id, 'undone');
    }
  }
}

/**
 * A change waiting for Apply (autonomous mode off). Apply folds the card into its one-line row, with a tick, while the
 * ghosts on the canvas become the real nodes (`GhostNodeView`); Undo opens it again and the nodes go back to ghosts.
 */
/** SB08: reads the canvas only while the card waits, so a folded card does not re-render on a node drag. */
function WaitingDiff({ proposal }: { proposal: Proposal }) {
  const canvas = useCanvas();
  return <ChangeDiff before={canvas} ops={proposal.ops} id={proposal.id} />;
}

export function ProposalCard({ itemId, proposal }: { itemId: string; proposal: Proposal }) {
  const decide = (state: 'applied' | 'dismissed' | 'undone') => useAssistant.getState().setProposalState(itemId, proposal.id, state);
  const applied = cardFolded(proposal.state);
  // Re-read on each render (the subscription): the newest undo is the only one that is safe to use.
  const canUndo = useAssistant((s) => s.items.length) >= 0 && isNewestUndo(undos, proposal.id);
  const apply = () => {
    const ok = applyChanges([{ ops: proposal.ops, kind: 'proposal' }], proposal.summary, {
      onApplied: ({ undo }) => undos.set(proposal.id, undo),
    });
    if (ok) decide('applied');
  };
  const undo = () => undoProposal(proposal.id);
  return (
    <div className={cn('animate-fade-up rounded-xl border bg-sf p-2.5 transition-colors duration-200 motion-reduce:transition-none', applied ? 'border-gnbd' : 'border-acbd')}>
      <div className="flex items-start gap-1.5">
        {applied && <Check className="mt-px size-3.5 shrink-0 animate-pop text-gn" />}
        <div className="min-w-0 flex-1 text-[13px] font-semibold leading-snug text-t1">{proposal.summary}</div>
        {applied && (
          <>
            <span className="shrink-0 text-[12px] font-semibold text-gn">Applied</span>
            {canUndo && (
              <button type="button" onClick={undo} className="-my-0.5 min-h-7 shrink-0 rounded-full px-2 text-[11.5px] font-semibold text-ac hover:bg-acdim max-md:min-h-11 max-md:px-3">
                Undo
              </button>
            )}
          </>
        )}
      </div>
      <Collapsible open={!applied}>
        <div className="space-y-2 pt-2">
          {applied ? <ChangeDiff ops={proposal.ops} id={proposal.id} settled /> : <WaitingDiff proposal={proposal} />} {/* SB08: */}
          <Warnings warnings={proposal.warnings} />
          <LeftOut reasons={proposal.dropped} />
          <div className="flex items-center gap-1.5">
            {proposal.state === 'dismissed' ? (
              <span className="text-[12px] text-t3">Dismissed</span>
            ) : proposal.state === 'undone' ? (
              // Taken back: the change is not waiting any more (no ghosts, not counted); ask Spotlight again to bring it back.
              <span className="text-[12px] text-t3">Undone</span>
            ) : proposal.state === 'stale' ? (
              // Kept from an earlier visit, and the workflow changed since: there is nothing to apply.
              <span className="text-[12px] text-t3">This no longer fits the workflow</span>
            ) : (
              <>
                <Button size="sm" variant="primary" onClick={apply}>
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
      </Collapsible>
    </div>
  );
}

/**
 * A change as a row of the timeline: applied by Spotlight (autonomous mode, a fix). Its title says what it did, read from
 * its ops; the model's words and the diff open on a click. The latest one has Undo (a phone has no ⌘Z).
 */
export function ProposalRow({ proposal, fix }: { proposal: Proposal; fix: boolean }) {
  const [open, setOpen] = useState(false);
  // Re-read on each render: the newest undo is the only one that is safe to use.
  const latest = useAssistant((s) => s.items.length) >= 0 && isNewestUndo(undos, proposal.id);
  const verb = proposal.state === 'applied' ? (fix ? 'Fixed' : 'Done') : proposal.state === 'dismissed' ? 'Not applied' : proposal.state === 'undone' ? 'Undone' : 'Applying';
  const undo = () => undoProposal(proposal.id);
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
          {hasDiff(proposal.id) ? <ChangeDiff ops={proposal.ops} id={proposal.id} settled open={false} /> : <OpsDiff ops={proposal.ops} />} {/* SB08: */}
          <Warnings warnings={proposal.warnings} />
          {proposal.dropped.length > 0 && <p className="text-[11px] text-t3">Left out: {proposal.dropped.join('; ')}</p>}
        </div>
      )}
    </div>
  );
}

/** The first-run note on Asks first and Autonomous: due until Got it (or a pick on the switch), once (`EXPLAINER_KEY`). */
export function useAutonomousExplainer(): { note: boolean; close: () => void } {
  const [note, setNote] = useState(false);
  useEffect(() => {
    if (explainerDue((k) => localStorage.getItem(k))) setNote(true);
  }, []);
  const close = () => {
    setNote(false);
    try {
      localStorage.setItem(EXPLAINER_KEY, 'yes');
    } catch {
      // Private mode: it shows again next visit.
    }
  };
  return { note, close };
}

/** The note itself. `className` places it: pinned to the phone's bottom edge, or in the panel's flow on a desktop. */
export function AutonomousExplainer({ onClose, className }: { onClose: () => void; className?: string }) {
  return (
    <div role="dialog" aria-label="Asks first or Autonomous" className={cn('animate-fade-up space-y-1.5 rounded-xl border border-hair bg-sf p-3 text-[12px] leading-snug text-t2 shadow-pop', className)}>
      <p>
        <span className="font-semibold text-t1">Autonomous</span> (now): Spotlight applies its changes, then tests and fixes the flow by itself. Every change has Undo.
      </p>
      <p>
        <span className="font-semibold text-t1">Asks first</span>: it waits for your Apply before changing anything.
      </p>
      <Button size="sm" variant="primary" onClick={onClose}>
        Got it
      </Button>
    </div>
  );
}

/**
 * Autonomous mode's switch, in the header: Asks first | Autonomous (on by default). Autonomous: Spotlight applies its
 * changes and tests and fixes the flow by itself; Asks first: it waits for Apply. The first time it shows, a note
 * explains the two, once. Without `explainer` the switch keeps the note itself and pins it to the bottom of the screen
 * (the phone's header); the desktop row passes its own and shows the note under the row, so it never covers the
 * conversation.
 */
export function AutonomousSwitch({ compact, explainer }: { compact?: boolean; explainer?: { note: boolean; close: () => void } }) {
  const { on, set } = useAutonomous();
  const own = useAutonomousExplainer();
  const { note, close } = explainer ?? own;
  // SB04: the switch is the person's choice, but on a saved or published workflow Spotlight asks first anyway (decision D1).
  return (
    <div className="relative shrink-0">
      <Segmented
        label="How Spotlight works"
        size="sm"
        className="[&_[role=tab]]:px-2 [&_[role=tab]]:text-[11.5px]"
        value={on ? 'auto' : 'asks'}
        onChange={(v) => {
          set(v === 'auto');
          if (note) close();
        }}
        options={[
          { value: 'asks', label: (
              <>
                <span className={compact ? 'hidden' : 'max-md:hidden'}>Asks first</span>
                <span className={compact ? '' : 'md:hidden'}>Ask</span>
              </>
            ), title: 'Asks before applying and testing.', ariaLabel: 'Asks first' },
          { value: 'auto', label: (
              <>
                <span className={cn('max-md:hidden', compact && 'hidden')}>Autonomous</span>
                <Zap className={cn('size-3', !compact && 'md:hidden')} fill={on ? 'currentColor' : 'none'} />
              </>
            ),
            title: 'Spotlight applies its changes and tests and fixes the flow by itself.', ariaLabel: 'Autonomous' },
        ]}
      />
      {note && !explainer && <AutonomousExplainer onClose={close} className="fixed inset-x-3 bottom-3 z-50" />}
    </div>
  );
}

export const ASKS_FIRST_NOTE = 'Spotlight acts alone only while it builds a new draft. This workflow is saved or published, so it asks first.';

/**
 * SB04: on a saved or published workflow Spotlight asks first even with the switch on (decision D1). One quiet line in the
 * panel's flow (under the switch's row on a desktop, under the header on a phone), so it covers nothing.
 */
export function AsksFirstNote({ className }: { className?: string }) {
  const { on } = useAutonomous();
  const workflowId = useEditor((st) => st.workflowId);
  const asksFirst = useAutonomyFacts(() => autonomyOf(workflowId) === 'asks-first') && Boolean(workflowId);
  if (!on || !asksFirst) return null;
  return (
    <p role="note" className={cn('px-3 pb-1.5 text-[11.5px] leading-snug text-t3', className)}>
      {ASKS_FIRST_NOTE}
    </p>
  );
}
