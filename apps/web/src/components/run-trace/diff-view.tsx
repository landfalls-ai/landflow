'use client';
/**
 * A unified line diff, phone first: the box scrolls sideways by itself so the page never does, lines keep their
 * indentation, and each side's line numbers stay put on the left. Added and removed lines use the app's own tones.
 * (A diff library was tried for this and left out: a unified patch is little to draw, and its CSS would fight the app's tokens.)
 */
import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { diffHunks, type DiffHunk, type FileChange } from '@/lib/shared/run-changes';

/** Lines drawn before "Show all": a patch can be thousands of lines long. */
const SHOWN = 400;

const SIGN = { add: '+', del: '−', ctx: ' ' } as const;
const TONE = { add: 'bg-gndim text-gn', del: 'bg-rddim text-rd', ctx: 'text-t2' } as const;

export function DiffView({ hunks, label, className }: { hunks: DiffHunk[]; label: string; className?: string }) {
  const [all, setAll] = useState(false);
  const total = hunks.reduce((n, h) => n + h.lines.length, 0);
  if (!total) return <p className="rounded-xl border border-hair bg-sf2 px-3 py-2 text-[12.5px] text-t3">No lines changed.</p>;
  let budget = all ? Infinity : SHOWN;
  const width = String(Math.max(...hunks.flatMap((h) => h.lines.map((l) => Math.max(l.oldNo ?? 0, l.newNo ?? 0))), 9)).length;
  return (
    <div className={cn('min-w-0', className)}>
      {/* tabIndex: a keyboard can scroll the box. */}
      <div role="region" aria-label={label} tabIndex={0} className="overflow-x-auto rounded-xl border border-hair bg-sf font-mono text-[12px] leading-[1.55] outline-none focus-visible:outline-2 focus-visible:outline-ac">
        <div className="w-max min-w-full">
          {hunks.map((hunk, h) => {
            if (budget <= 0) return null;
            const lines = hunk.lines.slice(0, budget);
            budget -= lines.length;
            return (
              <div key={h}>
                <div className="whitespace-pre bg-acdim px-2.5 text-ac">{hunk.header.replace(/^(@@ [^@]*@@).*/, '$1')}</div>
                {lines.map((line, i) => (
                  <div key={i} className={cn('flex', TONE[line.type])}>
                    <span aria-hidden className="sticky left-0 flex shrink-0 select-none bg-sf2 px-1.5 text-right text-t3" style={{ minWidth: `${width * 2 + 3}ch` }}>
                      <span style={{ width: `${width}ch` }}>{line.oldNo ?? ''}</span>
                      <span style={{ width: `${width}ch` }}>{line.newNo ?? ''}</span>
                    </span>
                    <span aria-hidden className="w-4 shrink-0 select-none text-center">
                      {SIGN[line.type]}
                    </span>
                    <span className="whitespace-pre pr-3">{line.text || ' '}</span>
                    <span className="sr-only">{line.type === 'add' ? 'added' : line.type === 'del' ? 'removed' : ''}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      {total > SHOWN && !all && (
        <button type="button" onClick={() => setAll(true)} className="mt-1.5 min-h-8 text-[12.5px] text-ac underline underline-offset-2">
          Show all {total.toLocaleString()} lines
        </button>
      )}
    </div>
  );
}

/** One file change as a line diff: before against after, however the tool passed them (an Edit may pass the whole file). */
export function ChangeDiff({ change, path }: { change: FileChange; path: string }) {
  const hunks = useMemo(() => diffHunks(change.before, change.after), [change.before, change.after]);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <DiffView hunks={hunks} label={`${change.actor.name}’s ${change.kind} of ${path}`} />
      {change.created && !change.partial && <p className="text-[12px] text-t3">The run had not shown this file before, so every line counts as added.</p>}
      {change.partial && <p className="text-[12px] text-t3">The run did not show the rest of this file: only the text the edit passed is compared.</p>}
      {change.truncated && <p className="text-[12px] text-warn">The journal cut this text at 32 KB: the diff is incomplete.</p>}
    </div>
  );
}
