'use client';
/**
 * What a run did, in one line (docs/run-trace.md#what-a-run-did-in-one-line), drawn in the new look: what came in, who did
 * it (the agent's face, or the team's lead with the faces of the members who worked under it), and what came out, green
 * when done, amber when it waits for you, red when it failed. A tap on the result opens it (a pull request on GitHub);
 * the rest of the row opens the run's Story.
 */
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Calendar, Check, ExternalLink, FileText, GitPullRequest, Globe, Hourglass, Mail, MessageSquare, Play, Workflow, X, Zap } from 'lucide-react';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { useLiveEvents } from '@/lib/client/live';
import type { RunLine as Line } from '@/lib/shared/run-line';
import { safeUrl } from '@/lib/shared/artifact-kinds';
import { fmtMs } from '@/lib/shared/run-trace-model';
import { cn } from '@/lib/utils';
import { Avatar } from './parts';

const IN_ICON = { manual: Play, schedule: Calendar, webhook: Zap, form: FileText, chat: MessageSquare, pull_request: GitPullRequest, email: Mail, other: Workflow } as const;

const OUT_TONE = {
  ok: { box: 'border-gnbd bg-gndim', text: 'text-gn', Icon: Check },
  live: { box: 'border-hair bg-sf2', text: 'text-t1', Icon: undefined },
  warn: { box: 'border-warnbd bg-warndim', text: 'text-warn', Icon: Hourglass },
  bad: { box: 'border-rdbd bg-rddim', text: 'text-rd', Icon: X },
} as const;

