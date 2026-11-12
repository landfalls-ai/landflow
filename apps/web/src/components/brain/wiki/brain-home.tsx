'use client';
/**
 * /brain: the second brain as a wiki (docs/second-brain.md#the-brain-page). Ask on top; then a briefing of the week —
 * what more than one team worked on, the open suggestions, the teams, the pages that need a person; the directory of
 * every page; the latest work; and how the brain works (status, facts, detectors), which was "What Landflow knows" on
 * Insights. One column, cards, so a phone reads it as it is.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, Users } from 'lucide-react';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import type { EntityType } from '@/lib/shared/brain';
import type { SharedWork, WikiEntry, WikiHome } from '@/lib/shared/brain-wiki';
import { Card, PageBody, PageHeader } from '../../shell/page-header';
import { Chip } from '../../ui/badge';
import { EmptyState } from '../../ui/empty-state';
import { BrainPanel } from '../brain-panel';
import { ProposalCard, useProposalActions } from '../proposal-card';
import { AskBox, kindLabel, PageLink, pageHref, Section, TYPE_ICON, TYPE_PLURAL, WorkList } from './parts';

const TYPES: EntityType[] = ['initiative', 'customer', 'person', 'system'];

export function BrainHome() {
  const [home, setHome] = useState<WikiHome>();
  const [failed, setFailed] = useState<string>();
  const load = useCallback(() => {
    api<WikiHome>('/api/brain/wiki')
      .then(setHome)
      .catch((e: Error) => setFailed(e.message));
  }, []);
  useEffect(load, [load]);

  const names = useMemo(() => new Map((home?.entries ?? []).map((e) => [`${e.type}/${e.id}`, e.name])), [home]);
  const actions = useProposalActions({ onDone: (id) => setHome((h) => h && { ...h, proposals: h.proposals.filter((p) => p.id !== id) }) });

  const meta = home ? `${home.entries.length.toLocaleString()} pages · ${home.status.facts.toLocaleString()} facts · ${home.recent.length ? `last work ${timeAgo(home.recent[0].at)}` : 'no work yet'}` : undefined;
  return (
    <>
      <PageHeader title="Brain" meta={meta} />
      <PageBody className="mx-auto w-full max-w-3xl space-y-7">
        <AskBox autoFocus />
        {failed && <p className="text-[12px] text-rd">{failed}</p>}
        {!home && !failed && <div className="h-40 rounded-2xl bg-acdim animate-pulse-soft" />}
        {home && (
          <>
            {!home.entries.length && !home.recent.length ? (
              <EmptyState
                title="The brain has no pages yet"
                hint="Pages come from the work flows (Slack, Drive, Calendar, Notion, Linear, Attio, Fathom): each names the people, customers and initiatives it touches. Install one from Templates, or add an entity with the API."
                action={
                  <Link href="/templates" className="text-[13px] font-medium text-ac hover:underline">
                    Find the work templates
                  </Link>
                }
              />
            ) : (
              <>
                <Section title="Shared across teams" count={home.shared.length} id="shared">
                  <p className="-mt-1 text-[12px] text-t3">Customers and initiatives more than one team worked on in the last {home.days} days. Worth a look: the same work twice, or a chance to talk.</p>
                  {home.shared.length ? (
                    <div className="space-y-2.5">
                      {home.shared.slice(0, 8).map((s) => (
                        <SharedCard key={s.ref} shared={s} names={names} />
                      ))}
                    </div>
                  ) : (
                    <p className="text-[12px] text-t3">Nothing this week: every page was worked on by one team.</p>
                  )}
                </Section>

                {home.proposals.length > 0 && (
                  <Section title="Suggestions" count={home.proposals.length}>
                    <div className="space-y-2">
                      {home.proposals.slice(0, 5).map((p) => (
                        <ProposalCard key={p.id} proposal={p} actions={actions} compact />
                      ))}
                    </div>
                  </Section>
                )}

                {home.teams.length > 0 && (
                  <Section title="Teams this week" count={home.teams.length}>
                    <div className="grid gap-2.5 sm:grid-cols-2">
                      {home.teams.map((t) => (
                        <Card key={t.team} className="space-y-1.5">
                          <div className="flex items-baseline gap-2">
                            <span className="text-[13px] font-semibold text-t1">{t.team}</span>
                            <span className="ml-auto text-[11px] tabular-nums text-t3">
                              {t.events} item{t.events === 1 ? '' : 's'} · {t.people} {t.people === 1 ? 'person' : 'people'}
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-x-2 gap-y-1 text-[12px]">
                            {t.top.length ? t.top.map((p) => <PageLink key={p.ref} refId={p.ref} name={`${p.name} (${p.events})`} className="font-normal" />) : <span className="text-t3">No pages named</span>}
                          </div>
                        </Card>
                      ))}
                    </div>
                  </Section>
                )}

                <Health home={home} />

                <Directory entries={home.entries} />

                <Section title="Latest work" count={home.recent.length}>
                  <div className="-mt-1 flex flex-wrap gap-1.5">
                    {home.kinds.map((k) => (
                      <Chip key={k.kind} className="text-[11px]">
                        {kindLabel(k.kind)} · {k.events}
                      </Chip>
                    ))}
                  </div>
                  <WorkList items={home.recent} names={names} />
                </Section>
              </>
            )}

            <BrainPanel />
          </>
        )}
      </PageBody>
    </>
  );
}

function SharedCard({ shared, names }: { shared: SharedWork; names: Map<string, string> }) {
  const Icon = TYPE_ICON[shared.type];
  return (
    <Card className="space-y-2.5 border-viz-7/40">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-viz-7" aria-hidden />
        <div className="min-w-0 flex-1">
          <Link href={pageHref(shared.ref)} className="text-[14px] font-semibold text-t1 hover:text-ac hover:underline">
            {shared.name}
          </Link>
          <div className="text-[11.5px] text-t3">
            {shared.teams.length} teams · {shared.events} item{shared.events === 1 ? '' : 's'} · {timeAgo(shared.lastAt)}
          </div>
        </div>
        <Link href={pageHref(shared.ref)} className="shrink-0 text-t3 hover:text-ac" aria-label={`Open ${shared.name}`}>
          <ArrowRight className="size-4" />
        </Link>
      </div>
      <ul className="space-y-1">
        {shared.teams.map((t) => (
          <li key={t.team} className="flex items-baseline gap-2 text-[12px]">
            <Users className="size-3 shrink-0 translate-y-0.5 text-t3" aria-hidden />
            <span className="font-medium text-t1">{t.team}</span>
            <span className="min-w-0 truncate text-t3">
              {t.events} · {t.people.join(', ') || 'unknown'}
            </span>
          </li>
        ))}
      </ul>
      <WorkList items={shared.latest.slice(0, 2)} names={names} />
    </Card>
  );
}

function Health({ home }: { home: WikiHome }) {
  const { noOwner, quiet, staleSummaries } = home.health;
  const rows = [
    { label: 'No owner', hint: 'Set who owns it, so the brain knows who to ask', pages: noOwner },
    { label: 'Quiet for 30 days', hint: 'Done, paused or forgotten?', pages: quiet },
    { label: 'Summary behind its work', hint: 'Open it to write the summary again', pages: staleSummaries },
  ].filter((r) => r.pages.length);
  if (!rows.length) return null;
  return (
    <Section title="Needs a person" count={rows.reduce((n, r) => n + r.pages.length, 0)}>
      <Card className="divide-y divide-hair p-0">
        {rows.map((r) => (
          <div key={r.label} className="space-y-1 px-4 py-3">
            <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-t1">
              <AlertTriangle className="size-3.5 text-warn" aria-hidden />
              {r.label}
              <span className="font-normal text-t3">· {r.hint}</span>
            </div>
            <div className="flex flex-wrap gap-x-2.5 gap-y-1 text-[12px]">
              {r.pages.slice(0, 12).map((p) => (
                <PageLink key={p.ref} refId={p.ref} name={p.name} className="font-normal" />
              ))}
              {r.pages.length > 12 && <span className="text-t3">and {r.pages.length - 12} more</span>}
            </div>
          </div>
        ))}
      </Card>
    </Section>
  );
}

function Directory({ entries }: { entries: WikiEntry[] }) {
  const [type, setType] = useState<EntityType | 'all'>('all');
  const [text, setText] = useState('');
  const counts = useMemo(() => Object.fromEntries(TYPES.map((t) => [t, entries.filter((e) => e.type === t).length])) as Record<EntityType, number>, [entries]);
  const q = text.trim().toLowerCase();
  const shown = entries
    .filter((e) => (type === 'all' || e.type === type) && (!q || `${e.name} ${e.description ?? ''} ${e.owner ?? ''} ${e.teams.join(' ')}`.toLowerCase().includes(q)))
    .sort((a, b) => b.week - a.week || b.month - a.month || (b.lastAt ?? '').localeCompare(a.lastAt ?? '') || a.name.localeCompare(b.name));
  const [limit, setLimit] = useState(30);
  return (
    <Section title="Pages" count={entries.length} id="pages">
      <div className="flex flex-wrap items-center gap-1.5">
        {(['all', ...TYPES] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setType(t)}
            className={cn('rounded-full border px-2.5 py-1 text-[12px]', type === t ? 'border-ac bg-acdim text-ac' : 'border-hair text-t2 hover:text-t1')}
            aria-pressed={type === t}
          >
            {t === 'all' ? `All ${entries.length}` : `${TYPE_PLURAL[t]} ${counts[t]}`}
          </button>
        ))}
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Filter pages"
          aria-label="Filter pages"
          className="ml-auto h-8 w-full rounded-full border border-hair bg-sf px-3 text-[12.5px] text-t1 outline-none placeholder:text-t3 focus:border-ac sm:w-48"
        />
      </div>
      {shown.length ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {shown.slice(0, limit).map((e) => (
            <EntryCard key={`${e.type}/${e.id}`} entry={e} />
          ))}
        </div>
      ) : (
        <p className="text-[12px] text-t3">No page matches.</p>
      )}
      {shown.length > limit && (
        <button type="button" onClick={() => setLimit((n) => n + 60)} className="text-[12px] font-medium text-ac hover:underline">
          Show more ({shown.length - limit})
        </button>
      )}
    </Section>
  );
}

function EntryCard({ entry }: { entry: WikiEntry }) {
  const Icon = TYPE_ICON[entry.type];
  return (
    <Link href={pageHref(`${entry.type}/${entry.id}`)} className="group block rounded-2xl border border-hair bg-sf px-3.5 py-3 hover:border-ac">
      <div className="flex items-center gap-2">
        <Icon className="size-3.5 shrink-0 text-t3 group-hover:text-ac" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-t1">{entry.name}</span>
        {entry.week > 0 && (
          <span className="shrink-0 rounded-full bg-acdim px-1.5 text-[11px] font-semibold tabular-nums text-ac" title="Work this week">
            {entry.week}
          </span>
        )}
      </div>
      {entry.description && <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-t2">{entry.description}</p>}
      <div className="mt-1.5 flex flex-wrap gap-x-2 text-[11px] text-t3">
        {entry.teams.slice(0, 3).map((t) => (
          <span key={t}>{t}</span>
        ))}
        <span className="ml-auto">{entry.lastAt ? timeAgo(entry.lastAt) : 'no work yet'}</span>
      </div>
    </Link>
  );
}
