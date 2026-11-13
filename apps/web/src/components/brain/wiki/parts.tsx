'use client';
/**
 * Pieces of the Brain workbench (docs/second-brain.md#the-brain-page): text the brain wrote, with `[[type/id]]` links as
 * page links and `[n]` as references to work; a work item with its source, who and when; page links with a type icon,
 * which open a tab in the workbench (WikiNav) rather than leave it; and a section with the anchor the Outline uses.
 */
import { createContext, Fragment, useContext, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Building2, Rocket, Server, Sparkles, User } from 'lucide-react';
import { timeAgo } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import type { EntityType } from '@/lib/shared/brain';
import { sectionId } from '@/lib/shared/brain-files';
import type { WikiLink, WorkItem } from '@/lib/shared/brain-wiki';
import { Chip } from '../../ui/badge';

export const TYPE_ICON: Record<EntityType, typeof User> = { initiative: Rocket, person: User, customer: Building2, system: Server };
export const TYPE_PLURAL: Record<EntityType, string> = { initiative: 'Initiatives', person: 'People', customer: 'Customers', system: 'Systems' };

export const pageHref = (ref: string) => `/brain/${ref}`;

/** How the workbench opens a page: a tab, not a navigation. Outside it, links are plain links. */
export const WikiNav = createContext<((ref: string) => void) | undefined>(undefined);
export const useWikiNav = () => useContext(WikiNav);

const SOURCES: Record<string, string> = {
  slack: 'Slack',
  'google-drive': 'Drive',
  'google-calendar': 'Calendar',
  google: 'Google',
  notion: 'Notion',
  linear: 'Linear',
  attio: 'Attio',
  fathom: 'Fathom',
};
export const sourceLabel = (source?: string) => (source ? (SOURCES[source] ?? source.replace(/^\w/, (c) => c.toUpperCase())) : 'Work');

/** `work.bug_reported` → "Bug reported". */
export const kindLabel = (kind: string) => {
  const name = kind.replace(/^work\./, '').replace(/_/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
};

/** A link to a page, with its type's icon. */
export function PageLink({ refId, name, className }: { refId: string; name: string; className?: string }) {
  const open = useWikiNav();
  const type = refId.split('/')[0] as EntityType;
  const Icon = TYPE_ICON[type] ?? Sparkles;
  return (
    <Link
      href={pageHref(refId)}
      onClick={(e) => {
        if (!open || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        open(refId);
      }}
      className={cn('inline-flex items-center gap-1 rounded-md px-0.5 font-medium text-ac hover:underline', className)}>
      <Icon className="size-3 shrink-0" aria-hidden />
      {name}
    </Link>
  );
}

/**
 * Text the brain wrote: paragraphs, `[[type/id]]` or `[[type/id|label]]` as page links (named from `links`), `[n]` as a
 * small reference to the n-th work item (`onCite`).
 */
export function WikiText({ text, links = [], onCite, className }: { text: string; links?: WikiLink[]; onCite?: (n: number) => void; className?: string }) {
  const names = new Map(links.map((l) => [l.ref, l.name]));
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim());
  // A model writes a little Markdown: lists (- , * , 1. ), **bold** and `code`; each line keeps its break.
  const item = /^\s*(?:[-*•]|\d{1,2}[.)])\s+/;
  return (
    <div className={cn('space-y-2.5 text-[13.5px] leading-relaxed text-t1', className)}>
      {paragraphs.map((paragraph, i) => {
        const lines = paragraph.split('\n').filter((l) => l.trim());
        if (lines.length && lines.every((l) => item.test(l))) {
          const ordered = /^\s*\d/.test(lines[0]);
          const List = ordered ? 'ol' : 'ul';
          return (
            <List key={i} className={cn('space-y-1 pl-5 [overflow-wrap:anywhere]', ordered ? 'list-decimal' : 'list-disc')}>
              {lines.map((line, j) => (
                <li key={j}>{marks(line.replace(item, ''), names, onCite)}</li>
              ))}
            </List>
          );
        }
        return (
          <p key={i} className="whitespace-pre-line [overflow-wrap:anywhere]">
            {marks(paragraph, names, onCite)}
          </p>
        );
      })}
    </div>
  );
}

