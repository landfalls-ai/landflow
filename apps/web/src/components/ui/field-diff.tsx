'use client';
/**
 * A per-field diff (docs/ui-review.md#controls): each changed field as "label: old → new", the old value struck through
 * and the new one plain, a long value folded to two lines with "Show all", and how many fields stay as they are. The
 * Apply diff, an agent's version compare and every other "what changed" list draw their lines with it. Renders what it is
 * given; it reads no data and computes no diff.
 */
import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { FieldChange } from '@/lib/shared/field-change';

export type { FieldChange } from '@/lib/shared/field-change';

/** Whether a value is folded to two lines until "Show all". */
export const isLong = (text?: string): boolean => text !== undefined && (text.length > 120 || text.includes('\n'));

function Block({ label, text, fresh }: { label: string; text: string; fresh?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-t3">{label}</div>
      <pre className={cn('max-h-[240px] overflow-auto whitespace-pre-wrap rounded-md border border-hair bg-wl px-1.5 py-1 font-mono text-[11px] leading-snug [overflow-wrap:anywhere]', fresh ? 'text-t1' : 'text-t3')}>{text}</pre>
    </div>
  );
}

/** One changed value: "label: old → new", a long one folded to two lines until "Show all". */
const TONE: Record<NonNullable<FieldChange['tone']>, string> = { good: 'text-gn', bad: 'text-rd', muted: 'text-t3' };

export function FieldRow({ label, before, after, long, tone, title }: { label: string; before?: string; after?: string; long?: boolean; tone?: FieldChange['tone']; title?: string }) {
  const [all, setAll] = useState(false);
  if (long && all) {
    return (
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-1.5 text-t2">
          <span className="font-semibold text-t1">{label}</span>
          <button type="button" aria-expanded onClick={() => setAll(false)} className="text-ac hover:underline max-md:min-h-11">
            Show less
          </button>
        </div>
        {before !== undefined && <Block label="Was" text={before} />}
        {after !== undefined && <Block label="Now" text={after} fresh />}
      </div>
    );
  }
  return (
    <div className="min-w-0 text-t2" {...(title && { title })}>
      <span className="font-semibold text-t1">{label}</span>: {before !== undefined && <span className={cn('text-t3 line-through decoration-t3/60', long && 'line-clamp-2 whitespace-pre-wrap')}>{before}</span>}
      {before !== undefined && after !== undefined && <span className="text-t3"> → </span>}
      {after !== undefined && <span className={cn(tone ? TONE[tone] : 'text-t1', long && 'line-clamp-2 whitespace-pre-wrap')}>{after}</span>}
      {long && (
        <button type="button" aria-expanded={false} onClick={() => setAll(true)} className="ml-1.5 text-ac hover:underline max-md:min-h-11">
          Show all
        </button>
      )}
    </div>
  );
}

export function FieldDiff({ changes, unchanged, unchangedLabel = (n) => `${n.toLocaleString('en-US')} unchanged`, className }: { changes: FieldChange[]; unchanged: number; unchangedLabel?: (n: number) => string; className?: string }) {
  return (
    <div className={cn('space-y-1.5 text-[12px] leading-snug', className)}>
      {changes.length === 0 && <div className="text-t2">No changes</div>}
      {changes.map((c) => (
        <div key={c.field} className="flex min-w-0 items-start gap-1.5">
          <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            <FieldRow label={c.label} {...(c.before !== undefined && { before: c.before })} {...(c.after !== undefined && { after: c.after })} long={c.long ?? (isLong(c.before) || isLong(c.after))} {...(c.tone && { tone: c.tone })} {...(c.title && { title: c.title })} />
          </div>
          {c.kind !== 'changed' && <span className={cn('shrink-0 text-[11px]', c.kind === 'added' ? 'text-gn' : 'text-rd')}>{c.kind}</span>}
        </div>
      ))}
      {unchanged > 0 && <div className="text-t3">{unchangedLabel(unchanged)}</div>}
    </div>
  );
}
