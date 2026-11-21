'use client';
/**
 * The approver's view of the approval inbox (wave ap1, docs/approval-inbox.md): a run nobody watches paused at a tool that asks
 * first, and the question waits here. Each row says what would run (the tool, the agent and workflow versions, the destination,
 * since and expires) and has Approve and Deny; Details opens the parameters it would run with (masked by the server and again
 * here), the run and the agent. A decision goes through the one claim on the server, so a second approver or the expiry timer
 * is answered with who won. There is no bulk approve, no select-many and no shortcut that approves: one request, one click.
 */
import { TicketLinks } from './ticket-links'; // C12:
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Ban, Check, Clock, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  decideRow,
  getRequest,
  inboxClock,
  judgeRowTitle,
  rowOfView,
  useApprovalInbox,
  useRowStates,
  versionName,
  waitText,
  withDecided,
  type InboxRowData,
} from '@/lib/client/approval-inbox';
import { expiryText, maskParams, MASK, settledLine, type InboxRequestView } from '@/lib/shared/approval-inbox';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Sheet } from '../ui/sheet';
import { SectionTitle } from '../run-trace/parts';
import { JudgedItem, JudgeEvidenceView } from './judge-evidence';

/** A parameter's value as one readable string: text as is, anything else as compact JSON; secrets never get here unmasked. */
export function paramText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Approve and Deny for one request, or why there are none; shared by the row and the Details sheet. */
export function DecideButtons({ row, index, className }: { row: InboxRowData; index: number; className?: string }) {
  const state = useRowStates().get(row.id);
  if (!row.canDecide) return <p className={cn('text-[12px] text-t3', className)}>Only people who can run this workflow decide it.</p>;
  if (state?.settled || state?.closed) return null;
  const go = (decision: 'approve' | 'deny') => decideRow(row, index, decision).catch((e: Error) => toast.error(e.message));
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <Button size="sm" variant="primary" className="max-md:min-h-11" loading={state?.busy === 'approve'} disabled={Boolean(state?.busy)} onClick={() => void go('approve')} data-testid="inbox-approve">
        {state?.busy !== 'approve' && <Check className="size-3.5" strokeWidth={3} />} Approve
      </Button>
      <Button size="sm" variant="danger" className="max-md:min-h-11" loading={state?.busy === 'deny'} disabled={Boolean(state?.busy)} onClick={() => void go('deny')} data-testid="inbox-deny">
        {state?.busy !== 'deny' && <Ban className="size-3.5" />} Deny
      </Button>
    </div>
  );
}

const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <>
    <dt className="text-[12px] text-t3">{label}</dt>
    <dd className="min-w-0 text-[13px] text-t1 [overflow-wrap:anywhere]">{children}</dd>
  </>
);

