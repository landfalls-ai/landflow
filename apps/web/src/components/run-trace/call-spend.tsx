'use client';
/**
 * A model call's composition and cache line in the Run Trace sheet (wave 12, SP07): what the prompt was made of, what
 * came from the cache, what changed since the previous call. Sizes and shares only: never prompt text.
 */
import { cn } from '@/lib/utils';
import { cacheLine, compositionLegend, matchSpanToCall, noSplitReason, previousLine, useAiCall, useRunCalls, type CompositionLegend, type SpanForMatch } from '@/lib/client/call-spend';
import type { AiCallView } from '@/lib/shared/run-spend';
import { SectionTitle } from './parts';

/** Part colours: the cached prefix in the accent family, the rest in neutral steps, so the prefix reads as one block. */
const SHADES = ['bg-ac', 'bg-ac/75', 'bg-ac/55', 'bg-ac/40', 'bg-t3', 'bg-t3/80', 'bg-t3/60', 'bg-t3/45', 'bg-t3/35', 'bg-t3/25', 'bg-t3/20', 'bg-t3/15'];

const pct = (share: number) => (share > 0 && share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`);

export function CompositionBar({ legend }: { legend: CompositionLegend }) {
  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-nudim" role="img" aria-label="What the prompt was made of">
        {legend.items.map((item, i) => (
          <span key={item.part} className={cn('h-full', SHADES[i % SHADES.length])} style={{ width: `${item.share * 100}%` }} title={`${item.label}: ${item.tokens.toLocaleString('en-US')} tokens`} />
        ))}
      </div>
      <ul className="mt-2 flex flex-col gap-1 text-[12px]">
        {legend.items.map((item, i) => (
          <li key={item.part} className="flex items-center gap-2">
            <span className={cn('size-2 shrink-0 rounded-sm', SHADES[i % SHADES.length])} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-t1">
              {item.label}
              {item.cachedPrefix && <span className="ml-1.5 rounded border border-acbd bg-acdim px-1 text-[10px] font-semibold text-ac">cached prefix</span>}
            </span>
            <span className="font-mono text-t2">{item.tokens.toLocaleString('en-US')}</span>
            <span className="w-9 text-right font-mono text-t3">{pct(item.share)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-t3">
        {legend.origin ? `${legend.origin}. ` : ''}
        {legend.method}.
      </p>
    </div>
  );
}

/** The sheet's body once the call's view is known (also what the tests render). */
export function CallSpendView({ view }: { view: AiCallView }) {
  const legend = compositionLegend(view);
  const previous = previousLine(view.previous);
  return (
    <div className="mt-3 flex flex-col gap-2.5" data-testid="call-spend">
      <SectionTitle>What this call was made of</SectionTitle>
      {legend ? <CompositionBar legend={legend} /> : <p className="text-[13px] text-t2">No split for this call. {noSplitReason(view.call)}</p>}
      <p className="text-[13px] text-t1">{cacheLine(view.call)}</p>
      {previous && <p className={cn('text-[13px]', view.previous?.samePrefix ? 'text-gn' : 'text-warn')}>{previous}</p>}
    </div>
  );
}

/** Mounted under a model span's facts: finds the call behind the span, then shows its view. */
export function CallSpend({ span, executionId }: { span: SpanForMatch; executionId: string }) {
  const calls = useRunCalls(executionId);
  const call = calls.data ? matchSpanToCall(span, calls.data) : undefined;
  const view = useAiCall(call?.usageId);
  if (calls.loading || (call && view.loading)) return null;
  if (!call || !view.data) {
    return (
      <div className="mt-3 flex flex-col gap-1.5">
        <SectionTitle>What this call was made of</SectionTitle>
        <p className="text-[13px] text-t2">No split for this call. {noSplitReason(call)}</p>
      </div>
    );
  }
  return <CallSpendView view={view.data} />;
}
