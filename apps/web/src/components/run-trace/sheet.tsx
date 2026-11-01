'use client';
/** The detail of a tapped row: a bottom sheet under 768 px, a side panel above. */
import { useEffect, useRef, type ReactNode } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { artifactShape, safeUrl } from '@/lib/shared/artifact-kinds';
import type { FileChange, RunChanges } from '@/lib/shared/run-changes';
import type { RunGitHub } from '@/lib/shared/run-repo';
import { fmtMs, spendLine, type RunArtifactItem, type RunCheckItem, type RunModel, type RunSpan } from '@/lib/shared/run-trace-model';
import { Badge, type Tone } from '../ui/badge';
import { Button } from '../ui/button';
import { ArtifactPreview, PREVIEWED } from './artifact-preview';
import { ChangeDiff } from './diff-view';
import { ConnectionList } from './connections';
import { Avatar, ResultChip, SectionTitle, Tap, ValueBlock, clock, who } from './parts';
import { Doc, TextBlock } from './rich-text';

export type Open = {
  kind: 'span' | 'artifact' | 'check' | 'actor';
  id: string;
};

const STATUS_TONE: Record<string, Tone> = {
  success: 'success',
  error: 'danger',
  running: 'warning',
  waiting: 'warning',
  canceled: 'muted',
};

function Frame({ title, kicker, onClose, children }: { title: string; kicker?: ReactNode; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef<Element | null>(null);
  useEffect(() => {
    last.current = document.activeElement;
    ref.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      if (last.current instanceof HTMLElement && last.current.isConnected) last.current.focus({ preventScroll: true });
    };
  }, [onClose]);
  return (
    <>
      <div className="fixed inset-0 z-40 bg-overlay animate-in" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 flex max-h-[86dvh] flex-col rounded-t-3xl border border-hair bg-sf shadow-pop outline-none animate-fade-up',
          'md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[440px] md:rounded-none md:border-y-0 md:border-r-0',
        )}
      >
        <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-bd md:hidden" aria-hidden />
        <header className="flex shrink-0 items-start gap-2 px-4 pb-2 pt-3">
          <div className="min-w-0 flex-1">
            {kicker && <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{kicker}</div>}
            <h2 className="break-words text-[16px] font-semibold leading-tight text-t1">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-9 shrink-0 place-items-center rounded-full text-t2 hover:bg-acdim hover:text-t1"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(20px,env(safe-area-inset-bottom))]">{children}</div>
      </div>
    </>
  );
}

function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
      {rows
        .filter(([, v]) => v !== undefined && v !== null && v !== false && v !== '')
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-t3">{k}</dt>
            <dd className="min-w-0 break-words text-t1">{v}</dd>
          </div>
        ))}
    </dl>
  );
}

function TimeButton({ iso, onJump }: { iso?: string; onJump: (ms: number) => void }) {
  if (!iso) return null;
  return (
    <button
      type="button"
      onClick={() => onJump(Date.parse(iso))}
      className="rounded-md px-1 font-mono text-[12px] text-ac underline decoration-dotted underline-offset-2 hover:bg-acdim"
      aria-label={`Move the run to ${clock(iso)}`}
    >
      {clock(iso)}
    </button>
  );
}

function ArtifactRow({ item, open }: { item: RunArtifactItem; open: (o: Open) => void }) {
  return (
    <Tap onClick={() => open({ kind: 'artifact', id: item.id })} className="rounded-xl border border-hair px-3 py-2 text-[13px] hover:bg-acdim/60">
      <b className="font-semibold">{item.artifact.name}</b>
      <span className="block text-[12px] text-t3">{item.artifact.kind ?? 'artifact'}</span>
    </Tap>
  );
}

function CheckRow({ item, open }: { item: RunCheckItem; open: (o: Open) => void }) {
  const c = item.check;
  return (
    <Tap
      onClick={() => open({ kind: 'check', id: item.id })}
      className="flex items-center gap-2 rounded-xl border border-hair px-3 py-2 text-[13px] hover:bg-acdim/60"
    >
      <Badge tone={c.status === 'pass' ? 'success' : c.status === 'fail' ? 'danger' : c.status === 'warn' ? 'warning' : 'muted'}>{c.status}</Badge>
      <span className="min-w-0 flex-1 truncate">{c.name}</span>
    </Tap>
  );
}

