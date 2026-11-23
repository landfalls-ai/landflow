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
import { BudgetActions, SpendActions, TaskActions, TrustActions } from './needs-you-actions';
import { NeedFaces } from './approval-card';
import { listFaces } from '@/lib/shared/approval-evidence';
import { isInboxItem, rowOfItem, useRowStates, withDecided } from '@/lib/client/approval-inbox'; // AP03:
import { InboxRow } from '../home/approval-inbox'; // AP03:

const KIND: Record<NeedsYouRow['kind'], string> = { approval: 'Approval', form: 'Form', question: 'Question', gate: 'Checks failed', check: 'Check failed', budget: 'AI budget', task: 'Task', spend: 'AI spend', trust: 'MCP tools' }; // C27: trust

/** AP03: the inbox items just decided that the list already lost, put back where they were (their row says what happened). */
function withDecidedItems(list: NeedsYouRow[], states: Parameters<typeof withDecided>[1]): NeedsYouRow[] {
  const ids = list.filter(isInboxItem).map((i) => i.requestId);
  const ghosts = withDecided(list.filter(isInboxItem).map(rowOfItem), states).filter((r) => !ids.includes(r.id));
  if (!ghosts.length) return list;
  const out = [...list];
  for (const g of ghosts) {
    const index = Math.min(states.get(g.id)?.index ?? out.length, out.length);
    out.splice(index, 0, { executionId: g.executionId, workflowId: '', workflowName: g.workflowName, kind: 'approval', title: g.tool, since: g.requestedAt, requestId: g.id, tool: g.tool, agentName: g.agentName, agentVersion: g.agentVersion, workflowVersion: g.workflowVersion, destination: g.destination, expiresAt: g.expiresAt, canDecide: g.canDecide });
  }
  return out;
}

/** Waits for a person and failed checks nobody settled, newest first; each opens the run. */
export function NeedsYouList() {
  const { items: listed, refresh } = useNeedsYou();
  const decided = useRowStates(); // AP03: a request just decided stays in its place for a few seconds
  const items = listed && withDecidedItems(listed, decided); // AP03:
  if (!items?.length) return null;
  // Who has something for you, across the runs (a dot on each member that waits).
  const faces = listFaces(items.filter((i) => i.member || i.actor?.type === 'agent'));
  return (
    <section aria-label="Needs you">
      <SectionTitle>Needs you · {items.length}</SectionTitle>
      {faces.length > 0 && <NeedFaces faces={faces} className="mb-2 px-1" />}
      <ul className="divide-y divide-hair overflow-hidden rounded-2xl border border-warnbd bg-warndim">
        {items.map((item, index) =>
          isInboxItem(item) /* AP03: */ ? (
            <InboxRow key={`inbox:${item.requestId}`} row={rowOfItem(item)} index={index} />
          ) : item.kind === 'budget' ? (
            <BudgetRow key={`budget:${item.incidentId ?? item.title}`} item={item} onDone={refresh} />
          ) : item.kind === 'task' ? (
            <TaskRow key={`task:${item.taskRunId ?? item.title}`} item={item} />
          ) : item.kind === 'spend' ? (
            <SpendRow key={`spend:${item.flagId ?? item.title}`} item={item} />
          ) : item.kind === 'trust' ? (
            <TrustRow key={`trust:${item.agentId ?? item.title}`} item={item} />
          ) : (
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
          ),
        )}
      </ul>
    </section>
  );
}

/** A project's AI budget item: it opens the project, and carries its own buttons. */
export function BudgetRow({ item, onDone }: { item: NeedsYouRow; onDone: () => void }) {
  return (
    <li className="px-4 py-2.5">
      <Link href={item.href ?? '/projects'} className="-mx-2 flex min-h-[56px] items-center gap-3 rounded-xl px-2 hover:bg-acdim/60">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge tone="warning">{KIND.budget}</Badge>
            <span className="truncate text-[12px] text-t3">{timeAgo(item.since)}</span>
          </div>
          <p className="mt-1 text-[14px] font-medium text-t1">{item.title}</p>
          {item.detail && <p className="text-[12.5px] text-t2">{cut(item.detail, 160)}</p>}
        </div>
        <ChevronRight className="size-4 shrink-0 text-t3" />
      </Link>
      <BudgetActions row={item} onDone={onDone} className="mt-2" />
    </li>
  );
}

/** A project task's run that waits for a person (PC20): the title opens the task (or the agent's session), the buttons sit below it, never a run link. */
export function TaskRow({ item }: { item: NeedsYouRow }) {
  return (
    <li className="px-4 py-2.5">
      <Link href={item.href ?? '/projects'} className="-mx-2 flex min-h-[56px] items-center gap-3 rounded-xl px-2 hover:bg-acdim/60">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge tone="warning">{KIND.task}</Badge>
            <span className="truncate text-[12px] text-t3">{timeAgo(item.since)}</span>
          </div>
          <p className="mt-1 text-[14px] font-medium text-t1">{item.title}</p>
          {item.detail && <p className="text-[12.5px] text-t2">{cut(item.detail, 160)}</p>}
        </div>
        <ChevronRight className="size-4 shrink-0 text-t3" />
      </Link>
      <TaskActions row={item} className="mt-2" />
    </li>
  );
}

/** A forecast over a cap or unusual AI spend (SP23): the title opens the AI page at the day, Acknowledge clears it for everyone. */
export function SpendRow({ item }: { item: NeedsYouRow }) {
  return (
    <li className="px-4 py-2.5">
      <Link href={item.href ?? '/insights/ai'} className="-mx-2 flex min-h-[56px] items-center gap-3 rounded-xl px-2 hover:bg-acdim/60">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge tone="warning">{KIND.spend}</Badge>
            <span className="truncate text-[12px] text-t3">{timeAgo(item.since)}</span>
          </div>
          <p className="mt-1 text-[14px] font-medium text-t1">{item.title}</p>
          {item.detail && <p className="text-[12.5px] text-t2">{cut(item.detail, 200)}</p>}
        </div>
        <ChevronRight className="size-4 shrink-0 text-t3" />
      </Link>
      <SpendActions row={item} className="mt-2" />
    </li>
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

/** An agent's MCP tools that a server changed since it was published (C27): the title opens the agent page, Review opens its sheet there. */
export function TrustRow({ item }: { item: NeedsYouRow }) {
  return (
    <li className="px-4 py-2.5">
      <Link href={item.href ?? '/agents'} className="-mx-2 flex min-h-[56px] items-center gap-3 rounded-xl px-2 hover:bg-acdim/60">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge tone="warning">{KIND.trust}</Badge>
            <span className="truncate text-[12px] text-t3">{timeAgo(item.since)}</span>
          </div>
          <p className="mt-1 text-[14px] font-medium text-t1">{item.title}</p>
          {item.detail && <p className="text-[12.5px] text-t2">{cut(item.detail, 160)}</p>}
        </div>
        <ChevronRight className="size-4 shrink-0 text-t3" />
      </Link>
      <TrustActions row={item} className="mt-2" />
    </li>
  );
}
