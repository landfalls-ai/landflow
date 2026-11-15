'use client';
/**
 * The review dialog (docs/practices.md#review): a waiting version read against what it replaces, its sources and the
 * practices it overlaps. Side by side on a desktop, stacked on a phone (the dialog is a sheet there). Approve needs an answer
 * to every overlap and, for a version read from outside, the tick that its rules were read against their sources. Reject
 * needs a reason. Everything that goes wrong shows in the dialog in words.
 */
import { useMemo, useState } from 'react';
import { Check, CircleAlert, ExternalLink } from 'lucide-react';
import { ApiError } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import { PRACTICE_LEVEL_LABELS, PRACTICE_LIMITS, PRACTICE_STRENGTH_LABELS, type PracticeCitation, type PracticeConflict, type PracticeDetailResponse, type PracticeVersion, type PracticeView } from '@/lib/shared/practices';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { Checkbox, Textarea } from '../../ui/inputs';
import { BrandGlyph } from '../../ui/icon';
import { DiffView } from '../../run-trace/diff-view';
import { Doc } from '../../run-trace/rich-text';
import { approvePractice, rejectVersion } from './practices-api';
import { actorWords, approveBlockers, approveBody, citationNote, citationPlace, mergeConflicts, REJECT_REASON_HINT, reasonValid, reviewError, SOURCE_WORDS, versionDiff, type ConflictAnswers } from './practices-logic';

