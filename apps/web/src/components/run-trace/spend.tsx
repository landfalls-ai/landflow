'use client';
/**
 * The Spend tab (wave 12, SP06): what a run cost and where it went. Totals, the same spend by purpose, model, node, agent
 * or step, how well the prompt cache worked, what the prompt was made of (one stacked bar, with how each part was
 * counted) and every model call; a call opens its span. Sizes, counts and names only: the answer holds no prompt text.
 * Desktop first (tables); on a phone it must not scroll sideways, nothing more. Tokens, models and cost are never behind
 * the developer-details switch.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRunSpend, spendRows, cacheSentence, compositionBars, callRows, totalTiles, costOf, UNPRICED, SPEND_BY_LABELS, type SpendBy } from '@/lib/client/run-spend';
import type { RunSpend } from '@/lib/shared/run-spend';
import type { RunModel } from '@/lib/shared/run-trace-model';
import { can } from '@/lib/shared/auth';
import { formatTokens } from '@/lib/shared/ai-usage';
import { useViewer } from '../auth/viewer';
import { EmptyState } from '../ui/empty-state';
import { Segmented } from '../ui/segmented';
import { Card, SectionTitle, clock } from './parts';
import type { Open } from './sheet';

const BYS = Object.keys(SPEND_BY_LABELS) as SpendBy[];
const CALLS_SHOWN = 20;

/** A grey ramp that reads in both themes; the swatches in the legend use the same colours. */
const swatch = (i: number) => `color-mix(in srgb, var(--t1) ${Math.max(14, 80 - i * 11)}%, var(--sf2))`;

export function Spend({ executionId, live, open, model }: { executionId: string; live: boolean; open: (o: Open) => void; model?: Pick<RunModel, 'spans'> }) {
  const { spend, loading, error, retry } = useRunSpend(executionId, live);
  if (!spend && loading)
    return (
      <div className="flex flex-col gap-3" aria-busy>
        {[60, 90, 75].map((w, i) => (
          <div key={i} className="h-12 rounded-2xl bg-acdim animate-pulse-soft" style={{ width: `${w}%`, animationDelay: `${i * 100}ms` }} />
        ))}
      </div>
    );
  if (!spend)
    return (
      <EmptyState
        title="The spend could not be loaded"
        hint={error ?? 'Try again in a moment.'}
        action={
          <button type="button" onClick={retry} className="rounded-lg border border-hair px-3 py-1.5 text-[13px] text-t1 hover:bg-sf2">
            Try again
          </button>
        }
      />
    );
  return <SpendBody spend={spend} open={open} model={model} />;
}

