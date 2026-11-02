'use client';
/** Run Trace on the Executions page and Home: what needs you across runs, and a live card per running execution. */
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { timeAgo } from '@/lib/client/format';
import { useNeedsYou, useRunJournal, type NeedsYouRow } from '@/lib/client/run-trace';
import { cut, fmtMs } from '@/lib/shared/run-trace-model';
import type { ExecutionSummary } from '@/lib/shared/types';
import { Badge } from '../ui/badge';
import { useNewLook } from '../shell/look-toggle';
import { RunTimelineLive } from './run-timeline-card';
import { SectionTitle } from './parts';
import { NeedFaces } from './approval-card';
import { listFaces } from '@/lib/shared/approval-evidence';

const KIND: Record<NeedsYouRow['kind'], string> = { approval: 'Approval', form: 'Form', question: 'Question', gate: 'Checks failed', check: 'Check failed' };

/** Waits for a person and failed checks nobody settled, newest first; each opens the run. */
export function NeedsYouList() {
  const { items } = useNeedsYou();
  const newLook = useNewLook();
  if (!items?.length) return null;
  // The new look: who has something for you, across the runs (a dot on each member that waits).
  const faces = newLook ? listFaces(items.filter((i) => i.member || i.actor?.type === 'agent')) : [];
  return (
    <section aria-label="Needs you">
      <SectionTitle>Needs you · {items.length}</SectionTitle>
      {faces.length > 0 && <NeedFaces faces={faces} className="mb-2 px-1" />}
      <ul className="divide-y divide-hair overflow-hidden rounded-2xl border border-warnbd bg-warndim">
        {items.map((item) => (
          <li key={`${item.executionId}:${item.spanId ?? item.title}`}>
            <Link href={`/runs/${item.executionId}`} className="flex min-h-[56px] items-center gap-3 px-4 py-2.5 hover:bg-acdim/60">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Badge tone={item.kind === 'check' || item.kind === 'gate' ? 'danger' : 'warning'}>{KIND[item.kind]}</Badge>
                  <span className="truncate text-[12px] text-t3">
                    {item.workflowName} · {timeAgo(item.since)}
                  </span>
                </div>
                <p className="mt-1 truncate text-[14px] font-medium text-t1">{item.title}</p>
                {item.detail && <p className="truncate text-[12.5px] text-t2">{cut(item.detail, 120)}</p>}
              </div>
              <ChevronRight className="size-4 shrink-0 text-t3" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LiveCard({ execution }: { execution: ExecutionSummary }) {
  const { model } = useRunJournal(execution.id);
  const working = model.working.at(-1);
  return (
    <li>
      <Link href={`/runs/${execution.id}`} className="flex min-h-[56px] items-center gap-3 px-4 py-2.5 hover:bg-acdim/60">
        <span className="size-2 shrink-0 rounded-full bg-warn animate-pulse-soft" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-t1">{execution.workflowName}</p>
          <p className="truncate text-[12.5px] text-t2">
            {working ? `${working.actor.name} ${working.actor.type === 'human' ? 'deciding' : 'working'} · ${cut(working.name, 60)}` : model.empty ? 'Starting…' : 'Running'}
            {!model.empty && <span className="text-t3"> · {fmtMs(Date.now() - Date.parse(execution.startedAt))}</span>}
          </p>
        </div>
        <ChevronRight className="size-4 shrink-0 text-t3" />
      </Link>
    </li>
  );
}

/** Running executions with who is working now, from their journal. */
export function LiveRuns({ executions }: { executions: ExecutionSummary[] }) {
  const newLook = useNewLook();
  const running = executions.filter((e) => e.status === 'running').slice(0, 5);
  if (!running.length) return null;
  // The new look: each run as a timeline, the member at work on its step (docs/run-trace.md#a-run-as-a-timeline).
  if (newLook)
    return (
      <section aria-label="Running now">
        <SectionTitle>Running now · {running.length}</SectionTitle>
        <div className="flex flex-col gap-2.5">
          {running.map((e) => (
            <RunTimelineLive key={e.id} executionId={e.id} name={e.workflowName} />
          ))}
        </div>
      </section>
    );
  return (
    <section aria-label="Running now">
      <SectionTitle>Running now · {running.length}</SectionTitle>
      <ul className="divide-y divide-hair overflow-hidden rounded-2xl border border-hair bg-sf">
        {running.map((e) => (
          <LiveCard key={e.id} execution={e} />
        ))}
      </ul>
    </section>
  );
}
