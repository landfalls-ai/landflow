'use client';
/**
 * The AI page's drill-down (docs/llm-gateway.md, "The AI page"): a sheet opened from a group row that lists the runs
 * behind the number (`GET /api/insights/ai/runs`) and the calls (`.../calls`), says what the viewer can't open as a
 * count and a sum (never a name), opens a run's Spend tab, opens one call's composition in the sheet, and downloads
 * the list as CSV. Numbers, names and hashes only: no prompt text is stored for spend.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download } from 'lucide-react';
import { api } from '@/lib/client/api';
import { drillQuery, hiddenLine, momentLabel, totalTokens, type AiView, type FilterChip } from '@/lib/client/ai-console';
import { useAiCall } from '@/lib/client/call-spend';
import { CALL_PURPOSE_LABELS } from '@/lib/shared/ai-call';
import { formatCost, formatTokens } from '@/lib/shared/ai-usage';
import type { AiSpendCall, AiSpendCallsPage, AiSpendGroup, AiSpendHidden, AiSpendRun, AiSpendRunsPage } from '@/lib/shared/ai-spend';
import { CallSpendView } from '@/components/run-trace/call-spend';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

type Tab = 'runs' | 'calls';
export interface DrillTarget {
  group: AiSpendGroup;
  key: string;
}

interface Listed<T> {
  items: T[];
  hidden?: AiSpendHidden;
  next?: string;
  loading: boolean;
  error?: string;
}

/** The pages of one list, newest request wins; "more" asks the next page with the server's cursor. */
function useSpendList<T>(tab: Tab, view: AiView, target: DrillTarget, enabled: boolean) {
  const [state, setState] = useState<Listed<T>>({ items: [], loading: true });
  const query = drillQuery(view, target, tab === 'runs' ? { order: 'cost' } : {}).toString();
  const read = useCallback(
    (cursor?: string) => {
      const path = `/api/insights/ai/${tab}?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      return api<{ runs?: T[]; calls?: T[]; hidden: AiSpendHidden; next?: string }>(path, { background: true });
    },
    [tab, query],
  );
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setState({ items: [], loading: true });
    read()
      .then((page) => alive && setState({ items: (tab === 'runs' ? page.runs : page.calls) ?? [], hidden: page.hidden, next: page.next, loading: false }))
      .catch((e: Error) => alive && setState({ items: [], loading: false, error: e.message }));
    return () => {
      alive = false;
    };
  }, [read, enabled, tab]);
  const current = useRef(`${tab}?${query}`);
  current.current = `${tab}?${query}`;
  const more = () => {
    const cursor = state.next;
    if (!cursor) return;
    const key = current.current;
    setState((s) => ({ ...s, loading: true }));
    read(cursor)
      .then((page) => key === current.current && setState((s) => ({ items: [...s.items, ...((tab === 'runs' ? page.runs : page.calls) ?? [])], hidden: page.hidden, next: page.next, loading: false })))
      .catch((e: Error) => key === current.current && setState((s) => ({ ...s, loading: false, error: e.message })));
  };
  return { ...state, more, query };
}

const when = momentLabel;

export function HiddenNote({ hidden }: { hidden?: AiSpendHidden }) {
  const line = hidden && hiddenLine(hidden);
  return line ? (
    <p className="rounded-lg border border-hair bg-sf2 px-3 py-2 text-[12px] text-t2" data-testid="drill-hidden">
      {line}
    </p>
  ) : null;
}

export function FilterChips({ chips }: { chips: FilterChip[] }) {
  if (chips.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Filters">
      {chips.map((chip) => (
        <li key={chip.key} className="inline-flex max-w-full items-center gap-1 rounded-full border border-hair bg-sf2 px-2.5 py-0.5 text-[12px] text-t2">
          <span className="text-t3">{chip.label}</span>
          <span className="truncate text-t1">{chip.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** The runs, as the sheet draws them (also what the tests render). */
export function DrillRuns({ runs, hidden }: { runs: AiSpendRun[]; hidden?: AiSpendHidden }) {
  return (
    <div className="flex flex-col gap-2.5" data-testid="drill-runs">
      <HiddenNote hidden={hidden} />
      {runs.length === 0 ? (
        <p className="text-[13px] text-t3">No runs you can open behind this number.</p>
      ) : (
        <ul className="divide-y divide-hair rounded-xl border border-hair">
          {runs.map((run) => {
            const id = run.executionId ?? run.sessionId ?? run.at;
            const body = (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-t1">{run.label}</span>
                  <span className="block text-[12px] text-t3">
                    {when(run.at)} · {run.calls.toLocaleString('en-US')} call{run.calls === 1 ? '' : 's'} · {formatTokens(totalTokens(run))} tokens
                  </span>
                </span>
                <span className="shrink-0 text-[13px] font-semibold tabular-nums text-t1">{formatCost(run.cost)}</span>
              </>
            );
            return (
              <li key={id}>
                {run.href ? (
                  <Link href={run.href} className="flex min-h-11 items-center gap-3 px-3 py-2 hover:bg-acdim" title="Open its Spend tab">
                    {body}
                  </Link>
                ) : (
                  <div className="flex min-h-11 items-center gap-3 px-3 py-2">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The calls; a row with a call id opens it. */
export function DrillCalls({ calls, hidden, onOpen }: { calls: AiSpendCall[]; hidden?: AiSpendHidden; onOpen?: (call: AiSpendCall) => void }) {
  return (
    <div className="flex flex-col gap-2.5" data-testid="drill-calls">
      <HiddenNote hidden={hidden} />
      {calls.length === 0 ? (
        <p className="text-[13px] text-t3">No calls you can open behind this number.</p>
      ) : (
        <ul className="divide-y divide-hair rounded-xl border border-hair">
          {calls.map((call) => (
            <li key={call.usageId}>
              <button type="button" onClick={() => onOpen?.(call)} className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left hover:bg-acdim">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-t1">
                    {call.model}
                    {call.purpose && <span className="ml-1.5 text-[12px] font-normal text-t3">{CALL_PURPOSE_LABELS[call.purpose]}</span>}
                  </span>
                  <span className="block text-[12px] text-t3">
                    {when(call.at)} · {formatTokens(call.inputTokens)} in · {formatTokens(call.outputTokens)} out
                  </span>
                </span>
                <span className="shrink-0 text-[13px] font-semibold tabular-nums text-t1">{call.priced ? formatCost(call.cost) : 'not priced'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OpenCall({ call, onBack }: { call: AiSpendCall; onBack: () => void }) {
  const view = useAiCall(call.usageId);
  return (
    <div className="flex flex-col gap-2" data-testid="drill-call">
      <button type="button" onClick={onBack} className="inline-flex min-h-9 w-fit items-center gap-1.5 text-[13px] text-t2 hover:text-t1">
        <ArrowLeft className="size-4" /> Back to the calls
      </button>
      <p className="text-[13px] text-t1">
        <span className="font-medium">{call.model}</span> · {when(call.at)} · {call.priced ? formatCost(call.cost) : 'not priced'}
      </p>
      {call.runHref && (
        <Link href={call.runHref} className="w-fit text-[13px] text-ac underline decoration-dotted hover:decoration-solid">
          Open its run
        </Link>
      )}
      {view.loading ? <div className="h-16 animate-pulse-soft rounded-xl bg-acdim" /> : view.error ? <p className="text-[13px] text-rd">Couldn’t read this call. {view.error}</p> : view.data ? <CallSpendView view={view.data} /> : null}
    </div>
  );
}

export function AiDrill({ view, target, title, chips, onClose }: { view: AiView; target?: DrillTarget; title: string; chips: FilterChip[]; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('runs');
  const [call, setCall] = useState<AiSpendCall>();
  const key = target ? `${target.group}:${target.key}` : '';
  useEffect(() => {
    setTab('runs');
    setCall(undefined);
  }, [key]);
  const fallback: DrillTarget = target ?? { group: 'project', key: '' };
  const runs = useSpendList<AiSpendRun>('runs', view, fallback, Boolean(target) && tab === 'runs');
  const calls = useSpendList<AiSpendCall>('calls', view, fallback, Boolean(target) && tab === 'calls');
  const list = tab === 'runs' ? runs : calls;
  const csv = `/api/insights/ai/${tab}?${list.query}&format=csv`;
  return (
    <Sheet open={Boolean(target)} onClose={onClose} title={title} className="md:max-w-[640px]">
      <div className="flex flex-col gap-3">
        <FilterChips chips={chips} />
        {!call && (
          <div className="flex flex-wrap items-center gap-2">
            <Segmented size="sm" label="Show" value={tab} onChange={setTab} options={[{ value: 'runs', label: 'Runs' }, { value: 'calls', label: 'Calls' }]} />
            <a href={csv} download className={cn('ml-auto inline-flex h-8 items-center gap-1.5 rounded-full border border-hair px-3 text-[12px] text-t2 hover:border-ac hover:text-t1')}>
              <Download className="size-3.5" /> Download CSV
            </a>
          </div>
        )}
        {call ? (
          <OpenCall call={call} onBack={() => setCall(undefined)} />
        ) : list.error ? (
          <p className="text-[13px] text-rd">Couldn’t read the list. {list.error}</p>
        ) : list.loading && list.items.length === 0 ? (
          <div className="h-24 animate-pulse-soft rounded-xl bg-acdim" />
        ) : tab === 'runs' ? (
          <DrillRuns runs={runs.items} hidden={runs.hidden} />
        ) : (
          <DrillCalls calls={calls.items} hidden={calls.hidden} onOpen={setCall} />
        )}
        {!call && list.next && (
          <Button variant="outline" size="sm" onClick={list.more} loading={list.loading}>
            Show more
          </Button>
        )}
      </div>
    </Sheet>
  );
}
