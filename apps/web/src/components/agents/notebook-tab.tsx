'use client';
/**
 * The Notebook tab of a team's page (docs/team-notebook.md#the-notebook-tab): what the team has written down while it
 * works, in one column of cards that reads on a phone. Open questions, decisions and facts are groups; a note shows who
 * wrote it (their face), where it came from (a link into the Run Trace), how long it has left, and what you can do with it:
 * Verify, Dispute, Promote, Answer, Delete. Two notes that disagree sit side by side until you pick the one that holds.
 * New notes settle in with a ring of their author's colour while the page polls, so a run can be watched writing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Check, ChevronsUp, CircleHelp, Clock, ExternalLink, Flag, Gavel, Inbox, Link2, MessageCircleReply, NotebookPen, Plus, RotateCcw, Scale, Search, ShieldCheck, Sparkles, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { AgentSummary } from '@/lib/shared/agents';
import { NOTE_KINDS, NOTE_KIND_LABEL, type NoteCounts, type NoteKind, type NoteScope, type TeamNote } from '@/lib/shared/notebook';
import { expiryView, groupNotes, hostOf, statusLabel, traceHref, type DisputePair } from '@/lib/shared/notebook-view';
import { cn } from '@/lib/utils';
import { Badge, Chip, type Tone } from '../ui/badge';
import { Button } from '../ui/button';
import { Input, Select, Textarea } from '../ui/inputs';
import { AgentAvatar } from './avatar';
import { faceOf } from './faces';

interface Face {
  title: string;
  agent?: AgentSummary;
}

type Listed = { notes: Array<TeamNote & { score?: number }>; counts: NoteCounts; via?: 'meaning' | 'keywords' };
type Scope = 'all' | NoteScope;

const STATUS_TONE: Record<string, Tone> = { verified: 'success', unverified: 'muted', unchecked: 'warning', disputed: 'danger', open: 'warning', answered: 'success', expired: 'muted' };
/** The colour at a card's left edge, by what the note is. */
const KIND_COLOR: Record<NoteKind, string> = {
  open_question: 'var(--warn)',
  decision: 'var(--ac)',
  fact: 'var(--t3)',
  task_status: 'var(--viz-3)',
  artifact_ref: 'var(--viz-5)',
};
const POLL_MS = 5_000;

