'use client';
/**
 * Pieces of the Brain page (docs/second-brain.md#the-brain-page): text the brain wrote, with `[[type/id]]` links as page
 * links and `[n]` as references to work; a work item with its source, who and when; page links with a type icon; and the
 * Ask box with its answer. One column, so a phone reads them as they are.
 */
import { Fragment, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Building2, Rocket, Send, Server, Sparkles, User } from 'lucide-react';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import type { EntityType } from '@/lib/shared/brain';
import type { WikiAnswer, WikiLink, WorkItem } from '@/lib/shared/brain-wiki';
import { Chip } from '../../ui/badge';
import { Button } from '../../ui/button';

export const TYPE_ICON: Record<EntityType, typeof User> = { initiative: Rocket, person: User, customer: Building2, system: Server };
export const TYPE_PLURAL: Record<EntityType, string> = { initiative: 'Initiatives', person: 'People', customer: 'Customers', system: 'Systems' };

export const pageHref = (ref: string) => `/brain/${ref}`;

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
  const type = refId.split('/')[0] as EntityType;
  const Icon = TYPE_ICON[type] ?? Sparkles;
  return (
    <Link href={pageHref(refId)} className={cn('inline-flex items-center gap-1 rounded-md px-0.5 font-medium text-ac hover:underline', className)}>
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
  return (
    <div className={cn('space-y-2.5 text-[13.5px] leading-relaxed text-t1', className)}>
      {paragraphs.map((paragraph, i) => (
        <p key={i} className="[overflow-wrap:anywhere]">
          {inline(paragraph, names, onCite)}
        </p>
      ))}
    </div>
  );
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
export function WorkRow({ item, number, names, highlight }: { item: WorkItem; number?: number; names?: Map<string, string>; highlight?: boolean }) {
  return (
    <li id={number ? `work-${number}` : undefined} className={cn('flex gap-3 px-3 py-2.5 transition-colors', highlight && 'bg-acdim')}>
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

export function WorkList({ items, names, numbered, highlight, empty = 'No work yet.' }: { items: WorkItem[]; names?: Map<string, string>; numbered?: boolean; highlight?: number; empty?: string }) {
  if (!items.length) return <p className="text-[12px] text-t3">{empty}</p>;
  return (
    <ol className="divide-y divide-hair overflow-hidden rounded-xl border border-hair">
      {items.map((item, i) => (
        <WorkRow key={item.id} item={item} names={names} {...(numbered && { number: i + 1 })} highlight={highlight === i + 1} />
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

/** Ask the brain: one box; the answer with its page links and numbered sources. `about` asks from a page. */
export function AskBox({ about, aboutName, placeholder, autoFocus }: { about?: string; aboutName?: string; placeholder?: string; autoFocus?: boolean }) {
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<WikiAnswer>();
  const [error, setError] = useState<string>();
  const [cited, setCited] = useState<number>();

  const ask = async () => {
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    setError(undefined);
    setCited(undefined);
    try {
      setAnswer(await api<WikiAnswer>('/api/brain/ask', { method: 'POST', json: { question: q, ...(about && { about }) } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAsking(false);
    }
  };

  const names = new Map([...(answer?.pages ?? []).map((p) => [`${p.type}/${p.id}`, p.name] as const), ...(answer?.links ?? []).map((l) => [l.ref, l.name] as const)]);
  const cite = (n: number) => {
    setCited(n);
    document.getElementById(`work-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="space-y-3">
      <form
        className="flex items-center gap-2 rounded-2xl border border-bd bg-sf px-3 py-1.5 focus-within:border-ac"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <Sparkles className="size-4 shrink-0 text-viz-7" aria-hidden />
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={placeholder ?? (aboutName ? `Ask about ${aboutName}` : 'Ask the brain: who is working on…, what changed with…, is anyone else…')}
          aria-label="Ask the brain"
          autoFocus={autoFocus}
          className="h-9 min-w-0 flex-1 bg-transparent text-[13.5px] text-t1 outline-none placeholder:text-t3"
        />
        <Button type="submit" size="sm" variant="primary" loading={asking} disabled={!question.trim()} aria-label="Ask">
          <Send className="size-3.5" />
        </Button>
      </form>
      {error && <p className="text-[12px] text-rd">{error}</p>}
      {answer && (
        <div className="space-y-3 rounded-2xl border border-hair bg-sf px-4 py-3.5 animate-fade-up">
          {answer.answer ? (
            <>
              <WrittenBy model={answer.model} />
              <WikiText text={answer.answer} links={answer.links} onCite={cite} />
            </>
          ) : (
            <p className="text-[12px] text-t3">{answer.note ?? (answer.model ? 'The brain found nothing to answer from.' : 'No model is set for the brain (LANDFLOW_BRAIN_MODEL), so here is what it found.')}</p>
          )}
          {answer.pages.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
              <span className="text-t3">Pages</span>
              {answer.pages.map((p) => (
                <PageLink key={`${p.type}/${p.id}`} refId={`${p.type}/${p.id}`} name={p.name} />
              ))}
            </div>
          )}
          {answer.facts.length > 0 && (
            <ul className="space-y-1 text-[12px] text-t2">
              {answer.facts.slice(0, 6).map((f) => (
                <li key={f.id}>
                  <span className="font-medium text-t1">{f.subjectName ?? f.subjectId}</span> · {f.statement}
                </li>
              ))}
            </ul>
          )}
          {answer.work.length > 0 && <WorkList items={answer.work} names={names} numbered highlight={cited} />}
        </div>
      )}
    </div>
  );
}

/** A titled section of a page. */
export function Section({ title, count, action, children, id }: { title: string; count?: number; action?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="space-y-2.5">
      <div className="flex items-center gap-2">
        <h2 className="text-[13px] font-semibold text-t1">{title}</h2>
        {count !== undefined && <span className="text-[12px] tabular-nums text-t3">{count}</span>}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </section>
  );
}
