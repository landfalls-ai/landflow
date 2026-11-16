'use client';
/**
 * The actions on a Needs you item that is not a run (docs/run-trace.md#needs-you): a project's AI budget today
 * (Resume, Raise, Dismiss, Open project) and a project task's run (Approve, Deny, Open task, Open session). `actionsFor` is pure, so the card in a project's Settings tab and the Needs you
 * row share one rule, and a later kind adds its actions here.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { acknowledgeSpendFlag, decideTaskRun, refreshNeedsYou, type NeedsYouRow } from '@/lib/client/run-trace';
import { fetchBudget, formatUsd, runIncidentAction } from '@/lib/client/project-budget-api';
import type { ProjectBudgetView } from '@/lib/shared/project-budget';
import { Dialog } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/inputs';
import { cn } from '@/lib/utils';

export type NeedsYouActionId = 'resume' | 'raise' | 'dismiss' | 'open' | 'approve' | 'deny' | 'acknowledge'; // PC20: approve, deny; SP23: acknowledge
export type NeedsYouAction = { id: NeedsYouActionId; label: string };

/** What a viewer may do from a row; [] for every kind that is not a project item. */
export function actionsFor(row: Pick<NeedsYouRow, 'kind' | 'incidentKind' | 'canRaise' | 'canResume' | 'taskRunStatus' | 'canDecide'> & { canAcknowledge?: boolean }): NeedsYouAction[] {
  // SP23: AI spend: Acknowledge (it leaves the list for everyone), and Open (the AI page at the day).
  if (row.kind === 'spend') return [...(row.canAcknowledge ? [{ id: 'acknowledge' as const, label: 'Acknowledge' }] : []), { id: 'open', label: 'Open' }];
  // PC20: a task's run: Approve and Deny for one who may decide a requested run, else open the task; a waiting run opens its session.
  if (row.kind === 'task') {
    if (row.taskRunStatus === 'waiting') return [{ id: 'open', label: 'Open session' }];
    return row.canDecide ? [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }, { id: 'open', label: 'Open task' }] : [{ id: 'open', label: 'Open task' }];
  }
  if (row.kind !== 'budget') return [];
  const out: NeedsYouAction[] = [];
  if (row.incidentKind === 'stop') {
    if (row.canResume) out.push({ id: 'resume', label: 'Resume this month' });
    if (row.canRaise) out.push({ id: 'raise', label: 'Raise budget…' });
  } else if (row.canResume) out.push({ id: 'dismiss', label: 'Dismiss' });
  out.push({ id: 'open', label: 'Open project' });
  return out;
}

/** The new amount for a raise: above the current budget. */
export function RaiseDialog({ projectId, incidentId, current, onClose, onRaised }: { projectId: string; incidentId: string; current?: number; onClose: () => void; onRaised: (view: ProjectBudgetView) => void }) {
  const [now, setNow] = useState(current);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (current !== undefined) return;
    fetchBudget(projectId)
      .then((v) => setNow(v.budget?.monthlyUsd))
      .catch(() => undefined);
  }, [projectId, current]);
  const amount = Number(value);
  const valid = value.trim() !== '' && Number.isFinite(amount) && (now === undefined || amount > now);
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onRaised(await runIncidentAction(projectId, incidentId, { action: 'raise', monthlyUsd: amount }));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Raise the budget"
      subtitle={now !== undefined ? `The monthly budget is ${formatUsd(now)} now.` : undefined}
      width={420}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!valid}>
            Raise budget
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void submit();
        }}
      >
        <label htmlFor="raise-amount" className="mb-1 block text-[12px] font-medium text-t2">
          New monthly budget (USD)
        </label>
        <Input id="raise-amount" type="number" inputMode="decimal" min={0} step="any" value={value} onChange={(e) => setValue(e.target.value)} autoFocus placeholder={now !== undefined ? `More than ${now}` : ''} />
        {error && <p className="mt-2 text-[12px] text-rd">{error}</p>}
      </form>
    </Dialog>
  );
}

