'use client';
/** AG16: what is said before and after an edit made through a bubble or the node creator's "Add to <agent>": how many workflows it touches, and how it went. */
import { toast } from 'sonner';
import type { AgentSmoke } from '@/lib/shared/agent-card';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';

/** "Alert triager runs in 2 workflows: this changes both": said before a change from the canvas when more than this workflow runs the agent. */
export const usedByWords = (agentName: string, usedBy: ReadonlyArray<unknown> | undefined): string | undefined =>
  usedBy && usedBy.length > 1 ? `${agentName} runs in ${usedBy.length} workflows: this changes ${usedBy.length === 2 ? 'both' : 'all of them'}` : undefined;

/** What an edit said back: it is in the draft, not published, and how its test went. */
export function toastEdit(agentName: string, what: string, smoke: AgentSmoke): void {
  const ok = smoke.state === 'passed' || smoke.state === 'untested';
  const tail = smoke.state === 'failed' ? `; its test did not pass${smoke.reason ? `: ${smoke.reason}` : ''}` : smoke.state === 'untested' && smoke.reason ? `; ${smoke.reason}` : '';
  (ok ? toast.success : toast.warning)(`${what} ${agentName}: not published yet${tail}`);
}

/** The confirm that says how many workflows a change touches, with Change / Cancel. */
export function ConfirmChange({ words, onConfirm, onCancel }: { words: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Dialog
      title="Change the saved agent?"
      subtitle={words}
      onClose={onCancel}
      width={440}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={onConfirm}>
            Change
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-snug text-t2">The change goes to the agent’s draft. It is live in every workflow only after you publish the agent.</p>
    </Dialog>
  );
}

