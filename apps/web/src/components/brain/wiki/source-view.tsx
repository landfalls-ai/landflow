'use client';
/**
 * A file's Source in the Brain workbench: its Markdown (lib/shared/brain-files.ts) with line numbers, coloured the way an
 * editor colours Markdown: frontmatter keys, headings, list markers, quotes, `[[type/id|Name]]` links (which open the
 * page) and `[n]` references (which jump to that work line). Read-only: people change a page through its Preview, and
 * the model writes the summary.
 */
import { Fragment, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useWikiNav } from './parts';

export const lineId = (line: number) => `L${line}`;

export function SourceView({ markdown }: { markdown: string }) {
  const open = useWikiNav();
  const lines = markdown.split('\n');
  // Frontmatter: from a first line `---` to the next `---`.
  const frontEnd = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  // `1. ` lines under `## Work` are what `[n]` points at.
  const workLine = new Map<number, number>();
  let inWork = false;
  lines.forEach((line, i) => {
    if (line.startsWith('## ')) inWork = line === '## Work';
    const n = inWork ? /^(\d+)\. /.exec(line) : null;
    if (n) workLine.set(Number(n[1]), i + 1);
  });
  const jump = (n: number) => {
    const line = workLine.get(n);
    if (line) document.getElementById(lineId(line))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="overflow-x-auto py-3 font-mono text-[12.5px] leading-[1.6]">
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, i) => (
            <tr key={i} id={lineId(i + 1)} className="scroll-mt-16 hover:bg-acdim/40">
              <td className="w-12 select-none pr-4 text-right align-top text-[11.5px] tabular-nums text-t3/70">{i + 1}</td>
              <td className="whitespace-pre-wrap pr-6 align-top text-t2 [overflow-wrap:anywhere]">{highlight(line, i > 0 && i <= frontEnd && line !== '---', open, jump)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function highlight(line: string, front: boolean, open: ((ref: string) => void) | undefined, jump: (n: number) => void): ReactNode {
  if (line === '---') return <span className="text-t3">---</span>;
  if (front) {
    const match = /^([^:]+):(.*)$/.exec(line);
    if (match)
      return (
        <>
          <span className="text-viz-1">{match[1]}</span>
          <span className="text-t3">:</span>
          <span className="text-viz-4">{match[2]}</span>
        </>
      );
  }
  const heading = /^(#{1,6})\s(.*)$/.exec(line);
  if (heading)
    return (
      <span className={cn('font-semibold text-ac', heading[1].length === 1 && 'text-[13.5px]')}>
        <span className="text-t3">{heading[1]} </span>
        {inline(heading[2], open, jump)}
      </span>
    );
  const marker = /^(\s*)([-*]|\d+\.|>)(\s)(.*)$/.exec(line);
  if (marker)
    return (
      <>
        {marker[1]}
        <span className="text-viz-7">{marker[2]}</span>
        {marker[3]}
        <span className={cn(marker[2] === '>' && 'italic text-t3')}>{inline(marker[4], open, jump)}</span>
      </>
    );
  return inline(line, open, jump);
}

/** `[[ref|Name]]`, `[label](url)`, `[n]`, `**bold**` and `_italic_` in a line. */
function inline(text: string, open: ((ref: string) => void) | undefined, jump: (n: number) => void): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(/\[\[([a-z]+\/[a-z0-9][a-z0-9_.-]{0,63})(?:\|([^\]]*))?\]\]|\[([^\]]+)\]\((https?:[^)\s]+)\)|\[(\d{1,2})\]|\*\*([^*]+)\*\*|\b_([^_]+)_\b/g)) {
    const at = match.index ?? 0;
    out.push(text.slice(last, at));
    if (match[1]) {
      const ref = match[1];
      out.push(
        <button key={at} type="button" onClick={() => open?.(ref)} className="text-ac underline decoration-ac/40 underline-offset-2 hover:decoration-ac" title={`Open ${ref}`}>
          {match[0]}
        </button>,
      );
    } else if (match[3])
      out.push(
        <a key={at} href={match[4]} target="_blank" rel="noreferrer" className="hover:underline">
          <span className="text-t1">[{match[3]}]</span>
          <span className="text-t3">({match[4]})</span>
        </a>,
      );
    else if (match[5]) {
      const n = Number(match[5]);
      out.push(
        <button key={at} type="button" onClick={() => jump(n)} className="text-viz-7 hover:underline" title={`Work ${n}`}>
          {match[0]}
        </button>,
      );
    } else if (match[6])
      out.push(
        <span key={at} className="font-semibold text-t1">
          {match[0]}
        </span>,
      );
    else
      out.push(
        <span key={at} className="italic text-t3">
          {match[0]}
        </span>,
      );
    last = at + match[0].length;
  }
  out.push(text.slice(last));
  return out.map((part, i) => (typeof part === 'string' ? <Fragment key={`t${i}`}>{part}</Fragment> : part));
}