/** `**bold**` and `` `code` `` around the links and references `inline` reads. */
function marks(text: string, names: Map<string, string>, onCite?: (n: number) => void): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(/\*\*([^*\n]+)\*\*|`([^`\n]+)`/g)) {
    out.push(<Fragment key={`s${last}`}>{inline(text.slice(last, match.index), names, onCite)}</Fragment>);
    out.push(
      match[1] !== undefined ? (
        <strong key={`b${match.index}`} className="font-semibold">
          {inline(match[1], names, onCite)}
        </strong>
      ) : (
        <code key={`c${match.index}`} className="rounded bg-acdim px-1 font-mono text-[0.92em]">
          {match[2]}
        </code>
      ),
    );
    last = (match.index ?? 0) + match[0].length;
  }
  out.push(<Fragment key="end">{inline(text.slice(last), names, onCite)}</Fragment>);
  return out;
}

function inline(text: string, names: Map<string, string>, onCite?: (n: number) => void): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(/\[\[([a-z]+\/[a-z0-9][a-z0-9_.-]{0,63})(?:\|([^\]]*))?\]\]|\[(\d{1,2})\]/g)) {
    out.push(text.slice(last, match.index));
    if (match[1]) out.push(<PageLink key={match.index} refId={match[1]} name={match[2] || names.get(match[1]) || match[1].split('/')[1]} />);
    else {
      const n = Number(match[3]);
      out.push(
        onCite ? (
          <button key={match.index} type="button" onClick={() => onCite(n)} className="mx-0.5 rounded bg-acdim px-1 align-super text-[10px] font-semibold text-ac hover:underline" aria-label={`Source ${n}`}>
            {n}
          </button>
        ) : (
          <sup key={match.index} className="text-[10px] text-t3">
            {n}
          </sup>
        ),
      );
    }
    last = (match.index ?? 0) + match[0].length;
  }
  out.push(text.slice(last));
  return out.map((part, i) => (typeof part === 'string' ? <Fragment key={`t${i}`}>{part}</Fragment> : part));
}

/** One work item: source and kind, the title (to the original), who and when, and the pages it names. */
export function WorkRow({ item, number, names, highlight, idPrefix = 'work' }: { item: WorkItem; number?: number; names?: Map<string, string>; highlight?: boolean; idPrefix?: string }) {
  return (
    <li id={number ? `${idPrefix}-${number}` : undefined} className={cn('flex gap-3 px-3 py-2.5 transition-colors', highlight && 'bg-acdim')}>
      {number !== undefined && <span className="mt-0.5 w-5 shrink-0 text-right text-[11px] font-semibold tabular-nums text-t3">{number}</span>}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-t3">
          <Chip className="px-2 text-[11px]">{sourceLabel(item.source)}</Chip>
          <span>{kindLabel(item.kind)}</span>
          <span>·</span>
          <time dateTime={item.at} title={new Date(item.at).toLocaleString()}>
            {timeAgo(item.at)}
          </time>
          {item.team && (
            <>
              <span>·</span>
              <span>{item.team}</span>
            </>
          )}
        </div>
        <div className="text-[13px] font-medium text-t1 [overflow-wrap:anywhere]">
          {item.url ? (
            <a href={item.url} target="_blank" rel="noreferrer" className="hover:text-ac hover:underline">
              {item.title ?? kindLabel(item.kind)}
              <ArrowUpRight className="ml-0.5 inline size-3 text-t3" aria-hidden />
            </a>
          ) : (
            (item.title ?? kindLabel(item.kind))
          )}
        </div>
        {item.summary && <p className="line-clamp-2 text-[12px] leading-relaxed text-t2">{item.summary}</p>}
        {(item.actor || item.refs.length > 0) && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-t3">
            {item.actor && !item.refs.some((r) => r.startsWith('person/')) && <span>{item.actor}</span>}
            {item.refs.map((ref) => (
              <PageLink key={ref} refId={ref} name={names?.get(ref) ?? ref.split('/')[1]} className="text-[12px] font-normal" />
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

export function WorkList({ items, names, numbered, highlight, idPrefix, empty = 'No work yet.' }: { items: WorkItem[]; names?: Map<string, string>; numbered?: boolean; highlight?: number; idPrefix?: string; empty?: string }) {
  if (!items.length) return <p className="text-[12px] text-t3">{empty}</p>;
  return (
    <ol className="divide-y divide-hair overflow-hidden rounded-xl border border-hair">
      {items.map((item, i) => (
        <WorkRow key={item.id} item={item} names={names} idPrefix={idPrefix} {...(numbered && { number: i + 1 })} highlight={highlight === i + 1} />
      ))}
    </ol>
  );
}

/** A small marker for text the brain's model wrote. */
export function WrittenBy({ model, at, stale, children }: { model?: string; at?: string; stale?: boolean; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-t3">
      <Sparkles className="size-3 text-viz-7" aria-hidden />
      <span>Written by the brain{model ? ` (${model})` : ''}</span>
      {at && (
        <>
          <span>·</span>
          <time dateTime={at}>{timeAgo(at)}</time>
        </>
      )}
      {stale && <span className="rounded bg-warndim px-1.5 font-semibold text-warn">new work since</span>}
      {children}
    </div>
  );
}

/** A titled section of a file, like a Markdown `##`: its anchor is the one the Outline scrolls to. */
export function Section({ title, count, action, children }: { title: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section id={sectionId(title)} className="scroll-mt-4 space-y-2.5">
      <div className="flex items-center gap-2 border-b border-hair pb-1.5">
        <h2 className="text-[15px] font-semibold text-t1">{title}</h2>
        {count !== undefined && <span className="text-[12px] tabular-nums text-t3">{count}</span>}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </section>
  );
}