/** A value of a step: text with its commits, branch and pull request linked; anything else as the journal kept it. */
function Value({ label, value, tone, repo }: { label: string; value: unknown; tone?: 'error'; repo?: RunGitHub }) {
  return typeof value === 'string' && value && !tone ? <TextBlock label={label} text={value} repo={repo} /> : <ValueBlock label={label} value={value} tone={tone} />;
}

/** The file change a Write, Edit or MultiEdit step made, as a line diff instead of the tool's JSON. */
function ChangeSheet({ changes, file, git }: { changes: FileChange[]; file: string; git: boolean }) {
  return (
    <div className="flex flex-col gap-2.5">
      {changes.map((change, i) => (
        <section key={i} className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[12px]">
            <b className="break-all font-mono text-[12px] font-medium text-t1">{file}</b>
            <span className="font-mono">
              <span className="text-gn">+{change.additions}</span> <span className="text-rd">−{change.deletions}</span>
            </span>
            {git && <Badge tone={change.pushed ? 'success' : 'warning'}>{change.pushed ? `pushed${change.commit ? ` in ${change.commit}` : ''}` : 'never pushed'}</Badge>}
          </div>
          <ChangeDiff change={change} path={file} />
        </section>
      ))}
    </div>
  );
}

function SpanSheet({
  span,
  model,
  open,
  onJump,
  changes,
  repo,
}: {
  span: RunSpan;
  model: RunModel;
  open: (o: Open) => void;
  onJump: (ms: number) => void;
  changes?: RunChanges;
  repo?: RunGitHub;
}) {
  const edits = span.kind === 'tool' ? changes?.files.flatMap((f) => f.changes.filter((c) => c.spanId === span.id).map((c) => ({ file: f.path, c }))) : undefined;
  const kids = span.children.map((id) => model.spans[id]).filter((s) => s && !s.hidden);
  const attrs = Object.entries(span.attrs).filter(([k]) => k !== 'hidden');
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5 pb-3">
        <Badge tone={STATUS_TONE[span.status] ?? 'neutral'}>{span.status}</Badge>
        {span.state && <Badge tone="muted">{span.state}</Badge>}
        {(span.kind === 'delegate' || span.kind === 'handoff') && <ResultChip span={span} />}
        <Badge tone="muted">{span.kind}</Badge>
      </div>
      <Facts
        rows={[
          [
            'Who',
            <span key="w" className="flex items-center gap-2">
              <Avatar actor={span.actor} size={22} />
              {who(span.actor)}
              {span.actor.role && <span className="text-t3"> · {span.actor.role}</span>}
            </span>,
          ],
          ['Asked by', span.caller ? who(span.caller) : undefined],
          ['Started', <TimeButton key="s" iso={span.startedAt} onJump={onJump} />],
          ['Ended', span.endedAt ? <TimeButton key="e" iso={span.endedAt} onJump={onJump} /> : span.status === 'running' ? 'still going' : undefined],
          ['Took', fmtMs(span.ms)],
          ['Tokens', span.usage ? `${span.usage.inputTokens.toLocaleString()} in · ${span.usage.outputTokens.toLocaleString()} out` : undefined],
          ['Now', span.note],
        ]}
      />
      <div className="mt-3 flex flex-col gap-2.5">
        {edits?.length ? (
          <ChangeSheet changes={edits.map((e) => e.c)} file={edits[0].file} git={Boolean(changes?.git)} />
        ) : (
          <Value label="Asked" value={span.input} repo={repo} />
        )}
        <Value label="Came back" value={span.output} repo={repo} />
        <Value label="Error" value={span.error} tone="error" repo={repo} />
      </div>
      {span.checks.length > 0 && (
        <>
          <SectionTitle>Checks</SectionTitle>
          <div className="flex flex-col gap-1.5">
            {span.checks.map((c) => (
              <CheckRow key={c.id} item={c} open={open} />
            ))}
          </div>
        </>
      )}
      {span.delivered.length > 0 && (
        <>
          <SectionTitle>Made here</SectionTitle>
          <div className="flex flex-col gap-1.5">
            {span.delivered.map((a) => (
              <ArtifactRow key={a.id} item={a} open={open} />
            ))}
          </div>
        </>
      )}
      {kids.length > 0 && (
        <>
          <SectionTitle>Inside · {kids.length}</SectionTitle>
          <ul className="divide-y divide-hair rounded-xl border border-hair">
            {kids.map((k) => (
              <li key={k.id}>
                <Tap onClick={() => open({ kind: 'span', id: k.id })} className="flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-acdim/60">
                  <span className={cn('size-1.5 shrink-0 rounded-full', k.status === 'error' ? 'bg-rd' : k.status === 'success' ? 'bg-gn' : 'bg-warn')} />
                  <span className="min-w-0 flex-1 truncate">{k.name}</span>
                  <span className="font-mono text-[11px] text-t3">{fmtMs(k.ms)}</span>
                </Tap>
              </li>
            ))}
          </ul>
        </>
      )}
      {attrs.length > 0 && (
        <div className="mt-3">
          <ValueBlock label="Details" value={Object.fromEntries(attrs)} />
        </div>
      )}
    </>
  );
}