const tokensText = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k tokens` : n ? `${n} tokens` : '');

function Faces({ by }: { by: Line['by'] }) {
  const shown = by.members.slice(0, 3);
  return (
    <div className="flex min-w-0 flex-col items-center gap-1">
      <div className="flex items-end">
        {by.lead ? (
          <Avatar actor={by.lead} size={34} />
        ) : (
          <span className="grid size-[34px] place-items-center rounded-xl border border-hair bg-sf2 text-t2">
            <Workflow className="size-4" />
          </span>
        )}
        {shown.length > 0 && (
          <span className="-ml-2 flex">
            {shown.map((m, i) => (
              <span key={m.id} className={cn('rounded-full ring-2 ring-sf', i > 0 && '-ml-1.5')}>
                <Avatar actor={m} size={18} />
              </span>
            ))}
          </span>
        )}
      </div>
      <span className="w-full truncate text-center text-[11.5px] font-medium text-t1">{by.lead?.name ?? 'The flow'}</span>
      {by.team && <span className="-mt-1 w-full truncate text-center text-[10.5px] text-t3">{by.team}</span>}
    </div>
  );
}

/** One run as in → who → out, with the time it took and when. */
export function RunLineRow({ line, href, onOpen, startedAt, className }: { line: Line; href?: string; onOpen?: () => void; startedAt?: string; className?: string }) {
  const InIcon = IN_ICON[line.in.kind] ?? Workflow;
  const tone = OUT_TONE[line.out.tone];
  const url = safeUrl(line.out.url);
  const OutIcon = /pull_request/i.test(line.out.kind ?? '') ? GitPullRequest : tone.Icon;
  return (
    <div className={cn('relative rounded-2xl border border-hair bg-sf p-3 transition-colors hover:bg-acdim/30', className)}>
      {href ? (
        <Link href={href} className="absolute inset-0 rounded-2xl" aria-label={`Open the run: ${line.in.label} to ${line.out.label}`} />
      ) : onOpen ? (
        <button type="button" onClick={onOpen} className="absolute inset-0 rounded-2xl" aria-label={`Open the Story: ${line.in.label} to ${line.out.label}`} />
      ) : null}
      <div className="pointer-events-none relative grid grid-cols-[minmax(0,1fr)_14px_minmax(0,0.9fr)_14px_minmax(0,1.1fr)] items-center gap-1.5">
        <div className="flex min-w-0 flex-col items-start gap-1">
          <span className="grid size-[30px] place-items-center rounded-lg border border-hair bg-sf2 text-t2">
            <InIcon className="size-4" />
          </span>
          <span className="w-full truncate text-[12px] font-semibold text-t1">{line.in.label}</span>
          {line.in.detail && <span className="-mt-1 w-full truncate text-[11px] text-t3">{line.in.detail}</span>}
        </div>
        <ArrowRight className="size-3.5 text-t3" aria-hidden />
        <Faces by={line.by} />
        <ArrowRight className="size-3.5 text-t3" aria-hidden />
        <div className={cn('flex min-w-0 flex-col gap-0.5 rounded-xl border px-2 py-1.5', tone.box)}>
          <span className={cn('flex min-w-0 items-center gap-1 text-[12px] font-semibold', tone.text)}>
            {OutIcon ? <OutIcon className="size-3.5 shrink-0" strokeWidth={2.5} /> : <span className="size-1.5 shrink-0 rounded-full bg-warn animate-pulse-soft" />}
            <span className="truncate">{line.out.label}</span>
          </span>
          {line.out.detail && <span className="truncate text-[11px] text-t2">{line.out.detail}</span>}
          {url && (
            <a href={url} target="_blank" rel="noreferrer noopener" className="pointer-events-auto relative inline-flex w-fit items-center gap-0.5 text-[11px] font-medium text-t1 hover:underline">
              Open <ExternalLink className="size-2.5" />
            </a>
          )}
        </div>
      </div>
      <p className="pointer-events-none relative mt-2 truncate text-[11.5px] text-t3">
        {[line.ms ? fmtMs(line.ms) : '', tokensText(line.tokens), startedAt ? timeAgo(startedAt) : ''].filter(Boolean).join(' · ')}
      </p>
    </div>
  );
}

/** The lines of some runs (`GET /api/runs/lines`), read again when one of them changes. */
export function useRunLines(ids: string[]): Record<string, Line> | undefined {
  const key = ids.join(',');
  const [lines, setLines] = useState<Record<string, Line>>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!key) {
      setLines({});
      return;
    }
    let gone = false;
    api<{ lines: Record<string, Line> }>(`/api/runs/lines?ids=${encodeURIComponent(key)}`)
      .then((r) => !gone && setLines(r.lines))
      .catch(() => !gone && setLines((prev) => prev ?? {}));
    return () => {
      gone = true;
    };
  }, [key, tick]);
  const watched = useMemo(() => new Set(ids), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useLiveEvents((event) => {
    // A run that starts, waits or ends changes its line.
    if (event.channel === 'execution' && event.event.type.startsWith('execution.') && watched.has(event.event.executionId)) setTick((n) => n + 1);
  });
  return lines;
}

/** Runs as lines, each from `GET /api/runs/lines`; a run without a journal yet shows its name until its line comes. */
export function RunLines({ runs, empty }: { runs: Array<{ id: string; href: string; name: string; startedAt?: string }>; empty?: React.ReactNode }) {
  const lines = useRunLines(runs.map((r) => r.id));
  if (!runs.length) return <>{empty ?? null}</>;
  return (
    <div className="flex flex-col gap-2">
      {runs.map((r) => {
        const line = lines?.[r.id];
        return line ? (
          <RunLineRow key={r.id} line={line} href={r.href} startedAt={r.startedAt} className="animate-in" />
        ) : (
          <Link key={r.id} href={r.href} className="flex items-center gap-3 rounded-2xl border border-hair bg-sf p-3 hover:bg-acdim/30">
            <span className={cn('size-[30px] shrink-0 rounded-lg bg-acdim', !lines && 'animate-pulse-soft')} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-t1">{r.name}</span>
            {r.startedAt && <span className="text-[11.5px] text-t3">{timeAgo(r.startedAt)}</span>}
          </Link>
        );
      })}
    </div>
  );
}

/** The last runs an agent took part in (`GET /api/runs/search?actor=`), as lines: the agent page's Sessions tab. */
export function AgentLastRuns({ agentName, limit = 3 }: { agentName: string; limit?: number }) {
  const [runs, setRuns] = useState<Array<{ id: string; href: string; name: string; startedAt?: string }>>();
  useEffect(() => {
    let gone = false;
    api<{ items: Array<{ executionId: string; workflowId: string; workflowName: string; startedAt: string }> }>(`/api/runs/search?actor=${encodeURIComponent(agentName)}&limit=${limit}`)
      .then((r) => !gone && setRuns(r.items.map((i) => ({ id: i.executionId, href: `/runs/${i.executionId}`, name: i.workflowName, startedAt: i.startedAt }))))
      .catch(() => !gone && setRuns([]));
    return () => {
      gone = true;
    };
  }, [agentName, limit]);
  if (!runs?.length) return null;
  return (
    <section aria-label="Last runs" className="mb-5">
      <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-t3">Last runs</h2>
      <RunLines runs={runs} />
    </section>
  );
}
