'use client';
/** Run Trace on the Executions page and Home: what needs you across runs, and a live card per running execution. */
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { timeAgo } from '@/lib/client/format';
import { useNeedsYou, type NeedsYouRow } from '@/lib/client/run-trace';
import { cut } from '@/lib/shared/run-trace-model';
import type { ExecutionSummary } from '@/lib/shared/types';
import { Badge } from '../ui/badge';
import { RunTimelineLive } from './run-timeline-card';
import { SectionTitle } from './parts';
import { NeedFaces } from './approval-card';
import { listFaces } from '@/lib/shared/approval-evidence';

const KIND: Record<NeedsYouRow['kind'], string> = { approval: 'Approval', form: 'Form', question: 'Question', gate: 'Checks failed', check: 'Check failed' };

/** Waits for a person and failed checks nobody settled, newest first; each opens the run. */
export function NeedsYouList() {
  const { items } = useNeedsYou();
  if (!items?.length) return null;
  // The new look: who has something for you, across the runs (a dot on each member that waits).
  const faces = listFaces(items.filter((i) => i.member || i.actor?.type === 'agent'));
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

/** Running executions with who is working now, from their journal. */
export function LiveRuns({ executions }: { executions: ExecutionSummary[] }) {
  const running = executions.filter((e) => e.status === 'running').slice(0, 5);
  if (!running.length) return null;
  // Each run as a timeline, the member at work on its step (docs/run-trace.md#a-run-as-a-timeline).
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
}
