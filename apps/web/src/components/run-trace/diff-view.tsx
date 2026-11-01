'use client';
/**
 * A unified line diff, phone first: the box scrolls sideways by itself so the page never does, lines keep their
 * indentation, and each side's line numbers stay put on the left. Added and removed lines use the app's own tones.
 * (A diff library was tried for this and left out: a unified patch is little to draw, and its CSS would fight the app's tokens.)
 * Inside a Run Trace view a diff of a named file takes line comments: tap a line (or its number), write, and the comment
 * shows under the box; the gate's Send back carries them all (line-comments.tsx).
 */
import { useMemo, useState } from 'react';
import { MessageSquare, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { commentsOn, type LineComment } from '@/lib/shared/line-comments';
import { diffHunks, type DiffHunk, type DiffLine, type FileChange } from '@/lib/shared/run-changes';
import { Button } from '../ui/button';
import { Textarea } from '../ui/inputs';
import { useLineComments } from './line-comments';

/** Lines drawn before "Show all": a patch can be thousands of lines long. */
const SHOWN = 400;

const SIGN = { add: '+', del: '−', ctx: ' ' } as const;
const TONE = { add: 'bg-gndim text-gn', del: 'bg-rddim text-rd', ctx: 'text-t2' } as const;

type Picked = { side: LineComment['side']; line: number; quote: string };

const pickOf = (line: DiffLine): Picked | undefined =>
  line.type === 'del' ? (line.oldNo ? { side: 'old', line: line.oldNo, quote: line.text } : undefined) : line.newNo ? { side: 'new', line: line.newNo, quote: line.text } : undefined;

function Composer({ path, picked, onDone }: { path: string; picked: Picked; onDone: () => void }) {
  const comments = useLineComments()!;
  const [text, setText] = useState('');
  const save = () => {
    if (!text.trim()) return;
    comments.add({ path, ...picked, text: text.trim() });
    onDone();
  };
  return (
    <div className="mt-1.5 flex flex-col gap-1.5 rounded-xl border border-acbd bg-acdim/50 p-2.5">
      <p className="min-w-0 text-[12px] text-t2">
        {picked.side === 'old' ? 'Removed line' : 'Line'} {picked.line}
        {picked.quote.trim() && (
          <>
            : <span className="break-all font-mono text-t1">{picked.quote.trim().slice(0, 120)}</span>
          </>
        )}
      </p>
      <Textarea
        autoFocus
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
          if (e.key === 'Escape') onDone();
        }}
        placeholder="What should change here?"
        aria-label={`Comment on line ${picked.line}`}
      />
      <div className="flex gap-2">
        <Button variant="primary" size="sm" disabled={!text.trim()} onClick={save}>
          Add comment
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function DiffView({ hunks, label, className, path }: { hunks: DiffHunk[]; label: string; className?: string; path?: string }) {
  const [all, setAll] = useState(false);
  const [picked, setPicked] = useState<Picked>();
  const store = useLineComments();
  const commenting = Boolean(store && path);
  const total = hunks.reduce((n, h) => n + h.lines.length, 0);
  if (!total) return <p className="rounded-xl border border-hair bg-sf2 px-3 py-2 text-[12.5px] text-t3">No lines changed.</p>;
  let budget = all ? Infinity : SHOWN;
  const width = String(Math.max(...hunks.flatMap((h) => h.lines.map((l) => Math.max(l.oldNo ?? 0, l.newNo ?? 0))), 9)).length;
  // This view's comments, in the order of their lines.
  const here: LineComment[] = [];
  const marks = new Set<string>();
  if (store && path) {
    for (const hunk of hunks)
      for (const line of hunk.lines) {
        const p = pickOf(line);
        if (!p) continue;
        const on = commentsOn(store.comments, path, p.side, p.line, line.text);
        if (on.length) marks.add(`${p.side}:${p.line}`);
        for (const c of on) if (!here.includes(c)) here.push(c);
      }
  }
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
                {lines.map((line, i) => {
                  const p = commenting ? pickOf(line) : undefined;
                  const isPicked = Boolean(p && picked && picked.side === p.side && picked.line === p.line);
                  const marked = Boolean(p && marks.has(`${p.side}:${p.line}`));
                  const numbers = (
                    <>
                      <span style={{ width: `${width}ch` }}>{line.oldNo ?? ''}</span>
                      <span style={{ width: `${width}ch` }}>{line.newNo ?? ''}</span>
                    </>
                  );
                  const gutter = cn('sticky left-0 flex shrink-0 select-none gap-[1ch] bg-sf2 px-1.5 text-right text-t3', marked && 'text-ac shadow-[inset_3px_0_0_var(--ac)]');
                  return (
                    <div key={i} className={cn('flex', TONE[line.type], p && 'cursor-pointer', isPicked && 'outline outline-1 -outline-offset-1 outline-ac')} onClick={p ? () => setPicked(isPicked ? undefined : p) : undefined}>
                      {p ? (
                        <button
                          type="button"
                          className={gutter}
                          style={{ minWidth: `${width * 2 + 3}ch` }}
                          aria-label={`Comment on ${p.side === 'old' ? 'removed line' : 'line'} ${p.line}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setPicked(isPicked ? undefined : p);
                          }}
                        >
                          {numbers}
                        </button>
                      ) : (
                        <span aria-hidden className={gutter} style={{ minWidth: `${width * 2 + 3}ch` }}>
                          {numbers}
                        </span>
                      )}
                      <span aria-hidden className="w-4 shrink-0 select-none text-center">
                        {SIGN[line.type]}
                      </span>
                      <span className="whitespace-pre pr-3">{line.text || ' '}</span>
                      <span className="sr-only">{line.type === 'add' ? 'added' : line.type === 'del' ? 'removed' : ''}</span>
                    </div>
                  );
                })}
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
      {commenting && picked && <Composer key={`${picked.side}:${picked.line}`} path={path!} picked={picked} onDone={() => setPicked(undefined)} />}
      {here.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-1" aria-label="Your comments on this diff">
          {here.map((c) => (
            <li key={c.id} className="flex items-start gap-2 rounded-xl border border-hair bg-sf2 px-2.5 py-2 text-[12.5px]">
              <MessageSquare className="mt-[2px] size-3.5 shrink-0 text-ac" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="text-t3">
                  {c.side === 'old' ? 'Removed line' : 'Line'} {c.line} ·{' '}
                </span>
                <span className="whitespace-pre-wrap break-words text-t1">{c.text}</span>
              </span>
              <button type="button" onClick={() => store!.remove(c.id)} className="-m-1 grid size-7 shrink-0 place-items-center rounded-full text-t3 hover:text-rd" aria-label="Remove the comment">
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One file change as a line diff: before against after, however the tool passed them (an Edit may pass the whole file). */
export function ChangeDiff({ change, path }: { change: FileChange; path: string }) {
  const hunks = useMemo(() => diffHunks(change.before, change.after), [change.before, change.after]);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <DiffView hunks={hunks} path={path} label={`${change.actor.name}’s ${change.kind} of ${path}`} />
      {change.created && !change.partial && <p className="text-[12px] text-t3">The run had not shown this file before, so every line counts as added.</p>}
      {change.partial && <p className="text-[12px] text-t3">The run did not show the rest of this file: only the text the edit passed is compared.</p>}
      {change.truncated && <p className="text-[12px] text-warn">The journal cut this text at 32 KB: the diff is incomplete.</p>}
    </div>
  );
}