/** The buttons of one budget incident. `skip` leaves one out (the card is already the project's settings). */
export function BudgetActions({
  row,
  onDone,
  skip,
  className,
  currentUsd,
}: {
  row: Pick<NeedsYouRow, 'kind' | 'incidentKind' | 'canRaise' | 'canResume' | 'projectId' | 'incidentId' | 'href'>;
  onDone: (view: ProjectBudgetView) => void;
  skip?: NeedsYouActionId[];
  className?: string;
  /** The monthly budget when the caller already has it (the budget card): the raise dialog then fetches nothing. */
  currentUsd?: number;
}) {
  const [raising, setRaising] = useState(false);
  const [busy, setBusy] = useState<NeedsYouActionId>();
  const actions = actionsFor(row).filter((a) => !skip?.includes(a.id));
  if (!actions.length || !row.projectId || !row.incidentId) return null;
  const run = async (id: 'resume' | 'dismiss') => {
    setBusy(id);
    try {
      onDone(await runIncidentAction(row.projectId!, row.incidentId!, { action: id }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const tall = 'max-md:min-h-[44px]';
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {actions.map((a) =>
        a.id === 'open' ? (
          <Link key={a.id} href={row.href ?? `/projects/${encodeURIComponent(row.projectId!)}?tab=settings#budget`} className={cn('inline-flex items-center rounded-[10px] border border-hair bg-wl px-3 text-[12.5px] font-medium text-t1 hover:border-ac', 'h-7', tall)}>
            {a.label}
          </Link>
        ) : (
          <Button
            key={a.id}
            size="sm"
            variant={a.id === 'resume' ? 'primary' : 'outline'}
            className={tall}
            loading={busy === a.id}
            disabled={busy !== undefined}
            onClick={() => {
              if (a.id === 'raise') setRaising(true);
              else void run(a.id as 'resume' | 'dismiss');
            }}
          >
            {a.label}
          </Button>
        ),
      )}
      {raising && (
        <RaiseDialog
          projectId={row.projectId}
          incidentId={row.incidentId}
          {...(currentUsd !== undefined && { current: currentUsd })}
          onClose={() => setRaising(false)}
          onRaised={(view) => {
            setRaising(false);
            toast.success('Budget raised');
            onDone(view);
          }}
        />
      )}
    </div>
  );
}

/** The buttons of one task run in Needs you (and the task dialog's last runs): Approve and Deny post the decision, then the list reloads. */
export function TaskActions({
  row,
  onDone,
  onFailed,
  skip,
  className,
}: {
  row: Pick<NeedsYouRow, 'kind' | 'taskRunId' | 'taskRunStatus' | 'canDecide' | 'href' | 'taskId' | 'projectId'>;
  /** After a decision went through (the Needs you list reloads either way). */
  onDone?: (decision: 'approve' | 'deny') => void;
  /** After a decision was refused (a 409 "Already approved"): the caller's own copy of the run is stale, so it reloads. */
  onFailed?: () => void;
  skip?: NeedsYouActionId[];
  className?: string;
}) {
  const [busy, setBusy] = useState<NeedsYouActionId>();
  const [error, setError] = useState<string>();
  const actions = actionsFor(row).filter((a) => !skip?.includes(a.id));
  if (!actions.length) return null;
  const decide = async (decision: 'approve' | 'deny') => {
    if (!row.taskRunId) return;
    setBusy(decision);
    setError(undefined);
    try {
      await decideTaskRun(row.taskRunId, decision);
      toast.success(decision === 'approve' ? 'Approved: the agent starts' : 'Denied');
      onDone?.(decision);
    } catch (e) {
      setError((e as Error).message);
      onFailed?.();
    } finally {
      setBusy(undefined);
      refreshNeedsYou();
    }
  };
  const tall = 'max-md:min-h-[44px]';
  const href = row.href ?? (row.projectId && row.taskId ? `/projects/${encodeURIComponent(row.projectId)}?tab=tasks&task=${encodeURIComponent(row.taskId)}` : '/projects');
  return (
    <div className={className}>
      <div className="flex flex-wrap gap-2">
        {actions.map((a) =>
          a.id === 'open' ? (
            <Link key={a.id} href={href} className={cn('inline-flex h-7 items-center rounded-[10px] border border-hair bg-wl px-3 text-[12.5px] font-medium text-t1 hover:border-ac', tall)}>
              {a.label}
            </Link>
          ) : (
            <Button key={a.id} size="sm" variant={a.id === 'approve' ? 'primary' : 'outline'} className={tall} loading={busy === a.id} disabled={busy !== undefined} onClick={() => void decide(a.id as 'approve' | 'deny')}>
              {a.label}
            </Button>
          ),
        )}
      </div>
      {error && (
        <p role="alert" className="mt-1.5 text-[12px] text-rd">
          {error}
        </p>
      )}
    </div>
  );
}

/** The buttons of one AI spend item (SP23): Acknowledge clears it for everyone, Open shows the AI page at the day. */
export function SpendActions({ row, className }: { row: Pick<NeedsYouRow, 'kind' | 'flagId' | 'canAcknowledge' | 'href'>; className?: string }) {
  const [busy, setBusy] = useState(false);
  const actions = actionsFor(row);
  const acknowledge = async () => {
    if (!row.flagId) return;
    setBusy(true);
    try {
      await acknowledgeSpendFlag(row.flagId);
      toast.success('Acknowledged');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      refreshNeedsYou();
    }
  };
  const tall = 'max-md:min-h-[44px]';
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {actions.map((a) =>
        a.id === 'open' ? (
          <Link key={a.id} href={row.href ?? '/insights/ai'} className={cn('inline-flex h-7 items-center rounded-[10px] border border-hair bg-wl px-3 text-[12.5px] font-medium text-t1 hover:border-ac', tall)}>
            {a.label}
          </Link>
        ) : (
          <Button key={a.id} size="sm" variant="outline" className={tall} loading={busy} disabled={busy} onClick={() => void acknowledge()}>
            {a.label}
          </Button>
        ),
      )}
    </div>
  );
}
