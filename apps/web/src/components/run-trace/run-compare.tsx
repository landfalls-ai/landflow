'use client';
/**
 * Two runs side by side (`GET /api/runs/compare`): a card per run with its numbers, side by side on a wide screen and
 * stacked on a phone, then a card per actor with both runs' numbers and what changed.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/client/api';
import { duration, timeAgo } from '@/lib/client/format';
import { formatCost } from '@/lib/shared/ai-usage';
import type { RunComparison, RunDigest, ActorDiff } from '@/lib/shared/run-compare';
import { cn } from '@/lib/utils';
import { Badge, executionTone } from '../ui/badge';
import { EmptyState } from '../ui/empty-state';

const n = (value: number) => value.toLocaleString('en-US');
const signed = (value: number, show: (v: number) => string = n) => (value === 0 ? 'same' : `${value > 0 ? '+' : '−'}${show(Math.abs(value))}`);

/** Higher is worse for every number here: a rise is red, a drop green. */
function Delta({ value, show }: { value: number; show?: (v: number) => string }) {
  return <span className={cn('text-[11.5px] tabular-nums', value > 0 ? 'text-rd' : value < 0 ? 'text-gn' : 'text-t3')}>{signed(value, show)}</span>;
}

function Row({ label, value, delta, show }: { label: string; value: string; delta?: number; show?: (v: number) => string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-[12.5px] text-t3">{label}</dt>
      <dd className="flex items-baseline gap-2 text-right text-[13.5px] font-medium tabular-nums text-t1">
        {value}
        {delta !== undefined && <Delta value={delta} show={show} />}
      </dd>
    </div>
  );
}

function RunCard({ title, run, other, delta }: { title: string; run: RunDigest; other?: RunDigest; delta: boolean }) {
  const d = (mine: number, theirs?: number) => (delta && theirs !== undefined ? mine - theirs : undefined);
  return (
    <section className="min-w-0 rounded-2xl border border-hair bg-sf px-4 py-3.5" aria-label={title}>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{title}</span>
        <Badge tone={executionTone(run.status as never)}>{run.status}</Badge>
      </div>
      <Link href={`/runs/${run.executionId}`} className="mt-1 block truncate text-[15px] font-semibold text-t1 hover:underline">
        {run.workflowName ?? run.executionId}
      </Link>
      <p className="text-[12px] text-t3">{run.startedAt ? timeAgo(run.startedAt) : ''}</p>
      <dl className="mt-2 divide-y divide-hair">
        <Row label="Duration" value={duration(run.durationMs)} delta={d(run.durationMs, other?.durationMs)} show={(v) => duration(v)} />
        <Row label="Tokens in" value={n(run.tokensIn)} delta={d(run.tokensIn, other?.tokensIn)} />
        <Row label="Tokens out" value={n(run.tokensOut)} delta={d(run.tokensOut, other?.tokensOut)} />
        <Row label="Cost" value={run.costUsd !== undefined ? formatCost(run.costUsd) : '—'} delta={run.costUsd !== undefined && other?.costUsd !== undefined && delta ? run.costUsd - other.costUsd : undefined} show={formatCost} />
        <Row label="Model calls" value={n(run.modelCalls)} delta={d(run.modelCalls, other?.modelCalls)} />
        <Row label="Steps" value={n(run.steps)} delta={d(run.steps, other?.steps)} />
        <Row label="Failed steps" value={n(run.failedSteps)} delta={d(run.failedSteps, other?.failedSteps)} />
        <Row label="Checks" value={`${run.checks.pass} passed · ${run.checks.fail} failed · ${run.checks.warn} warn`} />
        <Row label="Artifacts" value={n(run.artifacts.length)} delta={d(run.artifacts.length, other?.artifacts.length)} />
      </dl>
      {run.failedChecks.length > 0 && <p className="mt-2 text-[12.5px] text-rd">Failed: {run.failedChecks.join(', ')}</p>}
      {run.artifacts.length > 0 && <p className="mt-1 line-clamp-2 text-[12.5px] text-t2">{run.artifacts.map((a) => a.name).join(' · ')}</p>}
    </section>
  );
}

function ActorCard({ diff }: { diff: ActorDiff }) {
  const cell = (side: 'a' | 'b') => {
    const x = diff[side];
    return x ? (
      <p className="text-[12.5px] tabular-nums text-t2">
        {x.steps} steps{x.failedSteps ? <span className="text-rd"> ({x.failedSteps} failed)</span> : null} · {n(x.tokensIn)} in · {n(x.tokensOut)} out
        {x.modelCalls ? ` · ${x.modelCalls} calls` : ''}
      </p>
    ) : (
      <p className="text-[12.5px] text-t3">Did not take part</p>
    );
  };
  return (
    <li className="rounded-2xl border border-hair bg-sf px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2">
        <span className="truncate text-[14px] font-semibold text-t1">{diff.name}</span>
        <span className="text-[11.5px] text-t3">{diff.type}</span>
        <span className="ml-auto flex gap-2">
          <Delta value={diff.delta.steps} show={(v) => `${v} steps`} />
          <Delta value={diff.delta.tokensIn + diff.delta.tokensOut} show={(v) => `${n(v)} tokens`} />
        </span>
      </div>
      <div className="mt-1.5 grid gap-x-4 gap-y-1 md:grid-cols-2">
        <div>
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">First</span>
          {cell('a')}
        </div>
        <div>
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Second</span>
          {cell('b')}
        </div>
      </div>
    </li>
  );
}

export function RunCompare({ a, b }: { a: string; b: string }) {
  const [data, setData] = useState<RunComparison>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!a || !b) return;
    let current = true;
    setData(undefined);
    setError(undefined);
    api<RunComparison>(`/api/runs/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`)
      .then((r) => current && setData(r))
      .catch((e: Error) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [a, b]);

  if (!a || !b) return <EmptyState title="Pick two runs" hint="Choose two runs in the search and press Compare." />;
  if (error) return <p className="m-4 rounded-xl border border-rdbd bg-rddim px-3 py-2 text-[13px] text-rd">{error}</p>;
  if (!data) return <p className="p-6 text-center text-[13px] text-t3">Comparing…</p>;
  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-4 px-4 py-4">
      <div className="grid gap-3 md:grid-cols-2">
        <RunCard title="First" run={data.a} delta={false} />
        <RunCard title="Second" run={data.b} other={data.a} delta />
      </div>
      <section aria-label="Actors">
        <h2 className="mb-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Actors · {data.actors.length}</h2>
        <ul className="grid gap-2">
          {data.actors.map((diff) => (
            <ActorCard key={diff.id} diff={diff} />
          ))}
        </ul>
      </section>
    </div>
  );
}
