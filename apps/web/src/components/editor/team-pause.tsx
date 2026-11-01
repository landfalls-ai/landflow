'use client';
/**
 * Pause a team member and take over (docs/run-trace.md#pause-and-take-over), shared by the node's Now card, the Run Trace's
 * strip of members at work and its Needs you card. A Landflow agent stops at its next step boundary; a remote member is
 * stopped at once and redirected ("Stop and redirect"). While it waits, a composer takes the next instruction.
 */
import { useState } from 'react';
import { Loader2, Pause, Play } from 'lucide-react';
import { toast } from 'sonner';
import { continueMember, pauseMember, useWorkingMembers, type WorkingMember } from '@/lib/client/run-controls';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { Textarea } from '../ui/inputs';

export const sameMember = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A member's state in the list `useWorkingMembers` read. */
export const stateOf = (members: WorkingMember[], member: string) => members.find((m) => sameMember(m.member, member));

/** The Pause button of a member at work (or what it is doing about it). */
export function PauseButton({ executionId, member, state, kind, onChanged, className }: { executionId: string; member: string; state?: WorkingMember['state']; kind?: WorkingMember['kind']; onChanged?: () => void; className?: string }) {
  const [busy, setBusy] = useState(false);
  if (state === 'paused') return null;
  const remote = kind === 'remote';
  if (state === 'pausing') {
    return (
      <span className={cn('inline-flex items-center gap-1.5 text-[12px] font-medium text-warn', className)} role="status">
        <Loader2 className="size-3 animate-spin" /> {remote ? 'Stopping…' : 'Pausing after this step…'}
      </span>
    );
  }
  return (
    <Button
      size="sm"
      variant="outline"
      loading={busy}
      className={cn('nodrag nopan', className)}
      title={remote ? 'Cancel its task and send it your instruction in the same conversation' : 'It stops after the step it is on; you write the next instruction'}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
          await pauseMember(executionId, member);
          onChanged?.();
        } catch (error) {
          toast.error((error as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Pause className="size-3" fill="currentColor" /> {remote ? 'Stop and redirect' : 'Pause'}
    </Button>
  );
}

/** The composer of a paused member: what it should do next, and Continue. */
export function TakeOver({ executionId, member, remote, onDone, className }: { executionId: string; member: string; remote?: boolean; onDone?: () => void; className?: string }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await continueMember(executionId, member, text);
      toast.success(text.trim() ? `${member} goes on with your instruction` : `${member} goes on as it was`);
      setText('');
      onDone?.();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn('nodrag nopan flex flex-col gap-2', className)} data-testid="take-over" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <label htmlFor={`take-${member}`} className="text-[12px] font-medium text-t2">
        {remote ? `${member} was stopped. Your instruction goes to the same conversation` : `${member} is paused. Your instruction is added to what it knows, then it goes on`}
      </label>
      <Textarea id={`take-${member}`} rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="What should it do next?" />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" loading={busy} onClick={go}>
          <Play className="size-3" fill="currentColor" /> Continue{text.trim() ? '' : ' as it was'}
        </Button>
      </div>
    </div>
  );
}

/** The member's pause control read live from the run: a Pause button while it works, the composer while it is paused. */
export function TeamPauseBar({ executionId, member, className }: { executionId: string; member: string; className?: string }) {
  const { members, refresh } = useWorkingMembers(executionId, true);
  const mine = stateOf(members, member);
  if (!mine) return null;
  return mine.state === 'paused' ? (
    <TakeOver executionId={executionId} member={member} remote={mine.kind === 'remote'} onDone={refresh} className={className} />
  ) : (
    <div className={className}>
      <PauseButton executionId={executionId} member={member} state={mine.state} kind={mine.kind} onChanged={refresh} />
    </div>
  );
}
