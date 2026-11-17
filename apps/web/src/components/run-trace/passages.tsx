'use client';
/**
 * AG14: what a tool call reached and what a knowledge search found, read the same way in the editor's chat, the Run Trace's
 * span sheet and the agent page's timeline (docs/run-trace.md "What a tool call reached"). Pure view: the target holds no
 * secret (lib/shared/tool-target.ts) and the passages are the tool's own output.
 */
import { useState } from 'react';
import { FileText, Plug } from 'lucide-react';
import { cn } from '@/lib/utils';
import { passagesOf, targetLine, type Passage, type ToolTarget } from '@/lib/shared/tool-target';

/** A tool's output as the value it carries: the chat streams it as a JSON string, the timeline and the trace as the value. */
export function outputValue(output: unknown): unknown {
  if (typeof output !== 'string') return output;
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

/** The passages of a knowledge output (an empty list for anything else). */
export function passagesFor(output: unknown): Passage[] {
  return passagesOf(outputValue(output));
}

/** "via Mailpit SMTP · SMTP 127.0.0.1:51183", the credential's name in bold. */
export function ViaLine({ target, className }: { target?: ToolTarget; className?: string }) {
  if (!target) return null;
  const line = targetLine(target);
  const rest = line.startsWith(target.name) ? line.slice(target.name.length) : ` · ${line}`;
  return (
    <div data-testid="tool-via" className={cn('flex min-w-0 items-center gap-1 text-[11px] text-t3', className)} title={line}>
      <Plug className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">
        via <strong className="font-semibold text-t2">{target.name}</strong>
        {rest}
      </span>
    </div>
  );
}

function PassageCard({ passage }: { passage: Passage }) {
  const [all, setAll] = useState(false);
  const long = passage.text.length > 240 || passage.text.split('\n').length > 4;
  return (
    <li className="rounded-lg border border-hair bg-wl px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-t3">
        {passage.source && (
          <span data-testid="passage-source" className="inline-flex max-w-full items-center gap-1 rounded-full border border-hair bg-sf px-2 py-px text-t2">
            <FileText className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{passage.source}</span>
          </span>
        )}
        {passage.page !== undefined && <span>page {passage.page}</span>}
        {passage.score !== undefined && <span className="ml-auto font-mono">{passage.score.toFixed(2)}</span>}
      </div>
      <p className={cn('mt-1 whitespace-pre-wrap text-[12px] text-t1 [overflow-wrap:anywhere]', !all && 'line-clamp-4')}>{passage.text}</p>
      {long && (
        <button type="button" onClick={() => setAll(!all)} aria-expanded={all} className="mt-0.5 text-[11px] text-ac hover:underline max-md:min-h-8">
          {all ? 'Show less' : 'Show all'}
        </button>
      )}
    </li>
  );
}

/** The passages a knowledge search returned, each with its source; the raw JSON stays behind "Raw". */
export function Passages({ output, passages }: { output: unknown; passages?: Passage[] }) {
  const [raw, setRaw] = useState(false);
  const list = passages ?? passagesFor(output);
  if (!list.length) return null;
  const value = outputValue(output);
  return (
    <div data-testid="passages" className="space-y-1">
      <ul className="space-y-1">
        {list.map((p, i) => (
          <PassageCard key={i} passage={p} />
        ))}
      </ul>
      <button type="button" onClick={() => setRaw(!raw)} aria-expanded={raw} className="text-[11px] text-t3 hover:text-t2 max-md:min-h-8">
        {raw ? 'Hide raw' : 'Raw'}
      </button>
      {raw && <pre className="max-h-40 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11px] text-t2">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>}
    </div>
  );
}