/** What it would run with and where it goes: a side sheet on a desk, a bottom sheet on a phone. */
export function InboxDetails({ row, index, onClose }: { row: InboxRowData; index: number; onClose: () => void }) {
  const [view, setView] = useState<InboxRequestView | undefined>(row.view);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (row.view?.params) return;
    let live = true;
    getRequest(row.id)
      .then((v) => live && (v ? setView(v) : setMissing(true)))
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [row.id, row.view]);
  const judge = row.kind === 'judge';
  const params = Object.entries(maskParams(view?.params ?? {}));
  const minutes = row.expiresAt ? Math.max(1, Math.round((Date.parse(row.expiresAt) - Date.parse(row.requestedAt)) / 60_000)) : undefined;
  return (
    <Sheet
      open
      onClose={onClose}
      title={judge ? 'AI Judge: ' + row.tool : row.tool}
      className="md:max-w-[520px]"
      footer={<DecideButtons row={row} index={index} />}
    >
      <div data-testid="inbox-details">
        {judge ? (
          <>
            <p className="mb-3 text-[12.5px] text-t2">
              The AI Judge <b>{row.tool}</b> could not decide. Approve lets the item continue as approved; Deny, or no answer, denies it.
            </p>
            {view ? (
              <>
                <JudgedItem params={view.params} />
                {view.evidence && <JudgeEvidenceView evidence={view.evidence} />}
              </>
            ) : (
              <p className="mb-4 text-[12.5px] text-t2">{missing ? 'The request could not be loaded.' : 'Loading…'}</p>
            )}
          </>
        ) : (
          <>
        <p className="mb-3 text-[12.5px] text-t2">
          {versionName(row.agentName ?? 'The agent', row.agentVersion)} wants to run <b>{row.tool}</b> with these parameters.
        </p>
        <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Parameters</h4>
        <dl className="mb-4 grid grid-cols-[minmax(0,96px)_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-xl border border-hair bg-wl px-3 py-2.5" data-testid="inbox-params">
          {params.length ? (
            params.map(([key, value]) => (
              <Fact key={key} label={key}>
                <span className={cn('whitespace-pre-wrap', value === MASK && 'font-mono text-t3')}>{paramText(value)}</span>
              </Fact>
            ))
          ) : (
            <p className="col-span-2 text-[12.5px] text-t2">{missing ? 'The parameters could not be loaded.' : view ? 'It runs with no parameters.' : 'Loading the parameters…'}</p>
          )}
        </dl>
          </>
        )}
        <dl className="grid grid-cols-[minmax(0,96px)_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          {row.destination && <Fact label="Goes to">{row.destination}</Fact>}
          {view?.trigger && <Fact label="Started by">a {view.trigger} run</Fact>}
          {!judge && <Fact label="Agent">{view?.agentId ? <Link href={`/agents/${view.agentId}`} className="text-ac hover:underline">{versionName(row.agentName ?? 'Agent', row.agentVersion)}</Link> : versionName(row.agentName ?? 'Agent', row.agentVersion)}</Fact>}
          <Fact label="Workflow">{view?.workflowId ? <Link href={`/workflows/${view.workflowId}`} className="text-ac hover:underline">{versionName(row.workflowName, row.workflowVersion)}</Link> : versionName(row.workflowName, row.workflowVersion)}</Fact>
          <Fact label="The run">
            <Link href={`/runs/${row.executionId}`} className="inline-flex items-center gap-1 text-ac hover:underline">
              Open the run <ExternalLink className="size-3" />
            </Link>
          </Fact>
          <Fact label="Waiting since">{inboxClock(row.requestedAt)}</Fact>
          {row.expiresAt && (
            <Fact label="Expires">
              {inboxClock(row.expiresAt)}
              {minutes !== undefined && <span className="text-t3"> · {expiryText(minutes)} after it opened; then {judge ? 'it is denied' : 'the call does not run'}</span>}
            </Fact>
          )}
        </dl>
      </div>
    </Sheet>
  );
}