/** A citation as a file excerpt: where it was read, the lines, and whether the server found them there. */
export function CitationCard({ citation }: { citation: PracticeCitation }) {
  const note = citationNote(citation);
  const href = `https://github.com/${citation.repo}/blob/${citation.sha}/${citation.path.split('/').map(encodeURIComponent).join('/')}${citation.lines ? `#L${citation.lines[0]}-L${citation.lines[1]}` : ''}`;
  return (
    <figure className="min-w-0 rounded-xl border border-hair bg-sf">
      <figcaption className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-hair px-3 py-1.5 text-[12px]">
        <BrandGlyph brand="github" size={13} className="text-t2" />
        <span className="font-medium text-t1">{citation.repo}</span>
        <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-w-0 items-center gap-1 break-all font-mono text-[11.5px] text-ac hover:underline">
          {citationPlace(citation)}
          <ExternalLink className="size-3 shrink-0" aria-hidden />
        </a>
      </figcaption>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[12px] leading-[1.55] text-t1">{citation.excerpt}</pre>
      <p className={cn('flex items-start gap-1.5 border-t border-hair px-3 py-1.5 text-[12px]', note.ok ? 'text-gn' : 'text-t3')}>
        {note.ok ? <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
        <span>{note.text}</span>
      </p>
    </figure>
  );
}

function ConflictRow({ conflict, answer, onAnswer }: { conflict: PracticeConflict; answer?: 'supersede' | 'keep'; onAnswer: (a: 'supersede' | 'keep') => void }) {
  return (
    <li className="space-y-2 rounded-xl border border-warnbd bg-warndim/50 p-3">
      <div>
        <p className="text-[13px] font-semibold text-t1">
          {conflict.title} <span className="font-mono text-[11.5px] font-normal text-t2">{conflict.handle}@{conflict.version}</span>
        </p>
        <p className="text-[12px] text-t2">
          {PRACTICE_LEVEL_LABELS[conflict.level]} · overlaps on {conflict.overlap}
        </p>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label={`Answer for ${conflict.handle}`}>
        <Button size="sm" variant={answer === 'supersede' ? 'primary' : 'outline'} aria-pressed={answer === 'supersede'} className="max-md:h-10" onClick={() => onAnswer('supersede')}>
          Supersede
        </Button>
        <Button size="sm" variant={answer === 'keep' ? 'primary' : 'outline'} aria-pressed={answer === 'keep'} className="max-md:h-10" onClick={() => onAnswer('keep')}>
          Keep both
        </Button>
      </div>
      <p className="text-[11.5px] text-t3">Supersede retires {conflict.handle} in favour of this one. Keep both leaves both.</p>
    </li>
  );
}

export function PracticeReview({ detail, version, onClose, onDone }: { detail: PracticeDetailResponse; version: PracticeVersion; onClose: () => void; onDone: (practice: PracticeView, what: 'approved' | 'rejected') => void }) {
  const { practice } = detail;
  const [conflicts, setConflicts] = useState<PracticeConflict[]>(detail.conflicts);
  const [answers, setAnswers] = useState<ConflictAnswers>({});
  const [reviewed, setReviewed] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const hunks = useMemo(() => versionDiff(practice.approved, version), [practice.approved, version]);
  const blockers = approveBlockers({ tainted: version.tainted, reviewed, conflicts, answers });

  const run = async (what: 'approved' | 'rejected') => {
    setBusy(true);
    setProblem(undefined);
    try {
      const { practice: next } = what === 'approved' ? await approvePractice(practice.id, approveBody(version, { reviewed, conflicts, answers })) : await rejectVersion(practice.id, version.version, reason.trim());
      onDone(next, what);
    } catch (e) {
      const err = e as ApiError;
      const said = reviewError({ status: err.status, message: err.message, body: err.body });
      if (said.conflicts) setConflicts((known) => mergeConflicts(known, said.conflicts));
      setProblem(said.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Review version ${version.version} of ${practice.handle}`}
      subtitle={`${SOURCE_WORDS[version.source][0].toUpperCase()}${SOURCE_WORDS[version.source].slice(1)}, drafted by ${actorWords(version.draftedBy)}${practice.approved ? `. Compared with version ${practice.approved.version}, the one agents get` : '. A new practice: nothing is approved yet'}.`}
      onClose={onClose}
      width={1080}
      footer={
        rejecting ? (
          <>
            <Button variant="ghost" onClick={() => setRejecting(false)} disabled={busy}>
              Back
            </Button>
            <Button variant="danger" loading={busy} disabled={!reasonValid(reason)} onClick={() => void run('rejected')}>
              Reject version {version.version}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setRejecting(true)} disabled={busy} className="mr-auto">
              Reject
            </Button>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={blockers.length > 0} onClick={() => void run('approved')} title={blockers.join(' ')}>
              Approve
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {problem && (
          <p role="alert" className="rounded-lg border border-rdbd bg-rddim px-3 py-2 text-[12.5px] text-rd">
            {problem}
          </p>
        )}
        <div className="grid gap-5 md:grid-cols-2">
          <section className="min-w-0 space-y-2" aria-label="What changes">
            <h3 className="text-[13px] font-semibold text-t1">What changes</h3>
            <DiffView hunks={hunks} label={`Changes in version ${version.version} of ${practice.handle}`} />
          </section>
          <section className="min-w-0 space-y-3" aria-label="Its sources">
            <h3 className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-t1">
              The rules and their sources
              <Badge tone={version.strength === 'required' ? 'accent' : 'neutral'}>{PRACTICE_STRENGTH_LABELS[version.strength]}</Badge>
            </h3>
            <p className="text-[13px] font-medium text-t1">{version.summary}</p>
            {version.body && (
              <div className="max-h-64 overflow-y-auto rounded-xl border border-hair bg-sf2 px-3 py-2 text-[13px]">
                <Doc text={version.body} />
              </div>
            )}
            {version.citations.length ? (
              <div className="space-y-2">
                {version.citations.map((c, i) => (
                  <CitationCard key={`${c.repo}:${c.sha}:${c.path}:${i}`} citation={c} />
                ))}
              </div>
            ) : (
              <p className="rounded-xl border border-hair bg-sf2 px-3 py-2 text-[12.5px] text-t3">This version cites no source.</p>
            )}
            {version.tainted && (
              <div className="space-y-2 rounded-xl border border-warnbd bg-warndim/50 p-3">
                <p className="flex items-start gap-1.5 text-[12.5px] text-t1">
                  <CircleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
                  Read from outside (a repository, an agent’s run): read each rule against its source before approving.
                </p>
                <Checkbox checked={reviewed} onChange={setReviewed} label="I read it against its sources" />
              </div>
            )}
          </section>
        </div>
        {conflicts.length > 0 && (
          <section className="space-y-2" aria-label="Overlaps">
            <h3 className="text-[13px] font-semibold text-t1">It overlaps {conflicts.length === 1 ? 'a practice' : `${conflicts.length} practices`} already approved</h3>
            <ul className="grid gap-2 md:grid-cols-2">
              {conflicts.map((c) => (
                <ConflictRow key={c.id} conflict={c} answer={answers[c.id]} onAnswer={(a) => setAnswers((all) => ({ ...all, [c.id]: a }))} />
              ))}
            </ul>
          </section>
        )}
        {rejecting && (
          <section className="space-y-1.5" aria-label="Reject">
            <label htmlFor="practice-reject-reason" className="text-[12px] font-semibold text-t2">
              Why are you rejecting it? <span className="font-normal text-t3">({REJECT_REASON_HINT})</span>
            </label>
            <Textarea id="practice-reject-reason" autoFocus rows={3} value={reason} maxLength={PRACTICE_LIMITS.reason} onChange={(e) => setReason(e.target.value)} />
            <p className="text-[11.5px] tabular-nums text-t3">
              {reason.trim().length}/{PRACTICE_LIMITS.reason}
            </p>
          </section>
        )}
        {!rejecting && blockers.length > 0 && <p className="text-[12px] text-t3">{blockers.join(' ')}</p>}
      </div>
    </Dialog>
  );
}