function ArtifactSheet({ item, repo }: { item: RunArtifactItem; repo?: RunGitHub }) {
  const a = item.artifact;
  const shape = artifactShape(a);
  const document = shape === 'markdown';
  const link = safeUrl(a.url);
  return (
    <>
      <Facts
        rows={[
          ['Kind', a.kind],
          ['Made by', item.actor ? who(item.actor) : undefined],
          ['At', clock(item.at)],
          ['Type', a.mimeType],
          [
            'Link',
            link ? (
              <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 break-all text-ac underline underline-offset-2">
                {link} <ExternalLink className="size-3 shrink-0" />
              </a>
            ) : a.url?.startsWith('data:') ? (
              'inline data'
            ) : (
              a.url
            ),
          ],
        ]}
      />
      <div className="mt-3 flex flex-col gap-2.5">
        {document ? (
          <div className="min-w-0 rounded-xl border border-hair bg-sf px-3 py-2.5">
            <Doc text={a.text!} />
          </div>
        ) : PREVIEWED.includes(shape) ? (
          <ArtifactPreview shape={shape} name={a.name} url={safeUrl(a.url, shape)} text={a.text} />
        ) : (
          <Value label="Content" value={a.text} repo={repo} />
        )}
        <ValueBlock label="Data" value={a.data} />
      </div>
    </>
  );
}

function CheckSheet({
  item,
  onResolve,
  busy,
}: {
  item: RunCheckItem;
  onResolve?: (item: RunCheckItem, decision: 'accepted' | 'sent_back') => void;
  busy?: boolean;
}) {
  const c = item.check;
  const open = c.status === 'fail' && !c.resolution;
  return (
    <>
      <div className="flex flex-wrap gap-1.5 pb-3">
        <Badge tone={c.status === 'pass' ? 'success' : c.status === 'fail' ? 'danger' : c.status === 'warn' ? 'warning' : 'muted'}>{c.status}</Badge>
        {c.source && <Badge tone="muted">{c.source === 'node' ? 'reported by a node' : c.source === 'person' ? 'a person' : 'built in'}</Badge>}
        {c.resolution && <Badge tone="neutral">{c.resolution.decision === 'accepted' ? 'accepted as is' : 'sent back'}</Badge>}
      </div>
      <Facts
        rows={[
          ['In', item.actor ? who(item.actor) : undefined],
          ['About', c.subject],
          ['At', clock(item.at)],
          ['Said', c.message],
          ['Settled by', c.resolution?.by],
          ['Note', c.resolution?.note],
        ]}
      />
      <div className="mt-3">
        <ValueBlock label="Evidence" value={c.evidence} />
      </div>
      {open && onResolve && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" loading={busy} onClick={() => onResolve(item, 'accepted')}>
            Accept as is
          </Button>
          <Button variant="primary" loading={busy} onClick={() => onResolve(item, 'sent_back')}>
            Send back for a fix
          </Button>
        </div>
      )}
    </>
  );
}

