'use client';
/**
 * A practice's file in the Brain workbench, as a card (docs/practices.md#the-card): its title and handle, strength, level and
 * status, where it applies, the approved rules, its checks in words, its citations as excerpts, the latest applications and
 * the versions. A version waiting for the viewer shows a banner with Review; Edit makes a new draft; Retire is behind a
 * confirm. `PracticeCard` draws a loaded practice; `PracticeDoc` loads it and wires the dialogs.
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Pencil, ScrollText } from 'lucide-react';
import { toast } from 'sonner';
import { timeAgo } from '@/lib/client/format';
import { PRACTICE_LEVEL_LABELS, PRACTICE_STATUS_LABELS, PRACTICE_STRENGTH_LABELS, type PracticeApplication, type PracticeDetailResponse, type PracticeVersion, type PracticeView } from '@/lib/shared/practices';
import { Badge, Chip, type Tone } from '../../ui/badge';
import { Button } from '../../ui/button';
import { confirmAction } from '../../ui/confirm';
import { BrandGlyph } from '../../ui/icon';
import { Doc } from '../../run-trace/rich-text';
import { projectLabel, useProjects } from '../../projects/use-projects';
import { Section } from './parts';
import { getPractice, retirePractice } from './practices-api';
import { actorWords, checkSentence, SOURCE_WORDS, VERSION_STATE_LABELS } from './practices-logic';
import { PracticeForm } from './practice-form';
import { CitationCard, PracticeReview } from './practice-review';

export const STRENGTH_TONE: Record<PracticeView['strength'], Tone> = { required: 'accent', recommended: 'neutral' };
export const STATUS_TONE: Record<PracticeView['status'], Tone> = { draft: 'warning', approved: 'success', retired: 'muted' };
const VERSION_TONE: Record<string, Tone> = { approved: 'success', replaced: 'muted', pending: 'warning', rejected: 'danger' };

const KIND_WORDS: Record<PracticeApplication['kind'], string> = {
  delivered: 'Given to an agent',
  cited: 'Cited in an answer',
  'check-pass': 'Check passed',
  'check-fail': 'Check failed',
  waived: 'Waived',
};

/** Text with `code` in backticks drawn as code. */
function Words({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) =>
        i % 2 ? (
          <code key={i} className="break-all rounded bg-acdim px-1 font-mono text-[0.92em]">
            {part}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function Applications({ items }: { items: PracticeApplication[] }) {
  if (!items.length) return <p className="text-[12.5px] text-t3">Nothing has used it yet.</p>;
  return (
    <ul className="divide-y divide-hair rounded-xl border border-hair">
      {items.map((a) => (
        <li key={a.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-[12.5px]">
          <span className="font-medium text-t1">{KIND_WORDS[a.kind]}</span>
          <span className="text-t3">
            version {a.version} · {timeAgo(a.at)}
            {a.agentId ? ` · agent ${a.agentId}` : a.userId ? ' · a person' : ''}
            {a.repo ? ` · ${a.repo}` : ''}
          </span>
          {a.reason && <span className="basis-full text-t2">{a.reason}</span>}
          {a.executionId && (
            <Link href={`/executions/${encodeURIComponent(a.executionId)}`} className="ml-auto text-ac hover:underline">
              Run Trace
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

function VersionRow({ v }: { v: PracticeVersion & { state: string } }) {
  return (
    <li className="space-y-0.5 px-3 py-2 text-[12.5px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-t1">Version {v.version}</span>
        <Badge tone={VERSION_TONE[v.state] ?? 'muted'}>{VERSION_STATE_LABELS[v.state as keyof typeof VERSION_STATE_LABELS] ?? v.state}</Badge>
        {v.tainted && (
          <Badge tone="warning" title="Read from outside: an approver reads it against its sources">
            Read from outside
          </Badge>
        )}
        <span className="ml-auto text-t3">{timeAgo(v.createdAt)}</span>
      </div>
      <p className="text-t2">
        {SOURCE_WORDS[v.source][0].toUpperCase()}
        {SOURCE_WORDS[v.source].slice(1)}, drafted by {actorWords(v.draftedBy)}
        {v.approvedAt && `, approved ${timeAgo(v.approvedAt)} by ${actorWords(v.approvedBy)}`}
        {v.rejectedAt && `, rejected ${timeAgo(v.rejectedAt)}`}
      </p>
      {v.rejectReason && <p className="text-t3">“{v.rejectReason}”</p>}
    </li>
  );
}

export interface PracticeCardProps {
  detail: PracticeDetailResponse;
  projectName?: string;
  onReview?: (version: PracticeVersion) => void;
  onEdit?: () => void;
  onRetire?: () => void;
}

export function PracticeCard({ detail, projectName, onReview, onEdit, onRetire }: PracticeCardProps) {
  const { practice, versions, applications } = detail;
  const approved = practice.approved;
  const waiting = practice.canApprove ? practice.drafts[0] : undefined;
  const mine = !practice.canApprove ? practice.drafts[0] : undefined;
  const retired = practice.status === 'retired';

  return (
    <article className="space-y-6">
      <header className="space-y-2.5">
        <div className="flex items-start gap-2.5">
          <ScrollText className="mt-1.5 size-5 shrink-0 text-viz-4" aria-hidden />
          <div className="min-w-0 flex-1">
            <h1 className="break-words text-[24px] font-semibold leading-tight text-t1">{practice.title}</h1>
            <p className="font-mono text-[12.5px] text-t3">{practice.handle}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STRENGTH_TONE[practice.strength]}>{PRACTICE_STRENGTH_LABELS[practice.strength]}</Badge>
          <Badge tone="muted">{practice.level === 'project' && projectName ? `${PRACTICE_LEVEL_LABELS.project}: ${projectName}` : PRACTICE_LEVEL_LABELS[practice.level]}</Badge>
          <Badge tone={STATUS_TONE[practice.status]}>{PRACTICE_STATUS_LABELS[practice.status]}</Badge>
          {practice.ownerName && <span className="text-[12px] text-t3">Owner: {practice.ownerName}</span>}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {practice.canDraft && !retired && onEdit && (
              <Button size="sm" onClick={onEdit} className="max-md:h-10">
                <Pencil className="size-3.5" aria-hidden />
                Edit
              </Button>
            )}
            {practice.canApprove && !retired && onRetire && (
              <Button size="sm" variant="danger" onClick={onRetire} className="max-md:h-10">
                Retire
              </Button>
            )}
          </div>
        </div>
      </header>

      {waiting && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-warnbd bg-warndim/60 px-3.5 py-2.5">
          <p className="min-w-0 flex-1 text-[13px] font-medium text-t1">
            Version {waiting.version} waits for you
            <span className="font-normal text-t2"> · drafted by {actorWords(waiting.draftedBy)}{waiting.tainted ? ', read from outside' : ''}</span>
          </p>
          {onReview && (
            <Button size="sm" variant="primary" className="max-md:h-10" onClick={() => onReview(waiting)}>
              Review
            </Button>
          )}
        </div>
      )}
      {mine && (
        <p role="status" className="rounded-xl border border-hair bg-sf2 px-3.5 py-2.5 text-[13px] text-t2">
          Version {mine.version} waits for {practice.level === 'org' ? 'an admin of this instance' : 'an admin of the project'} to approve it.
        </p>
      )}

      <Section title="Where it applies">
        <div className="flex flex-wrap gap-2">
          {practice.level === 'project' && projectName && <Chip>{projectName}</Chip>}
          {practice.repos.map((r) => (
            <Chip key={r} mono>
              <BrandGlyph brand="github" size={12} className="text-t2" />
              {r}
            </Chip>
          ))}
          {practice.paths.map((p) => (
            <Chip key={p} mono>
              {p}
            </Chip>
          ))}
          {practice.topics.map((t) => (
            <Chip key={t} tone="accent">
              {t}
            </Chip>
          ))}
          {!practice.repos.length && !practice.paths.length && <span className="text-[12.5px] text-t3">Any repository, anywhere in it.</span>}
        </div>
      </Section>

      {approved ? (
        <>
          <Section title="Rules" action={<span className="text-[12px] text-t3">Version {approved.version}</span>}>
            <p className="text-[14px] font-medium text-t1">{approved.summary}</p>
            {approved.body && (
              <div className="rounded-xl border border-hair bg-sf px-4 py-3 text-[13.5px]">
                <Doc text={approved.body} />
              </div>
            )}
          </Section>
          {approved.checks.length > 0 && (
            <Section title="Checks" count={approved.checks.length}>
              <ul className="divide-y divide-hair rounded-xl border border-hair">
                {approved.checks.map((c, i) => (
                  <li key={i} className="px-3 py-2 text-[13px] text-t1">
                    <Words text={checkSentence(c)} />
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {approved.citations.length > 0 && (
            <Section title="Sources" count={approved.citations.length}>
              <div className="space-y-2">
                {approved.citations.map((c, i) => (
                  <CitationCard key={`${c.repo}:${c.sha}:${c.path}:${i}`} citation={c} />
                ))}
              </div>
            </Section>
          )}
        </>
      ) : (
        <Section title="Rules">
          <p className="rounded-xl border border-hair bg-sf2 px-3.5 py-2.5 text-[13px] text-t2">No version is approved yet, so no agent gets this practice.{waiting ? ' Review the draft to approve it.' : ''}</p>
        </Section>
      )}

      <Section title="Applications" count={applications.length}>
        <Applications items={applications} />
      </Section>

      <Section title="Versions" count={versions.length}>
        <ol className="divide-y divide-hair rounded-xl border border-hair">
          {versions.map((v) => (
            <VersionRow key={v.version} v={v} />
          ))}
        </ol>
      </Section>
    </article>
  );
}

/** `onChanged` reloads the list (an approval, a rejection, a new draft, a retirement). */
export function PracticeDoc({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [detail, setDetail] = useState<PracticeDetailResponse>();
  const [error, setError] = useState<string>();
  const [dialog, setDialog] = useState<{ kind: 'review'; version: PracticeVersion } | { kind: 'edit' }>();
  const { projects } = useProjects();
  const load = useCallback(() => {
    getPractice(id)
      .then((d) => (setDetail(d), setError(undefined)))
      .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  const after = () => {
    setDialog(undefined);
    load();
    onChanged();
  };

  if (error && !detail)
    return (
      <div className="space-y-1 py-10 text-center">
        <p className="text-[15px] font-semibold text-t1">This practice can’t be opened</p>
        <p className="text-[13px] text-t2">{error}. It may have been removed, or it is in a project you can’t open.</p>
      </div>
    );
  if (!detail)
    return (
      <div className="space-y-3">
        <div className="h-8 w-1/2 rounded-lg bg-acdim animate-pulse-soft" />
        <div className="h-40 rounded-2xl bg-acdim animate-pulse-soft" />
      </div>
    );
  const project = detail.practice.projectId ? projects?.find((p) => p.id === detail.practice.projectId) : undefined;
  return (
    <>
      <PracticeCard
        detail={detail}
        projectName={project ? projectLabel(project) : undefined}
        onReview={(version) => setDialog({ kind: 'review', version })}
        onEdit={() => setDialog({ kind: 'edit' })}
        onRetire={async () => {
          if (!(await confirmAction(`Retire ${detail.practice.handle}? Agents stop getting it. Its history stays.`, { action: 'Retire', danger: true }))) return;
          try {
            await retirePractice(detail.practice.id);
            toast.success('Retired');
            after();
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
      />
      {dialog?.kind === 'review' && (
        <PracticeReview
          detail={detail}
          version={dialog.version}
          onClose={() => setDialog(undefined)}
          onDone={(_, what) => {
            toast.success(what === 'approved' ? 'Approved' : 'Rejected');
            after();
          }}
        />
      )}
      {dialog?.kind === 'edit' && (
        <PracticeForm
          editing={detail}
          onClose={() => setDialog(undefined)}
          onSaved={() => {
            toast.success('Saved as a new draft');
            after();
          }}
        />
      )}
    </>
  );
}
