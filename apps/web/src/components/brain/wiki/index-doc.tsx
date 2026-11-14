'use client';
/**
 * `index.md` and `log.md` in the Brain workbench, as their Preview (docs/second-brain.md#the-brain-page). The index is
 * the week's briefing: what two or more teams worked on (the overlap the brain is for), the open suggestions, each
 * team's week and the pages that need a person. The log is the latest work, a heading per day. Their Source views are
 * `indexMarkdown` and `logMarkdown` (lib/shared/brain-files.ts).
 */
import { useMemo } from 'react';
import { AlertTriangle, Users } from 'lucide-react';
import { timeAgo } from '@/lib/client/format';
import { byDay, FOLDERS } from '@/lib/shared/brain-files';
import type { SharedWork, WikiHome } from '@/lib/shared/brain-wiki';
import { Card } from '../../shell/page-header';
import { Chip } from '../../ui/badge';
import { ProposalCard, useProposalActions } from '../proposal-card';
import { kindLabel, PageLink, Section, TYPE_ICON, WorkList } from './parts';

const namesOf = (home: WikiHome) => new Map(home.entries.map((e) => [`${e.type}/${e.id}`, e.name]));

export function IndexDoc({ home, onChanged }: { home: WikiHome; onChanged: () => void }) {
  const names = useMemo(() => namesOf(home), [home]);
  const actions = useProposalActions({ onDone: onChanged });
  return (
    <article className="space-y-7">
      <header className="space-y-1.5">
        <h1 className="text-[24px] font-semibold text-t1">Brain</h1>
        <p className="text-[13px] leading-relaxed text-t2">
          {home.entries.length} pages: {FOLDERS.map(({ type, folder }) => `${home.entries.filter((e) => e.type === type).length} ${folder}`).join(', ')}. What the work flows recorded in Slack, Drive,
          Calendar, Notion, Linear, Attio and Fathom, read as a wiki. Open a page from the Explorer, or press Ask to ask the brain.
        </p>
      </header>

      <Section title="Shared across teams" count={home.shared.length}>
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
                  {t.top.length ? t.top.map((p) => <PageLink key={p.ref} refId={p.ref} name={`${names.get(p.ref) ?? p.name} (${p.events})`} className="font-normal" />) : <span className="text-t3">No pages named</span>}
                </div>
              </Card>
            ))}
          </div>
        </Section>
      )}

      <Health home={home} />
    </article>
  );
}

export function LogDoc({ home }: { home: WikiHome }) {
  const names = useMemo(() => namesOf(home), [home]);
  return (
    <article className="space-y-7">
      <header className="space-y-1.5">
        <h1 className="text-[24px] font-semibold text-t1">Log</h1>
        <p className="text-[13px] text-t2">The latest {home.recent.length} work items the work flows recorded, newest first.</p>
        <div className="flex flex-wrap gap-1.5 pt-1">
          {home.kinds.map((k) => (
            <Chip key={k.kind} className="text-[11px]">
              {kindLabel(k.kind)} · {k.events}
            </Chip>
          ))}
        </div>
      </header>
      {home.recent.length ? (
        byDay(home.recent).map(([date, items]) => (
          <Section key={date} title={date}>
            <WorkList items={items} names={names} />
          </Section>
        ))
      ) : (
        <p className="text-[12px] text-t3">No work yet. Install a work template (Templates → work) to fill the brain.</p>
      )}
    </article>
  );
}

function SharedCard({ shared, names }: { shared: SharedWork; names: Map<string, string> }) {
  const Icon = TYPE_ICON[shared.type];
  return (
    <Card className="space-y-2.5 border-viz-7/40">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-viz-7" aria-hidden />
        <div className="min-w-0 flex-1">
          <PageLink refId={shared.ref} name={shared.name} className="px-0 text-[14px] font-semibold text-t1 [&>svg]:hidden" />
          <div className="text-[11.5px] text-t3">
            {shared.teams.length} teams · {shared.events} item{shared.events === 1 ? '' : 's'} · {timeAgo(shared.lastAt)}
          </div>
        </div>
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

