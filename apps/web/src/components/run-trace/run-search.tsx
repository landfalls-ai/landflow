'use client';
/**
 * Runs → Search: filter the saved runs (`GET /api/runs/search`), one column of cards that open the run, a Compare action
 * that takes two of them, and the trend of the chosen workflow's runs (`GET /api/runs/measures`). Phone first: the
 * filters stack, the cards are tap targets, nothing is a wide table.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { GitCompareArrows, Search } from 'lucide-react';
import { api } from '@/lib/client/api';
import { duration, timeAgo } from '@/lib/client/format';
import type { RunMeasure } from '@/lib/shared/run-compare';
import type { RunSearchHit, RunSearchResult } from '@/lib/server/journal/runs-query';
import { cn } from '@/lib/utils';
import { Badge, executionTone } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { FieldLabel, Input, Select } from '../ui/inputs';
import { TrendChart } from './trend-chart';
import { PhoneFilters } from '@/components/ui/phone-filters';

interface Filters {
  text: string;
  workflowId: string;
  actor: string;
  tool: string;
  status: string;
  failedSteps: boolean;
  failedCheck: boolean;
  checkName: string;
  from: string;
  to: string;
}

const EMPTY: Filters = { text: '', workflowId: '', actor: '', tool: '', status: '', failedSteps: false, failedCheck: false, checkName: '', from: '', to: '' };
const PAGE = 20;
const STATUSES = ['success', 'error', 'waiting', 'canceled'];

function query(f: Filters, offset: number) {
  const q = new URLSearchParams();
  for (const key of ['text', 'workflowId', 'actor', 'tool', 'status', 'from', 'to'] as const) if (f[key].trim()) q.set(key, f[key].trim());
  if (f.failedSteps) q.set('failedSteps', 'true');
  if (f.failedCheck) q.set('failedCheck', f.checkName.trim());
  q.set('limit', String(PAGE));
  if (offset) q.set('offset', String(offset));
  return q.toString();
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-[13px] text-t1">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-[var(--ac)]" />
      {label}
    </label>
  );
}

function HitCard({ hit, picked, onPick }: { hit: RunSearchHit; picked: boolean; onPick: () => void }) {
  return (
    <li className={cn('flex items-stretch overflow-hidden rounded-2xl border bg-sf', picked ? 'border-ac' : 'border-hair')}>
      <button type="button" onClick={onPick} aria-pressed={picked} aria-label={`Pick ${hit.workflowName} ${timeAgo(hit.startedAt)} to compare`} className="flex w-12 shrink-0 items-center justify-center hover:bg-acdim">
        <span className={cn('flex size-5 items-center justify-center rounded-md border text-[11px] font-bold', picked ? 'border-ac bg-ac text-on-ac' : 'border-bd')}>{picked ? '✓' : ''}</span>
      </button>
      <Link href={`/runs/${hit.executionId}`} className="min-w-0 flex-1 py-3 pr-4 hover:bg-acdim/50">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge tone={executionTone(hit.status as never)}>{hit.status}</Badge>
          <span className="truncate text-[14px] font-semibold text-t1">{hit.workflowName}</span>
        </div>
        <p className="mt-0.5 text-[12px] text-t3">
          {timeAgo(hit.startedAt)} · {duration(hit.durationMs)}
          {hit.failedSteps ? <span className="text-rd"> · {hit.failedSteps} failed step{hit.failedSteps > 1 ? 's' : ''}</span> : null}
          {hit.failedChecks?.length ? <span className="text-rd"> · failed: {hit.failedChecks.join(', ')}</span> : null}
        </p>
        {hit.matches.map((match) => (
          <p key={match} className="mt-1 line-clamp-2 break-words text-[12.5px] text-t2">
            {match}
          </p>
        ))}
      </Link>
    </li>
  );
}

export function RunSearch({ initialWorkflowId = '' }: { initialWorkflowId?: string }) {
  const router = useRouter();
  const [filters, setFilters] = useState<Filters>({ ...EMPTY, workflowId: initialWorkflowId });
  const [workflows, setWorkflows] = useState<Array<{ id: string; name: string }>>([]);
  const [result, setResult] = useState<{ items: RunSearchHit[]; more: boolean; truncated?: boolean }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [picked, setPicked] = useState<string[]>([]);
  const [trend, setTrend] = useState<RunMeasure[]>();
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((f) => ({ ...f, [key]: value }));

  useEffect(() => {
    api<{ workflows: Array<{ id: string; name: string }> }>('/api/workflows')
      .then((r) => setWorkflows(r.workflows.map((w) => ({ id: w.id, name: w.name }))))
      .catch(() => {});
  }, []);

  const run = useCallback(
    async (f: Filters, offset = 0) => {
      setBusy(true);
      setError(undefined);
      try {
        const page = await api<RunSearchResult>(`/api/runs/search?${query(f, offset)}`);
        setResult((current) => (offset && current ? { ...page, items: [...current.items, ...page.items] } : page));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [],
  );
  useEffect(() => {
    void run({ ...EMPTY, workflowId: initialWorkflowId });
  }, [run, initialWorkflowId]);

  // The chosen workflow's runs over time.
  useEffect(() => {
    if (!filters.workflowId) return setTrend(undefined);
    let current = true;
    api<{ runs: RunMeasure[] }>(`/api/runs/measures?workflowId=${encodeURIComponent(filters.workflowId)}`)
      .then((r) => current && setTrend(r.runs))
      .catch(() => current && setTrend(undefined));
    return () => {
      current = false;
    };
  }, [filters.workflowId]);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]));

  return (
    <div className="mx-auto w-full max-w-[760px] px-4 py-4 pb-28">
      <form
        className="space-y-3 rounded-2xl border border-hair bg-sf p-4"
        onSubmit={(e) => {
          e.preventDefault();
          setPicked([]);
          void run(filters);
        }}
      >
        <div>
          <FieldLabel>Words</FieldLabel>
          <Input value={filters.text} onChange={(e) => set('text', e.target.value)} placeholder="A name, a message, an output…" className="h-11" />
        </div>
        {/* A phone: the rest in a Filters sheet, so the results start on the first screen (desktop: in place). */}
        <PhoneFilters
          active={(['workflowId', 'status', 'actor', 'tool', 'from', 'to'] as const).filter((key) => filters[key].trim()).length + (filters.failedSteps ? 1 : 0) + (filters.failedCheck ? 1 : 0)}
          onClear={() => setFilters({ ...EMPTY, text: filters.text })}
          onApply={() => {
            setPicked([]);
            void run(filters);
          }}
          className="max-md:w-full max-md:justify-center"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <FieldLabel>Workflow</FieldLabel>
              <Select value={filters.workflowId} onChange={(e) => set('workflowId', e.target.value)} className="h-11">
                <option value="">Any workflow</option>
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <FieldLabel>Status</FieldLabel>
              <Select value={filters.status} onChange={(e) => set('status', e.target.value)} className="h-11">
                <option value="">Any status</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <FieldLabel>Agent or actor</FieldLabel>
              <Input value={filters.actor} onChange={(e) => set('actor', e.target.value)} placeholder="Developer" className="h-11" />
            </div>
            <div>
              <FieldLabel>Tool</FieldLabel>
              <Input value={filters.tool} onChange={(e) => set('tool', e.target.value)} placeholder="Bash" className="h-11" />
            </div>
            <div>
              <FieldLabel>From</FieldLabel>
              <Input type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} className="h-11" />
            </div>
            <div>
              <FieldLabel>To</FieldLabel>
              <Input type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} className="h-11" />
            </div>
          </div>
          <div className="flex flex-wrap gap-x-6">
            <Check label="Has failed steps" checked={filters.failedSteps} onChange={(v) => set('failedSteps', v)} />
            <Check label="A check failed" checked={filters.failedCheck} onChange={(v) => set('failedCheck', v)} />
          </div>
          {filters.failedCheck && <Input value={filters.checkName} onChange={(e) => set('checkName', e.target.value)} placeholder="Which check (leave empty for any)" className="h-11" />}
        </PhoneFilters>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={busy} className="h-11 flex-1">
            <Search className="size-4" /> Search
          </Button>
          <Button
            type="button"
            className="h-11"
            onClick={() => {
              setFilters(EMPTY);
              setPicked([]);
              void run(EMPTY);
            }}
          >
            Clear
          </Button>
        </div>
      </form>

      {trend && trend.length > 0 && (
        <section aria-label="Over time" className="mt-4">
          <h2 className="mb-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Over time · {trend.length} runs</h2>
          <TrendChart runs={trend} />
        </section>
      )}

      <section aria-label="Results" className="mt-4">
        <h2 className="mb-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{result ? `${result.items.length}${result.more ? '+' : ''} runs` : 'Runs'}</h2>
        {error && <p className="rounded-xl border border-rdbd bg-rddim px-3 py-2 text-[13px] text-rd">{error}</p>}
        {result && result.items.length === 0 && <EmptyState title="No runs match" hint="Loosen a filter. Only runs with a journal match words, actors, tools and checks." />}
        <ul className="space-y-2">
          {result?.items.map((hit) => (
            <HitCard key={hit.executionId} hit={hit} picked={picked.includes(hit.executionId)} onPick={() => toggle(hit.executionId)} />
          ))}
        </ul>
        {result?.truncated && <p className="mt-2 text-[12px] text-t3">The search stopped after the most runs it reads at once. Narrow it by workflow or date.</p>}
        {result?.more && (
          <Button className="mt-3 h-11 w-full" loading={busy} onClick={() => void run(filters, result.items.length)}>
            Show more
          </Button>
        )}
      </section>

      {picked.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-hair bg-bg/95 px-4 py-3 backdrop-blur" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
          <div className="mx-auto flex max-w-[760px] items-center gap-3">
            <p className="min-w-0 flex-1 text-[13px] text-t2">{picked.length === 1 ? 'Pick one more run to compare' : '2 runs picked'}</p>
            <Button variant="primary" className="h-11" disabled={picked.length < 2} onClick={() => router.push(`/runs/compare?a=${encodeURIComponent(picked[0])}&b=${encodeURIComponent(picked[1])}`)}>
              <GitCompareArrows className="size-4" /> Compare
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