/** The tab's body for a loaded answer (also what the tests render). */
export function SpendBody({ spend, open, model }: { spend: RunSpend; open: (o: Open) => void; model?: Pick<RunModel, 'spans'> }) {
  const viewer = useViewer();
  const admin = viewer ? can(viewer, 'settings:manage') : false;
  const [by, setBy] = useState<SpendBy>('purpose');
  const [all, setAll] = useState(false);
  const rows = useMemo(() => spendRows(spend, by), [spend, by]);
  const cache = cacheSentence(spend.cache);
  const bar = compositionBars(spend.composition);
  const calls = useMemo(() => callRows(spend.calls, model), [spend.calls, model]);
  const shown = all ? calls : calls.slice(-CALLS_SHOWN);
  const t = spend.totals;

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(84px,1fr))] gap-3">
          {totalTiles(t).map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dd className="text-[18px] font-semibold tabular-nums text-t1">{value}</dd>
              <dt className="text-[12px] text-t3">{label}</dt>
            </div>
          ))}
        </dl>
        {t.unpricedCalls > 0 && (
          <p className="mt-2 text-[12px] text-t2">
            {t.unpricedCalls} unpriced call{t.unpricedCalls === 1 ? '' : 's'}: the tokens count, the cost does not.{' '}
            {admin && (
              <Link href="/settings#ai-prices" className="text-ac underline decoration-dotted hover:decoration-solid">
                Set the price in Settings
              </Link>
            )}
          </p>
        )}
        {spend.hidden.runs > 0 && (
          <p className="mt-2 text-[12px] text-t2">
            {spend.hidden.runs} run{spend.hidden.runs === 1 ? '' : 's'} you can’t open
            {spend.hidden.totals.calls > 0 && (
              <>
                :{' '}
                {costOf(spend.hidden.totals) === UNPRICED ? `${formatTokens(spend.hidden.totals.inputTokens)} in · ${formatTokens(spend.hidden.totals.outputTokens)} out` : costOf(spend.hidden.totals)}
              </>
            )}
          </p>
        )}
      </Card>

      <section>
        <SectionTitle aside={<Segmented size="sm" label="Spend by" value={by} onChange={setBy} options={BYS.map((v) => ({ value: v, label: SPEND_BY_LABELS[v] }))} />}>
          Where it went
        </SectionTitle>
        <Card className="overflow-x-auto px-0 py-1">
          {rows.length ? (
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="text-[11px] uppercase tracking-[0.06em] text-t3">
                  <th className="px-3.5 py-1.5 font-semibold">{SPEND_BY_LABELS[by]}</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Calls</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Tokens</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Cached</th>
                  <th className="px-3.5 py-1.5 text-right font-semibold">Cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="border-t border-hair">
                    <td className="max-w-[220px] truncate px-3.5 py-1.5 text-t1" title={r.label}>
                      {r.label}
                      <span className="ml-1.5 text-[11px] text-t3">{r.share}%</span>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-t2">{r.calls}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-t2">{r.tokens}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-t2">{r.cached}</td>
                    <td className={`whitespace-nowrap px-3.5 py-1.5 text-right tabular-nums ${r.unpriced ? 'text-t3' : 'text-t1'}`}>{r.cost}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="px-3.5 py-3 text-[13px] text-t3">{by === 'step' ? 'This run has no agent steps.' : 'Nothing to show here.'}</p>
          )}
        </Card>
      </section>

      <section>
        <SectionTitle>The cache</SectionTitle>
        <Card>
          <p className="text-[13px] text-t1">{cache.line}</p>
          {cache.reasons.length > 0 && <p className="mt-1 text-[12px] text-t2">Misses: {cache.reasons.join('; ')}.</p>}
          {spend.cache.hitRate !== undefined && (
            <p className="mt-1 text-[12px] text-t3">
              {formatTokens(spend.cache.readTokens)} read · {formatTokens(spend.cache.writeTokens)} written
            </p>
          )}
        </Card>
      </section>

      <section>
        <SectionTitle>What the prompt was made of</SectionTitle>
        <Card>
          {bar && bar.total > 0 ? (
            <>
              <div role="img" aria-label="The prompt by part" className="flex h-3 w-full overflow-hidden rounded-full border border-hair bg-sf2">
                {bar.segments.map((s, i) => (
                  <span key={s.part} title={`${s.label}: ${s.tokensText}`} style={{ width: `${s.share * 100}%`, background: swatch(i) }} className="h-full border-r border-sf last:border-r-0" />
                ))}
              </div>
              <ul className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1">
                {bar.segments.map((s, i) => (
                  <li key={s.part} className="flex min-w-0 items-center gap-2 text-[12px]">
                    <span className="size-2.5 shrink-0 rounded-sm border border-hair" style={{ background: swatch(i) }} />
                    <span className="min-w-0 flex-1 truncate text-t1">{s.label}</span>
                    <span className="tabular-nums text-t2">{s.tokensText}</span>
                    <span className="w-9 text-right tabular-nums text-t3">{Math.round(s.share * 100)}%</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[12px] text-t3">{bar.methodLabel}</p>
              {bar.note && <p className="mt-0.5 text-[12px] text-t3">{bar.note}</p>}
            </>
          ) : (
            <p className="text-[13px] text-t3">No split for the calls of this run: they were built outside Landflow, are not chat calls, or the split was kept only for a limited time.</p>
          )}
        </Card>
      </section>

      <section>
        <SectionTitle aside={spend.truncated ? <span className="normal-case tracking-normal">Only 500 calls are listed</span> : undefined}>Calls</SectionTitle>
        <Card className="overflow-x-auto px-0 py-1">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="text-[11px] uppercase tracking-[0.06em] text-t3">
                <th className="px-3.5 py-1.5 font-semibold">Time</th>
                <th className="px-2 py-1.5 font-semibold">Purpose</th>
                <th className="px-2 py-1.5 font-semibold">Model</th>
                <th className="px-2 py-1.5 text-right font-semibold">Tokens</th>
                <th className="px-3.5 py-1.5 text-right font-semibold">Cost</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.usageId} className="border-t border-hair">
                  <td className="whitespace-nowrap px-3.5 py-1.5 tabular-nums text-t2">
                    {c.spanId ? (
                      <button type="button" onClick={() => open({ kind: 'span', id: c.spanId as string })} className="rounded text-t1 underline decoration-dotted hover:decoration-solid" aria-label={`Open the call at ${clock(c.at)}`}>
                        {clock(c.at)}
                      </button>
                    ) : (
                      clock(c.at)
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-t1">{c.purpose}</td>
                  <td className="max-w-[150px] truncate px-2 py-1.5 text-t2" title={c.model}>
                    {c.model}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-t2">{c.tokens}</td>
                  <td className="whitespace-nowrap px-3.5 py-1.5 text-right tabular-nums text-t1">{c.cost}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {calls.length > CALLS_SHOWN && (
            <button type="button" onClick={() => setAll(!all)} className="w-full border-t border-hair px-3.5 py-2 text-left text-[12px] text-ac hover:underline">
              {all ? 'Show the latest only' : `Show all ${calls.length} calls`}
            </button>
          )}
        </Card>
      </section>
    </div>
  );
}
