'use client';
/**
 * An entity's file in the Brain workbench, as its Preview (docs/second-brain.md#the-brain-page). What a person keeps
 * (name, what it is, owner) apart from what the model writes: a summary with links to other pages and numbered
 * references to the work it read, marked as written by the brain, with when and which model, and "new work since" once
 * it is behind. Then the work, the people, the related pages, the facts, the suggestions and the pages that mention it,
 * each a section the Outline lists. Its Source view is `pageMarkdown` (lib/shared/brain-files.ts).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pencil, Plus, RefreshCw, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { ENTITY_LABELS, FACT_KINDS, type FactKind } from '@/lib/shared/brain';
import { peopleTitle } from '@/lib/shared/brain-files';
import type { WikiPage, WikiSummary } from '@/lib/shared/brain-wiki';
import { Card } from '../../shell/page-header';
import { Chip } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Input, Select, Textarea } from '../../ui/inputs';
import { ProposalCard, useProposalActions } from '../proposal-card';
import { PageLink, Section, sourceLabel, TYPE_ICON, WikiText, WorkList, WrittenBy } from './parts';

/** `onChanged` reloads the page (an edit, a fact, a decided suggestion); `onSummary` keeps a new summary without a reload. */
export function PageDoc({ page, onChanged, onSummary }: { page: WikiPage; onChanged: () => void; onSummary: (summary: WikiSummary) => void }) {
  const ref = `${page.entity.type}/${page.entity.id}`;
  const [cited, setCited] = useState<number>();
  const names = useMemo(() => {
    const out = new Map<string, string>([[ref, page.entity.name]]);
    for (const r of page.related) out.set(r.ref, r.name);
    for (const p of page.people) if (p.ref) out.set(p.ref, p.name);
    for (const l of page.summary?.links ?? []) out.set(l.ref, l.name);
    return out;
  }, [page, ref]);
  const actions = useProposalActions({ onDone: onChanged });
  const cite = (n: number) => {
    setCited(n);
    document.getElementById(`work-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const sources = [...new Set(page.work.map((w) => sourceLabel(w.source)))];
  const Icon = TYPE_ICON[page.entity.type];

  return (
    <article className="space-y-7">
      <Header page={page} sources={sources} onSaved={onChanged} Icon={Icon} />
      <Section title="Summary">
        <SummaryCard page={page} onCite={cite} onWritten={onSummary} />
      </Section>

      <Section title="Work" count={page.work.length}>
        <p className="-mt-1 text-[12px] text-t3">What the work flows recorded naming this page in the last 90 days, newest first. The numbers are what the summary cites.</p>
        <WorkList items={page.work} names={names} numbered highlight={cited} empty="No work names this page yet." />
      </Section>

      {page.people.length > 0 && (
        <Section title={peopleTitle(page.entity.type)} count={page.people.length}>
          <div className="divide-y divide-hair rounded-xl border border-hair">
            {page.people.map((p) => (
              <div key={p.ref ?? p.email ?? p.name} className="flex items-center gap-2 px-3 py-2 text-[12.5px]">
                {p.ref ? <PageLink refId={p.ref} name={p.name} /> : <span className="font-medium text-t1">{p.name}</span>}
                {p.team && <span className="text-t3">{p.team}</span>}
                <span className="ml-auto tabular-nums text-t3">
                  {p.events} item{p.events === 1 ? '' : 's'}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {page.related.length > 0 && (
        <Section title="Related pages" count={page.related.length}>
          <div className="flex flex-wrap gap-2">
            {page.related.map((r) => (
              <span key={r.ref} className="inline-flex items-center gap-1 rounded-full border border-hair bg-sf px-2.5 py-0.5 text-[12.5px]">
                <PageLink refId={r.ref} name={r.name} />
                <span className="text-[11px] tabular-nums text-t3" title="Work items naming both">
                  {r.shared}
                </span>
              </span>
            ))}
          </div>
        </Section>
      )}

      <Facts page={page} onAdded={onChanged} />

      {page.proposals.length > 0 && (
        <Section title="Suggestions" count={page.proposals.length}>
          <div className="space-y-2">
            {page.proposals.map((p) => (
              <ProposalCard key={p.id} proposal={p} actions={actions} compact />
            ))}
          </div>
        </Section>
      )}

      {page.mentionedIn.length > 0 && (
        <Section title="Mentioned in" count={page.mentionedIn.length}>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12.5px]">
            {page.mentionedIn.map((m) => (
              <PageLink key={m.ref} refId={m.ref} name={m.name} />
            ))}
          </div>
        </Section>
      )}

      <p className="text-[11.5px] text-t3">
        Added by {page.entity.source} {timeAgo(page.entity.createdAt)} · changed {timeAgo(page.entity.updatedAt)}
      </p>
    </article>
  );
}

function Header({ page, sources, onSaved, Icon }: { page: WikiPage; sources: string[]; onSaved: () => void; Icon: (typeof TYPE_ICON)[keyof typeof TYPE_ICON] }) {
  const { entity } = page;
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(entity.description ?? '');
  const [owner, setOwner] = useState(entity.owner ?? '');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api(`/api/entities/${entity.type}/${encodeURIComponent(entity.id)}`, { method: 'PATCH', json: { description, owner } });
      setEditing(false);
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const email = typeof entity.attrs.email === 'string' ? entity.attrs.email : undefined;
  const department = typeof entity.attrs.department === 'string' ? entity.attrs.department : undefined;
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-acdim text-ac">
          <Icon className="size-4.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-[24px] font-semibold leading-tight text-t1 [overflow-wrap:anywhere]">{entity.name}</h1>
          <div className="mt-0.5 text-[12px] text-t3">
            {ENTITY_LABELS[entity.type]}
            {email && ` · ${email}`}
            {department && ` · ${department}`}
          </div>
        </div>
        {page.canEdit && !editing && (
          <Button size="icon-sm" variant="ghost" onClick={() => setEditing(true)} aria-label="Edit">
            <Pencil className="size-3.5" />
          </Button>
        )}
      </div>

      {editing ? (
        <Card className="space-y-2.5">
          <label className="block space-y-1">
            <span className="text-[11.5px] font-medium text-t2">What it is</span>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={1000} />
          </label>
          <label className="block space-y-1">
            <span className="text-[11.5px] font-medium text-t2">Owner</span>
            <Input value={owner} onChange={(e) => setOwner(e.target.value)} maxLength={120} placeholder="A person or a team" />
          </label>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={() => void save()} loading={saving}>
              Save
            </Button>
          </div>
        </Card>
      ) : (
        entity.description && <p className="text-[13.5px] leading-relaxed text-t1">{entity.description}</p>
      )}

      <div className="flex flex-wrap gap-1.5 text-[11.5px]">
        {(entity.owner || entity.type !== 'person') && <Chip tone={entity.owner ? 'neutral' : 'warning'}>Owner: {entity.ownerName ?? entity.owner ?? 'none'}</Chip>}
        {page.teams.map((t) => (
          <Chip key={t.team} tone="accent">
            {t.team} · {t.events}
          </Chip>
        ))}
        {sources.map((s) => (
          <Chip key={s}>{s}</Chip>
        ))}
        <Chip tone="muted">{page.work.length ? `last work ${timeAgo(page.work[0].at)}` : 'no work yet'}</Chip>
      </div>
    </div>
  );
}

/**
 * The summary the brain wrote. Written once by itself when the page has none and there is a model; again on Regenerate.
 * Without a model, says how to set one.
 */
function SummaryCard({ page, onCite, onWritten }: { page: WikiPage; onCite: (n: number) => void; onWritten: (summary: WikiSummary) => void }) {
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string>();
  const tried = useRef(false);
  const { entity } = page;
  const write = useCallback(async () => {
    setWriting(true);
    setError(undefined);
    try {
      const { summary } = await api<{ summary: WikiSummary }>(`/api/brain/wiki/${entity.type}/${encodeURIComponent(entity.id)}/summary`, { method: 'POST' });
      onWritten(summary);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWriting(false);
    }
  }, [entity.type, entity.id, onWritten]);

  const hasMaterial = page.work.length > 0 || page.facts.length > 0 || Boolean(entity.description);
  useEffect(() => {
    if (tried.current || page.summary || !page.model || !hasMaterial) return;
    tried.current = true;
    void write();
  }, [page.summary, page.model, hasMaterial, write]);

  if (!page.model) {
    return (
      <Card className="space-y-1">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-t2">
          <Sparkles className="size-3.5 text-viz-7" aria-hidden />
          No summary
        </div>
        <p className="text-[12px] text-t3">The brain writes a summary of each page when it has a model. Set LANDFLOW_BRAIN_MODEL (for example anthropic/claude-sonnet-5-5) and open the page again.</p>
      </Card>
    );
  }
  const { summary } = page;
  return (
    <Card className="space-y-2.5 border-viz-7/30">
      <WrittenBy model={summary?.model} at={summary?.generatedAt} stale={summary?.stale}>
        <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[11px]" onClick={() => void write()} loading={writing} disabled={!hasMaterial} title="Write the summary again from what the page has now">
          <RefreshCw className="size-3" />
          {summary ? 'Regenerate' : 'Write'}
        </Button>
      </WrittenBy>
      {summary ? (
        <WikiText text={summary.text} links={summary.links} onCite={onCite} />
      ) : writing ? (
        <div className="space-y-2">
          <div className="h-3 w-full rounded bg-acdim animate-pulse-soft" />
          <div className="h-3 w-11/12 rounded bg-acdim animate-pulse-soft" />
          <div className="h-3 w-3/4 rounded bg-acdim animate-pulse-soft" />
        </div>
      ) : (
        <p className="text-[12px] text-t3">{hasMaterial ? 'No summary yet.' : 'Nothing to write from yet: no work, facts or description.'}</p>
      )}
      {error && <p className="text-[12px] text-rd">{error}</p>}
    </Card>
  );
}

/** What the brain holds about the page, as statements; editors add one. */
function Facts({ page, onAdded }: { page: WikiPage; onAdded: () => void }) {
  const { entity } = page;
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<FactKind>('purpose');
  const [statement, setStatement] = useState('');
  const [saving, setSaving] = useState(false);
  const add = async () => {
    setSaving(true);
    try {
      await api(`/api/entities/${entity.type}/${encodeURIComponent(entity.id)}/facts`, { method: 'POST', json: { kind, statement } });
      setStatement('');
      setAdding(false);
      onAdded();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  if (!page.facts.length && !page.canEdit) return null;
  return (
    <Section
      title="Facts"
      count={page.facts.length}
      action={
        page.canEdit &&
        !adding && (
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            Add a fact
          </Button>
        )
      }
    >
      {adding && (
        <Card className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Select value={kind} onChange={(e) => setKind(e.target.value as FactKind)} aria-label="Kind" className="w-36">
              {FACT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
            <Input value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="Acme renews in March; the pilot covers two teams" className="min-w-0 flex-1" maxLength={1000} />
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={() => void add()} loading={saving} disabled={!statement.trim()}>
              Add
            </Button>
          </div>
        </Card>
      )}
      {page.facts.length > 0 ? (
        <Card className="divide-y divide-hair p-0">
          {page.facts.map((f) => (
            <div key={f.id} className="space-y-0.5 px-4 py-2.5 text-[12.5px]">
              <div className="text-t1 [overflow-wrap:anywhere]">{f.statement}</div>
              <div className="text-[11px] text-t3">
                {f.kind} · {Math.round(f.confidence * 100)}% · seen {timeAgo(f.lastSeen)}
              </div>
            </div>
          ))}
        </Card>
      ) : (
        !adding && <p className="text-[12px] text-t3">No facts yet.</p>
      )}
    </Section>
  );
}