export function NotebookTab({ teamId, faces }: { teamId: string; faces: Face[] }) {
  const [data, setData] = useState<Listed>();
  const [error, setError] = useState<string>();
  const [scope, setScope] = useState<Scope>('all');
  const [kind, setKind] = useState<NoteKind>();
  const [query, setQuery] = useState('');
  const [asked, setAsked] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string>();
  // Notes that arrived while the tab was open ring once; the ones fading after a dispute was settled.
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [fading, setFading] = useState<Set<string>>(new Set());
  const known = useRef<Set<string> | undefined>(undefined);

  useEffect(() => {
    const timer = setTimeout(() => setAsked(query.trim()), 350);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (scope !== 'all') params.set('scope', scope);
    if (kind) params.set('kind', kind);
    if (asked) params.set('q', asked);
    try {
      const next = await api<Listed>(`/api/agent-teams/${teamId}/notes${params.size ? `?${params}` : ''}`);
      setData(next);
      setError(undefined);
      const ids = new Set(next.notes.map((n) => n.id));
      if (known.current && !asked) {
        const arrived = next.notes.filter((n) => !known.current!.has(n.id)).map((n) => n.id);
        if (arrived.length) {
          setFresh((f) => new Set([...f, ...arrived]));
          setTimeout(() => setFresh((f) => new Set([...f].filter((id) => !arrived.includes(id)))), 3200);
        }
      }
      if (!asked) known.current = ids;
    } catch (e) {
      setError((e as Error).message);
    }
  }, [teamId, scope, kind, asked]);

  useEffect(() => {
    void load();
    // A run writes while you watch: look again every few seconds, unless a search is on screen.
    if (asked) return;
    const timer = setInterval(() => document.visibilityState === 'visible' && void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load, asked]);

  const act = async (note: TeamNote, body: Record<string, unknown>, done?: (result: Record<string, unknown>) => void) => {
    setBusy(note.id);
    try {
      const result = await api<Record<string, unknown>>(`/api/agent-teams/${teamId}/notes/${note.id}`, { method: 'POST', json: body });
      done?.(result);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const forget = async (note: TeamNote) => {
    setBusy(note.id);
    try {
      await api(`/api/agent-teams/${teamId}/notes/${note.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const promote = (note: TeamNote) =>
    act(note, { action: 'promote', to: note.scope === 'run' ? 'team' : 'project' }, (result) => {
      if (result.to === 'project') toast.success('Suggested for the project: approve it in your inbox on Home');
      else toast.success('Promoted to the team: every later run finds it');
    });
  const settle = (pair: DisputePair, keep: TeamNote) => {
    const loser = keep.id === pair.original.id ? pair.challenge : pair.original;
    setFading((f) => new Set(f).add(loser.id));
    void act(keep, { action: 'resolve', keep: keep.id }, () => toast.success(`Kept “${keep.text.length > 50 ? `${keep.text.slice(0, 49)}…` : keep.text}”`)).finally(() => setFading((f) => new Set([...f].filter((id) => id !== loser.id))));
  };

  const faceOfAuthor = useMemo(() => new Map(faces.map((f) => [f.title.toLowerCase(), f])), [faces]);
  const groups = useMemo(() => groupNotes(data?.notes ?? []), [data]);
  const searching = Boolean(asked);
  const counts = data?.counts;
  const live = (data?.notes ?? []).some((n) => Date.now() - Date.parse(n.createdAt) < 90_000);

  const cardFor = (note: TeamNote & { score?: number }, side?: 'original' | 'challenge') => (
    <NoteCard
      key={note.id}
      note={note}
      face={faceOfAuthor.get(note.author.toLowerCase())}
      busy={busy === note.id}
      fresh={fresh.has(note.id)}
      fading={fading.has(note.id)}
      side={side}
      onAction={(body, done) => act(note, body, done)}
      onPromote={() => void promote(note)}
      onDelete={() => void forget(note)}
    />
  );

  return (
    <section aria-label="Notebook" className="flex flex-col gap-3.5" data-testid="team-notebook">
      <div className="grid grid-cols-3 gap-2">
        <Tile label="Open questions" n={counts?.open} tone="warn" active={kind === 'open_question'} onClick={() => setKind(kind === 'open_question' ? undefined : 'open_question')} icon={<CircleHelp className="size-3.5" />} />
        <Tile label="Decisions" n={counts?.decisions} tone="ac" active={kind === 'decision'} onClick={() => setKind(kind === 'decision' ? undefined : 'decision')} icon={<Gavel className="size-3.5" />} />
        <Tile label="Facts" n={counts?.facts} tone="t3" active={kind === 'fact'} onClick={() => setKind(kind === 'fact' ? undefined : 'fact')} icon={<NotebookPen className="size-3.5" />} />
      </div>

      <div className="flex flex-col gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-t3" />
          <Input aria-label="Search the notebook" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by meaning: how do plugins declare icons?" className="pl-8" />
        </div>
        <div className="flex items-center gap-2">
          <div role="tablist" aria-label="Scope" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
            {(['all', 'run', 'team', 'project'] as const).map((s) => (
              <button
                key={s}
                role="tab"
                aria-selected={scope === s}
                onClick={() => setScope(s)}
                className={cn('shrink-0 rounded-full border px-2.5 py-0.5 text-[12px] font-semibold capitalize transition-colors', scope === s ? 'border-acbd bg-acdim text-ac' : 'border-hair text-t2 hover:border-ac')}
              >
                {s === 'all' ? 'Everything' : s === 'run' ? 'Runs' : s}
              </button>
            ))}
          </div>
          {live && (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-semibold text-gn" title="A note arrived in the last minute and a half">
              <span className="size-1.5 animate-pulse-soft rounded-full bg-gn" /> Live
            </span>
          )}
          <Button size="sm" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
            <Plus className="size-3.5" strokeWidth={2} /> Note
          </Button>
        </div>
        {searching && data?.via && (
          <p className="flex items-center gap-1.5 text-[12px] text-t3" role="status">
            <Sparkles className="size-3.5 text-ac" />
            {data.via === 'meaning' ? 'Matched by meaning.' : 'Matched by words: the embedding model isn’t answering, so only shared words count.'}
          </p>
        )}
      </div>

      {adding && <AddNote teamId={teamId} onDone={() => (setAdding(false), void load())} />}

      {error && (
        <p role="alert" className="rounded-[12px] border border-rdbd bg-rddim px-3 py-2 text-[12px] text-rd">
          {error}
        </p>
      )}
      {!data && !error && <div className="h-[140px] animate-pulse-soft rounded-2xl border border-hair bg-sf" />}
      {data && data.notes.length === 0 && <Empty searching={searching} filtered={scope !== 'all' || Boolean(kind)} />}

      {searching ? (
        <div className="flex flex-col gap-2.5">{data?.notes.map((n) => cardFor(n))}</div>
      ) : (
        <>
          {groups.pairs.length > 0 && (
            <Group title="Disputes" count={groups.pairs.length} icon={<Scale className="size-3.5 text-rd" />} hint="Two notes disagree. Keep the one that holds.">
              {groups.pairs.map((pair) => (
                <div key={pair.challenge.id} className="grid gap-2.5 rounded-2xl border border-rdbd bg-rddim/40 p-2.5 sm:grid-cols-2" data-testid="dispute-pair">
                  {[pair.original, pair.challenge].map((note, i) => (
                    <div key={note.id} className="flex flex-col gap-1.5">
                      <div className="px-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{i === 0 ? 'What was noted' : 'What disagrees'}</div>
                      {cardFor(note, i === 0 ? 'original' : 'challenge')}
                      <Button size="sm" variant="primary" disabled={busy === note.id} onClick={() => settle(pair, note)}>
                        <Check className="size-3.5" strokeWidth={2.2} /> Keep this one
                      </Button>
                    </div>
                  ))}
                </div>
              ))}
            </Group>
          )}
          {groups.questions.length > 0 && (
            <Group title="Open questions" count={groups.questions.length} icon={<CircleHelp className="size-3.5 text-warn" />}>
              {groups.questions.map((n) => cardFor(n))}
            </Group>
          )}
          {groups.decisions.length > 0 && (
            <Group title="Decisions" count={groups.decisions.length} icon={<Gavel className="size-3.5 text-ac" />}>
              {groups.decisions.map((n) => cardFor(n))}
            </Group>
          )}
          {groups.facts.length > 0 && (
            <Group title="Facts" count={groups.facts.length} icon={<NotebookPen className="size-3.5 text-t3" />}>
              {groups.facts.map((n) => cardFor(n))}
            </Group>
          )}
        </>
      )}
    </section>
  );
}

function Tile({ label, n, tone, active, onClick, icon }: { label: string; n?: number; tone: 'warn' | 'ac' | 't3'; active: boolean; onClick: () => void; icon: React.ReactNode }) {
  const color = tone === 'warn' ? 'text-warn' : tone === 'ac' ? 'text-ac' : 'text-t2';
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn('flex flex-col items-start gap-0.5 rounded-[12px] border px-3 py-2 text-left transition-colors', active ? 'border-acbd bg-acdim' : 'border-hair bg-sf hover:border-ac')}
    >
      {/* Keyed by the count: a changed number pops in. */}
      <span key={n} className={cn('animate-pop font-mono text-[20px] font-semibold leading-none tabular-nums', color)}>
        {n ?? '–'}
      </span>
      <span className="flex items-center gap-1 text-[11px] text-t3">
        {icon} {label}
      </span>
    </button>
  );
}

function Group({ title, count, icon, hint, children }: { title: string; count: number; icon: React.ReactNode; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-1.5">
        <h3 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-t3">
          {icon} {title} · {count}
        </h3>
        {hint && <span className="text-[12px] text-t3">{hint}</span>}
      </div>
      <div className="flex flex-col gap-2.5">{children}</div>
    </div>
  );
}

function Empty({ searching, filtered }: { searching: boolean; filtered: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-hair px-5 py-10 text-center" data-testid="notebook-empty">
      <span className="grid size-10 place-items-center rounded-full bg-acdim text-ac">
        <NotebookPen className="size-5" />
      </span>
      <p className="text-[13px] font-semibold text-t1">{searching ? 'Nothing matches' : filtered ? 'Nothing here' : 'The notebook is empty'}</p>
      <p className="max-w-[360px] text-[12px] leading-relaxed text-t3">
        {searching
          ? 'No note says anything like that. Try other words.'
          : filtered
            ? 'No note fits this filter.'
            : 'While the team works, its members write facts, decisions and open questions here. Notes from a run stay 14 days unless the lead promotes them to the team. You can write one too.'}
      </p>
    </div>
  );
}

function AddNote({ teamId, onDone }: { teamId: string; onDone: () => void }) {
  const [text, setText] = useState('');
  const [kind, setKind] = useState<NoteKind>('fact');
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    try {
      await api(`/api/agent-teams/${teamId}/notes`, { method: 'POST', json: { kind, text } });
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="animate-fade-up flex flex-col gap-2 rounded-[12px] border border-acbd bg-sf p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) void submit();
      }}
    >
      <Textarea aria-label="The note" rows={2} maxLength={600} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="One fact, decision or question the team should know" />
      <div className="flex items-center gap-2">
        <Select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as NoteKind)} className="w-auto">
          {NOTE_KINDS.map((k) => (
            <option key={k} value={k}>
              {NOTE_KIND_LABEL[k]}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="primary" size="sm" className="ml-auto" loading={saving} disabled={!text.trim()}>
          Add to the notebook
        </Button>
      </div>
    </form>
  );
}

interface CardProps {
  note: TeamNote & { score?: number };
  face?: Face;
  busy: boolean;
  fresh: boolean;
  fading: boolean;
  side?: 'original' | 'challenge';
  onAction: (body: Record<string, unknown>, done?: (result: Record<string, unknown>) => void) => Promise<void>;
  onPromote: () => void;
  onDelete: () => void;
}

function NoteCard({ note, face, busy, fresh, fading, side, onAction, onPromote, onDelete }: CardProps) {
  const [mode, setMode] = useState<'answer' | 'dispute' | 'delete'>();
  const [draft, setDraft] = useState('');
  const expiry = expiryView(note);
  const color = face?.agent ? faceOf(face.agent).color : undefined;
  const status = statusLabel(note);
  const href = traceHref(note);
  const host = hostOf(note.source.url);
  const locked = note.tainted && !note.verifiedAt;
  const isQuestion = note.kind === 'open_question';
  // A disputed note on its own (the other side is gone) can be verified; inside a pair you keep one.
  const canVerify = !side && note.status !== 'expired' && !note.verifiedAt && !isQuestion;
  const submit = (action: 'answer' | 'dispute') => {
    if (!draft.trim()) return;
    void onAction({ action, text: draft }, () => {
      setMode(undefined);
      setDraft('');
    });
  };
  return (
    <article
      data-note={note.id}
      style={{ '--note-glow': color ?? KIND_COLOR[note.kind] } as React.CSSProperties}
      className={cn('relative overflow-hidden rounded-[12px] border border-hair bg-sf py-3 pl-4 pr-3.5', fresh && 'animate-note-in', fading && 'animate-note-out', note.status === 'disputed' && 'border-rdbd')}
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-1" style={{ background: KIND_COLOR[note.kind] }} />
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <Badge tone={STATUS_TONE[status] ?? 'muted'}>{status}</Badge>
        {note.kind !== 'fact' && note.kind !== 'decision' && note.kind !== 'open_question' && <Chip className="py-0 text-[11px]">{NOTE_KIND_LABEL[note.kind]}</Chip>}
        <Chip className="py-0 text-[11px] capitalize">{note.scope}</Chip>
        {note.score !== undefined && (
          <span className="ml-auto font-mono text-[11px] tabular-nums text-t3" title="How well it matches your search">
            {Math.round(note.score * 100)}%
          </span>
        )}
      </div>
      <p className="animate-note-ink text-[13.5px] leading-snug text-t1">{note.text}</p>
      {note.answer && (
        <p className="mt-1.5 flex gap-1.5 rounded-lg bg-gndim px-2.5 py-1.5 text-[12.5px] leading-snug text-t1">
          <MessageCircleReply className="mt-0.5 size-3.5 shrink-0 text-gn" /> {note.answer}
        </p>
      )}
      {note.source.excerpt && <p className="mt-1.5 border-l-2 border-hair pl-2 text-[12px] italic text-t3">“{note.source.excerpt}”</p>}

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-t3">
        {face?.agent ? <AgentAvatar agent={faceOf(face.agent)} size={20} round /> : <span className="grid size-5 place-items-center rounded-full bg-acdim text-[10px] font-semibold text-t2">{note.author.charAt(0).toUpperCase()}</span>}
        <span className="font-medium text-t2">{note.author}</span>
        <span>·</span>
        <span title={new Date(note.createdAt).toLocaleString()}>{timeAgo(note.createdAt)}</span>
        {href && (
          <Link href={href} className="inline-flex items-center gap-1 font-semibold text-ac hover:underline" title="Open the step that wrote it in the Run Trace">
            <Link2 className="size-3" /> Run Trace
          </Link>
        )}
        {note.source.url && (
          <a href={note.source.url} target="_blank" rel="noreferrer" className="inline-flex max-w-[180px] items-center gap-1 truncate hover:text-t1">
            <ExternalLink className="size-3 shrink-0" /> <span className="truncate">{host}</span>
          </a>
        )}
      </div>

      {note.status !== 'expired' && (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-t3" title={note.expiresAt ? `Goes ${new Date(note.expiresAt).toLocaleDateString()} unless it is used or verified` : undefined}>
          <Clock className="size-3 shrink-0" />
          <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-hair" aria-hidden>
            <span className={cn('block h-full rounded-full transition-[width] duration-500', expiry.tone === 'ok' ? 'bg-gn' : expiry.tone === 'soon' ? 'bg-warn' : 'bg-rd')} style={{ width: `${Math.max(4, expiry.fraction * 100)}%` }} />
          </span>
          <span>{expiry.label}</span>
        </div>
      )}

      {locked && (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-warnbd bg-warndim px-2.5 py-1.5 text-[12px] leading-snug text-warn" role="note">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> Read from outside the team{host ? ` (${host})` : ''}. Check it, then verify it before it goes up.
        </p>
      )}
      {note.proposalId && (
        <Link href="/" className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-acbd bg-acdim px-2.5 py-0.5 text-[12px] font-semibold text-ac hover:underline">
          <Inbox className="size-3.5" /> Waiting in your inbox
        </Link>
      )}

      {!side && note.status !== 'expired' && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {isQuestion && note.status === 'open' && (
            <Button size="sm" variant="primary" onClick={() => setMode(mode === 'answer' ? undefined : 'answer')} aria-expanded={mode === 'answer'}>
              <MessageCircleReply className="size-3.5" /> Answer
            </Button>
          )}
          {isQuestion && note.status === 'answered' && (
            <Button size="sm" disabled={busy} onClick={() => void onAction({ action: 'reopen' })}>
              <RotateCcw className="size-3.5" /> Reopen
            </Button>
          )}
          {canVerify && (
            <Button size="sm" variant={locked ? 'primary' : 'outline'} disabled={busy} onClick={() => void onAction({ action: 'verify' }, () => toast.success('Verified'))}>
              <ShieldCheck className="size-3.5" /> Verify
            </Button>
          )}
          {note.status !== 'disputed' && (
            <Button size="sm" disabled={busy} onClick={() => setMode(mode === 'dispute' ? undefined : 'dispute')} aria-expanded={mode === 'dispute'}>
              <Flag className="size-3.5" /> Dispute
            </Button>
          )}
          {note.scope !== 'project' && note.status !== 'disputed' && !note.proposalId && !isQuestion && (
            <Button size="sm" disabled={busy || locked} title={locked ? 'Verify it first: it was read from outside the team' : note.scope === 'run' ? 'Keep it for every later run' : 'Suggest it for the project: you approve it in your inbox'} onClick={onPromote}>
              <ChevronsUp className="size-3.5" /> {note.scope === 'run' ? 'Promote' : 'To project'}
            </Button>
          )}
          <Button size="sm" variant="ghost" className="ml-auto text-t3 hover:text-rd" aria-label="Delete the note" disabled={busy} onClick={() => (mode === 'delete' ? onDelete() : setMode('delete'))}>
            <Trash2 className="size-3.5" /> {mode === 'delete' ? 'Really?' : ''}
          </Button>
        </div>
      )}
      {(mode === 'answer' || mode === 'dispute') && (
        <form
          className="animate-fade-up mt-2 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit(mode);
          }}
        >
          <Textarea aria-label={mode === 'answer' ? 'Your answer' : 'What is true instead'} rows={2} maxLength={600} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={mode === 'answer' ? 'Answer the question' : 'What is true instead, and how you know'} />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="primary" disabled={busy || !draft.trim()}>
              {mode === 'answer' ? 'Send the answer' : 'Add the disagreement'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode(undefined)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {mode === 'delete' && (
        <button className="mt-1.5 text-[11px] text-t3 hover:text-t1" onClick={() => setMode(undefined)}>
          Keep it
        </button>
      )}
    </article>
  );
}