function ActorSheet({ id, model, open }: { id: string; model: RunModel; open: (o: Open) => void }) {
  const s = model.actors.find((a) => a.actor.id === id);
  if (!s) return <p className="text-[13px] text-t3">Not involved yet.</p>;
  const spans = model.order.filter((x) => x.actor.id === id && !x.hidden && x.id !== 'run' && x.kind !== 'model');
  return (
    <>
      <Facts
        rows={[
          ['Is', s.actor.role ?? s.actor.type],
          ['Worked', s.workMs ? fmtMs(s.workMs) : undefined],
          ['Asked', s.asked ? `${s.asked} time${s.asked > 1 ? 's' : ''}` : undefined],
          ['Asked others', s.calls ? `${s.calls} time${s.calls > 1 ? 's' : ''}` : undefined],
          ['Model', spendLine(s)],
          ['Tools', s.toolCalls ? `${s.toolCalls} calls` : undefined],
          ['Messages', s.messages ? `${s.messages} sent` : undefined],
        ]}
      />
      {s.actor.connections?.length ? (
        <>
          <SectionTitle>Works with · {s.actor.connections.length}</SectionTitle>
          <ConnectionList connections={s.actor.connections} />
        </>
      ) : null}
      {spans.length > 0 && (
        <>
          <SectionTitle>What it did · {spans.length}</SectionTitle>
          <ul className="divide-y divide-hair rounded-xl border border-hair">
            {spans.slice(0, 40).map((k) => (
              <li key={k.id}>
                <Tap onClick={() => open({ kind: 'span', id: k.id })} className="flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-acdim/60">
                  <span className={cn('size-1.5 shrink-0 rounded-full', k.status === 'error' ? 'bg-rd' : k.status === 'success' ? 'bg-gn' : 'bg-warn')} />
                  <span className="min-w-0 flex-1 truncate">{k.name}</span>
                  <span className="font-mono text-[11px] text-t3">{fmtMs(k.ms)}</span>
                </Tap>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

export function DetailSheet({
  target,
  model,
  onClose,
  open,
  onJump,
  onResolve,
  busy,
  changes,
  repo,
}: {
  target: Open;
  model: RunModel;
  onClose: () => void;
  open: (o: Open) => void;
  onJump: (ms: number) => void;
  onResolve?: (item: RunCheckItem, decision: 'accepted' | 'sent_back') => void;
  busy?: boolean;
  /** The run's file changes (lib/shared/run-changes.ts): a Write or Edit step opens as a diff. */
  changes?: RunChanges;
  /** The repository the run names: commits, branches and pull request numbers in replies become links. */
  repo?: RunGitHub;
}) {
  if (target.kind === 'span') {
    const span = model.spans[target.id];
    if (!span) return null;
    return (
      <Frame title={span.name} kicker={span.kind === 'delegate' ? 'Request' : span.kind} onClose={onClose}>
        <SpanSheet span={span} model={model} open={open} onJump={onJump} changes={changes} repo={repo} />
      </Frame>
    );
  }
  if (target.kind === 'artifact') {
    const item = model.artifacts.find((a) => a.id === target.id);
    if (!item) return null;
    return (
      <Frame title={item.artifact.name} kicker="Artifact" onClose={onClose}>
        <ArtifactSheet item={item} repo={repo} />
      </Frame>
    );
  }
  if (target.kind === 'check') {
    const item = model.checks.find((c) => c.id === target.id);
    if (!item) return null;
    return (
      <Frame title={item.check.name} kicker="Check" onClose={onClose}>
        <CheckSheet item={item} onResolve={onResolve} busy={busy} />
      </Frame>
    );
  }
  const actor = model.actors.find((a) => a.actor.id === target.id);
  return (
    <Frame title={actor?.actor.name ?? 'Actor'} kicker={actor ? actor.actor.type : 'Actor'} onClose={onClose}>
      <ActorSheet id={target.id} model={model} open={open} />
    </Frame>
  );
}
