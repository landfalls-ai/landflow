'use client';
/**
 * A small Markdown renderer for sticky notes: headings, paragraphs (single line
 * breaks kept), bullet and numbered lists, task boxes, quotes, rules, fenced
 * code, inline code, bold, italic, strikethrough, links and images. It builds
 * React elements (no HTML strings), and only http(s)/mailto URLs become links.
 */
import { Fragment, type ReactNode } from 'react';

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** Inline spans, longest-match first: code, image, link, bold, strike, italic. */
const INLINE = /(`+)([\s\S]+?)\1|!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_/g;

function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${index++}`;
    if (m[2] !== undefined) {
      out.push(
        <code key={k} className="rounded bg-acdim px-1 font-mono text-[0.92em]">
          {m[2]}
        </code>,
      );
    } else if (m[4] !== undefined) {
      out.push(SAFE_URL.test(m[4]) ? <img key={k} src={m[4]} alt={m[3]} className="my-1 max-w-full rounded-md" draggable={false} /> : m[0]);
    } else if (m[6] !== undefined) {
      out.push(
        SAFE_URL.test(m[6]) ? (
          <a key={k} href={m[6]} target="_blank" rel="noreferrer" className="underline decoration-current/40 underline-offset-2 hover:decoration-current">
            {inline(m[5], k)}
          </a>
        ) : (
          m[5]
        ),
      );
    } else if (m[7] !== undefined || m[8] !== undefined) {
      out.push(<strong key={k}>{inline(m[7] ?? m[8], k)}</strong>);
    } else if (m[9] !== undefined) {
      out.push(<s key={k}>{inline(m[9], k)}</s>);
    } else {
      out.push(<em key={k}>{inline(m[10] ?? m[11], k)}</em>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Lines joined with <br>: notes are written line by line more often than in paragraphs. */
function lines(text: string[], key: string): ReactNode {
  return text.map((line, i) => (
    <Fragment key={`${key}-${i}`}>
      {i > 0 && <br />}
      {inline(line, `${key}-${i}`)}
    </Fragment>
  ));
}

const HEADING = ['text-[1.35em] font-semibold', 'text-[1.2em] font-semibold', 'text-[1.08em] font-semibold', 'font-semibold', 'font-semibold', 'font-semibold'];
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+(.*)$/;

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  const source = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  let key = 0;
  while (i < source.length) {
    const line = source[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const k = `b${key++}`;
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < source.length && !source[i].trim().startsWith(fence[1]); i++) body.push(source[i]);
      i++;
      blocks.push(
        <pre key={k} className="overflow-x-auto rounded-md bg-acdim px-2 py-1.5 font-mono text-[0.88em] leading-snug">
          {body.join('\n')}
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push(
        <div key={k} role="heading" aria-level={level} className={HEADING[level - 1]}>
          {inline(heading[2], k)}
        </div>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={k} className="border-current/15" />);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      for (; i < source.length && /^\s*>/.test(source[i]); i++) body.push(source[i].replace(/^\s*>\s?/, ''));
      blocks.push(
        <blockquote key={k} className="border-l-2 border-current/25 pl-2 opacity-85">
          {lines(body, k)}
        </blockquote>,
      );
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[][] = [];
      for (; i < source.length && source[i].trim(); i++) {
        const item = LIST_ITEM.exec(source[i]);
        if (item) items.push([item[2]]);
        else items.at(-1)?.push(source[i].trim());
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List key={k} className={ordered ? 'list-decimal space-y-0.5 pl-5' : 'list-disc space-y-0.5 pl-5'}>
          {items.map((item, j) => {
            const task = /^\[([ xX])\]\s+(.*)$/.exec(item[0]);
            return (
              <li key={j} className={task ? '-ml-5 list-none' : undefined}>
                {task ? (
                  <span className="inline-flex items-baseline gap-1.5">
                    <input type="checkbox" checked={task[1] !== ' '} readOnly tabIndex={-1} className="pointer-events-none translate-y-px accent-current" />
                    <span className={task[1] !== ' ' ? 'line-through opacity-60' : undefined}>{lines([task[2], ...item.slice(1)], `${k}-${j}`)}</span>
                  </span>
                ) : (
                  lines(item, `${k}-${j}`)
                )}
              </li>
            );
          })}
        </List>,
      );
      continue;
    }
    const body: string[] = [];
    for (; i < source.length && source[i].trim() && !/^(#{1,6}\s|\s*(```|~~~|>))/.test(source[i]) && !LIST_ITEM.test(source[i]); i++) body.push(source[i]);
    if (!body.length) body.push(source[i++]);
    blocks.push(<p key={k}>{lines(body, k)}</p>);
  }
  return <div className={className}>{blocks}</div>;
}