/** One request that waits (or was just decided). `<li>`: it sits in a list on Home and on the Runs page. */
export function InboxRow({ row, index = 0, autoOpen, className }: { row: InboxRowData; index?: number; autoOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(Boolean(autoOpen));
  const state = useRowStates().get(row.id);
  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);
  return (
    <li id={`approval-${row.id}`} data-testid="inbox-row" data-request={row.id} className={cn('px-4 py-3', className)}>
      <div className="flex items-center gap-2">
        <Badge tone="warning">{row.kind === 'judge' ? 'Decision' : 'Approval'}</Badge>
        <span className="min-w-0 truncate text-[12px] text-t3">{versionName(row.workflowName, row.workflowVersion)}</span>
      </div>
      <p className="mt-1 text-[14px] font-medium text-t1 [overflow-wrap:anywhere]" data-testid="inbox-tool">
        {row.kind === 'judge' ? judgeRowTitle(row) : row.tool}
      </p>
      <p className="text-[12.5px] text-t2 [overflow-wrap:anywhere]" data-testid="inbox-versions">
        {row.kind !== 'judge' && (
          <>
            {versionName(row.agentName ?? 'Agent', row.agentVersion)}
            <span className="text-t3"> · </span>
          </>
        )}
        {versionName(row.workflowName, row.workflowVersion)}
      </p>
      {row.destination && (
        <p className="truncate text-[12.5px] text-t2" title={row.destination} data-testid="inbox-destination">
          {row.destination}
        </p>
      )}
      {state?.settled ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-[12.5px] font-medium text-gn" role="status" data-testid="inbox-settled">
          <Check className="size-3.5 shrink-0" strokeWidth={3} /> {state.settled}
        </p>
      ) : state?.closed ? (
        <p className="mt-1.5 text-[12.5px] font-medium text-warn" role="status" data-testid="inbox-closed">
          {state.closed}
        </p>
      ) : (
        <p className="mt-1 flex items-start gap-1.5 text-[12px] text-t3" data-testid="inbox-waiting">
          <Clock className="mt-px size-3 shrink-0" aria-hidden /> <span>{waitText(row)}</span>
        </p>
      )}
      <TicketLinks tickets={row.tickets} />
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <DecideButtons row={row} index={index} />
        <Button size="sm" variant="ghost" className="max-md:min-h-11" onClick={() => setOpen(true)} data-testid="inbox-details-open">
          Details
        </Button>
      </div>
      {open && <InboxDetails row={row} index={index} onClose={() => setOpen(false)} />}
    </li>
  );
}

/** Home's panel: every request waiting for you; nothing at all when none waits. */
export function ApprovalInboxPanel() {
  const { requests } = useApprovalInbox();
  const states = useRowStates();
  // `?approval=<id>`: the link in a nudge opens that request; a request that is no longer waiting shows how it ended.
  const [focus, setFocus] = useState<string>();
  const [ended, setEnded] = useState<InboxRequestView | null>();
  useEffect(() => {
    setFocus(new URLSearchParams(window.location.search).get('approval') ?? undefined);
  }, []);
  const waiting = requests?.some((r) => r.id === focus);
  useEffect(() => {
    if (!focus || !requests || waiting) return;
    let live = true;
    getRequest(focus)
      .then((v) => live && setEnded(v ?? null))
      .catch(() => live && setEnded(null));
    return () => {
      live = false;
    };
  }, [focus, requests, waiting]);
  const scrolled = useRef(false);
  useEffect(() => {
    if (!focus || !waiting || scrolled.current) return;
    scrolled.current = true;
    document.getElementById(`approval-${focus}`)?.scrollIntoView?.({ block: 'center' });
  }, [focus, waiting]);

  const rows = withDecided((requests ?? []).map(rowOfView), states);
  const open = rows.filter((r) => !states.get(r.id)?.settled && !states.get(r.id)?.closed).length;
  if (!rows.length && ended === undefined) return null;
  return (
    <section aria-label="Waiting for your approval" data-testid="approval-inbox">
      <SectionTitle>Waiting for your approval{open > 0 && ` · ${open}`}</SectionTitle>
      {focus && !waiting && ended !== undefined && (
        <p className="mb-2 rounded-xl border border-hair bg-sf px-4 py-2.5 text-[12.5px] text-t2" role="status" data-testid="inbox-focus">
          {ended ? (ended.status === 'waiting' ? waitText({ requestedAt: ended.requestedAt, expiresAt: ended.expiresAt }) : settledLine(ended, inboxClock)) : 'That request is not in your approvals any more.'}
        </p>
      )}
      {rows.length > 0 && (
        <ul className="divide-y divide-hair overflow-hidden rounded-2xl border border-warnbd bg-warndim">
          {rows.map((row, index) => (
            <InboxRow key={row.id} row={row} index={index} autoOpen={row.id === focus} />
          ))}
        </ul>
      )}
    </section>
  );
}
