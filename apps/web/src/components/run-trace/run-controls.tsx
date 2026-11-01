'use client';
/**
 * Run it again and take over, in the Run Trace (docs/run-trace.md#run-it-again, #pause-and-take-over): the detail sheet's
 * "Re-run from here" with the steps before it shown as pinned, "Ask this member again" and "Copy to editor"; a "Re-run from
 * here" on failed steps; the strip of members at work with their Pause button; the header's link back to the run this one
 * re-ran. The controls read the run they are for from `RunControlsProvider`.
 */
import { createContext, useContext, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ExternalLink, Pin, RotateCcw, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { askMemberAgain, rerunFromNode, type WorkingMember } from '@/lib/client/run-controls';
import { askAgainOf, copyToEditorHref, rerunPlan } from '@/lib/shared/run-rerun';
import type { RunModel } from '@/lib/shared/run-trace-model';
import { cn } from '@/lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { PauseButton } from '../editor/team-pause';
import { Avatar, Card } from './parts';

export interface RunControls {
  executionId: string;
  workflowId?: string;
  /** The run this one re-ran, when it is a re-run. */
  rerunOf?: { executionId: string; scope: string; nodeId?: string };
}

const Context = createContext<RunControls | undefined>(undefined);
export const RunControlsProvider = ({ value, children }: { value: RunControls; children: ReactNode }) => <Context.Provider value={value}>{children}</Context.Provider>;
export const useRunControls = () => useContext(Context);

/** Start a re-run, then open the new run's Run Trace with a toast. */
function useStarter() {
  const router = useRouter();
  const [busy, setBusy] = useState<string>();
  const start = async (key: string, begin: () => Promise<string>, said: string) => {
    setBusy(key);
    try {
      const id = await begin();
      toast.success(said, { description: 'Opening the new run' });
      router.push(`/runs/${id}`);
    } catch (error) {
      toast.error((error as Error).message);
      setBusy(undefined);
    }
  };
  return { busy, start };
}

/** The flow as a column of nodes: the ones before keep this run's outputs, the node and what follows run again. */
function PinnedRows({ model, spanId }: { model: RunModel; spanId: string }) {
  const plan = rerunPlan(model, spanId);
  if (!plan) return null;
  const row = (span: (typeof plan.again)[number], kind: 'pinned' | 'here' | 'again') => (
    <li key={span.id} className={cn('flex items-center gap-2.5 px-3 py-2 text-[13px]', kind === 'here' && (span.status === 'error' ? 'bg-rddim' : 'bg-acdim'))}>
      <Avatar actor={span.actor} size={22} />
      <span className="min-w-0 flex-1">
        <b className={cn('block truncate font-semibold', kind === 'pinned' ? 'text-t2' : 'text-t1')}>{span.name}</b>
        <span className={cn('block truncate text-[11.5px]', span.status === 'error' ? 'text-rd' : 'text-t3')}>{span.status === 'error' ? (span.error ?? 'failed') : span.status}</span>
      </span>
      {kind === 'pinned' ? (
        <Badge tone="muted">
          <Pin className="size-2.5" /> pinned
        </Badge>
      ) : (
        <Badge tone={kind === 'here' ? 'accent' : 'neutral'}>
          <RotateCcw className="size-2.5" /> {kind === 'here' ? 'starts here' : 'runs again'}
        </Badge>
      )}
    </li>
  );
  return (
    <ul className="divide-y divide-hair overflow-hidden rounded-xl border border-hair" aria-label="What a re-run keeps and runs again" data-testid="rerun-rows">
      {plan.pinned.map((s) => row(s, 'pinned'))}
      {plan.again.map((s, i) => row(s, i === 0 ? 'here' : 'again'))}
    </ul>
  );
}

/** In the detail sheet of a node (or a step or request inside one): re-run from it, ask the member again, copy to the editor. */
export function RerunPanel({ model, spanId }: { model: RunModel; spanId: string }) {
  const controls = useRunControls();
  return controls && rerunPlan(model, spanId) ? <RerunPanelFor controls={controls} model={model} spanId={spanId} /> : null;
}

function RerunPanelFor({ controls, model, spanId }: { controls: RunControls; model: RunModel; spanId: string }) {
  const { busy, start } = useStarter();
  const plan = rerunPlan(model, spanId)!;
  const ask = askAgainOf(model, spanId);
  const { executionId, workflowId } = controls;
  const live = model.live;
  const name = plan.node.name;
  return (
    <section className="mt-4 flex flex-col gap-2.5" aria-label="Run it again" data-testid="rerun-panel">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Run it again</h3>
      <PinnedRows model={model} spanId={spanId} />
      <p className="text-[12px] text-t3">
        {plan.pinned.length
          ? `The ${plan.pinned.length} step${plan.pinned.length > 1 ? 's' : ''} before keep${plan.pinned.length > 1 ? '' : 's'} this run's outputs; ${name}${plan.again.length > 1 ? ' and what follows' : ''} run again.`
          : `${name} is the first step: everything runs again.`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={live || Boolean(busy)} loading={busy === 'from'} title={live ? 'Wait for the run to end' : undefined} onClick={() => start('from', () => rerunFromNode(executionId, plan.node.nodeId!), `Re-running from “${name}”`)}>
          <RotateCcw className="size-3.5" /> Re-run from here
        </Button>
        {ask && (
          <Button variant="outline" disabled={live || Boolean(busy)} loading={busy === 'ask'} title="The same message to the same member, in a new turn: the team runs again with its lead asked to ask only this member" onClick={() => start('ask', () => askMemberAgain(executionId, ask.nodeId, ask.member, ask.message), `Asking ${ask.member} again`)}>
            <Undo2 className="size-3.5" /> Ask {ask.member} again
          </Button>
        )}
        {workflowId && (
          <Link
            href={copyToEditorHref(workflowId, executionId, plan.node.nodeId)}
            className="inline-flex h-8 items-center gap-[7px] rounded-full border border-bd px-[15px] text-[13px] font-medium text-t1 hover:border-ac hover:text-ac"
            title="Open the workflow in the editor with this run's outputs pinned up to this step"
          >
            <ExternalLink className="size-3.5" /> Copy to editor
          </Link>
        )}
      </div>
    </section>
  );
}

/** A small "Re-run from here" under a failed step in the Story and the Trace. */
export function RerunFromHere({ spanId, model, className }: { spanId: string; model: RunModel; className?: string }) {
  const controls = useRunControls();
  return controls && !model.live && rerunPlan(model, spanId) ? <RerunFromHereFor controls={controls} spanId={spanId} model={model} className={className} /> : null;
}

function RerunFromHereFor({ controls, spanId, model, className }: { controls: RunControls; spanId: string; model: RunModel; className?: string }) {
  const { busy, start } = useStarter();
  const plan = rerunPlan(model, spanId)!;
  return (
    <Button
      size="sm"
      variant="outline"
      className={className}
      loading={busy === 'from'}
      disabled={Boolean(busy)}
      onClick={() => start('from', () => rerunFromNode(controls.executionId, plan.node.nodeId!), `Re-running from “${plan.node.name}”`)}
      title={`${plan.pinned.length} earlier step${plan.pinned.length === 1 ? '' : 's'} keep this run's outputs`}
    >
      <RotateCcw className="size-3" /> Re-run from here
    </Button>
  );
}

/** The header says when the run is a re-run, and of which. */
export function RerunOfBadge({ model }: { model: RunModel }) {
  const controls = useRunControls();
  const of = controls?.rerunOf;
  if (!of) return null;
  const node = of.nodeId ? Object.values(model.spans).find((s) => s.nodeId === of.nodeId)?.name : undefined;
  const what = of.scope === 'all' ? 'Re-run of' : of.scope === 'only' ? `Re-run of ${node ? `“${node}”` : 'one step'} from` : `Re-run from ${node ? `“${node}”` : 'a step'} of`;
  return (
    <Link href={`/runs/${of.executionId}`} className="inline-flex max-w-full items-center gap-1 rounded-full border border-acbd bg-acdim px-2.5 py-0.5 text-[12px] font-medium text-t1 hover:border-ac" data-testid="rerun-of">
      <RotateCcw className="size-3 shrink-0 text-ac" />
      <span className="truncate">
        {what} <span className="font-mono">{of.executionId.slice(0, 12)}</span>
      </span>
    </Link>
  );
}

/** The members at work in a live run, each with its Pause button (a paused one is answered in Needs you). */
export function MembersAtWork({ executionId, members, onChanged }: { executionId: string; members: WorkingMember[]; onChanged: () => void }) {
  const shown = members.filter((m) => m.state !== 'paused');
  if (!shown.length) return null;
  return (
    <Card className="flex flex-col gap-2 py-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">At work now</div>
      {shown.map((m) => (
        <div key={m.member} className="flex items-center gap-2" data-testid="member-at-work">
          <span className="size-1.5 shrink-0 animate-pulse-soft rounded-full bg-warn" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-t1">{m.member}</span>
          <PauseButton executionId={executionId} member={m.member} state={m.state} kind={m.kind} onChanged={onChanged} />
        </div>
      ))}
    </Card>
  );
}
