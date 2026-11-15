'use client';
/**
 * The waive page (docs/practices.md#waiving-from-a-flow): the practice a Check Practices step failed on, what failed in that
 * run, and a reason. Reads the practice (GET /api/practices/:id) and the run (GET /api/executions/:id) through the routes
 * that already exist; posts the waiver to POST /api/practices/:id/waivers, then offers the retry of the run. Nobody is
 * waived for: someone who may not approve the practice sees why and no button.
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/client/api';
import { PRACTICE_LIMITS, PRACTICE_STRENGTH_LABELS, type PracticeDetailResponse } from '@/lib/shared/practices';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { FieldLabel, Textarea } from '@/components/ui/inputs';

interface RunView {
  workflowId: string;
  workflowName?: string;
  status: string;
  runData: Record<string, Array<{ status: string; error?: { message: string; description?: string } }>>;
}

/** The lines the failed step wrote about this practice (its handle starts the line); none when it did not fail in this run. */
export function failuresFor(run: RunView | undefined, handle: string): string[] {
  const lines: string[] = [];
  for (const runs of Object.values(run?.runData ?? {})) {
    for (const r of runs) {
      if (r.status !== 'error' || !r.error?.message.startsWith('Required practices failed')) continue;
      lines.push(...(r.error.description ?? '').split('\n').filter(Boolean));
    }
  }
  const mine = lines.filter((l) => l.startsWith(`${handle}@`));
  return mine;
}

export const reasonProblem = (reason: string): string | undefined => {
  const n = reason.trim().length;
  if (n < PRACTICE_LIMITS.reasonMin) return `Say why, in at least ${PRACTICE_LIMITS.reasonMin} characters (${n} so far)`;
  if (n > PRACTICE_LIMITS.reason) return `At most ${PRACTICE_LIMITS.reason} characters (${n})`;
  return undefined;
};

type Phase = { state: 'loading' } | { state: 'missing'; message: string } | { state: 'ready'; detail: PracticeDetailResponse; run?: RunView };

export function WaiveForm({ practiceId, executionId }: { practiceId: string; executionId: string }) {
  const [phase, setPhase] = useState<Phase>({ state: 'loading' });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [waived, setWaived] = useState(false);
  const [retried, setRetried] = useState<string>();

  useEffect(() => {
    if (!practiceId || !executionId) {
      setPhase({ state: 'missing', message: 'This link is missing the practice or the run. Open it again from the failed step.' });
      return;
    }
    let live = true;
    Promise.all([
      api<PracticeDetailResponse>(`/api/practices/${encodeURIComponent(practiceId)}`),
      api<{ execution: RunView }>(`/api/executions/${encodeURIComponent(executionId)}`).then((r) => r.execution).catch(() => undefined),
    ])
      .then(([detail, run]) => live && setPhase({ state: 'ready', detail, run }))
      .catch((caught: Error) => live && setPhase({ state: 'missing', message: caught instanceof ApiError && caught.status === 404 ? 'That practice is not here, or you may not see it.' : caught.message }));
    return () => {
      live = false;
    };
  }, [practiceId, executionId]);

  const ready = phase.state === 'ready' ? phase : undefined;
  const practice = ready?.detail.practice;
  const approved = practice?.approved;
  const alreadyWaived = Boolean(ready?.detail.applications.some((a) => a.kind === 'waived' && a.executionId === executionId));
  const failures = useMemo(() => failuresFor(ready?.run, practice?.handle ?? ''), [ready, practice?.handle]);
  // The run did stop on practices, but not on this one: nothing to waive here.
  const didNotFail = Boolean(ready?.run) && failures.length === 0 && Object.values(ready?.run?.runData ?? {}).some((runs) => runs.some((r) => r.status === 'error' && r.error?.message.startsWith('Required practices failed')));
  const problem = reasonProblem(reason);

  const waive = async () => {
    if (!practice || !approved || problem) return;
    setBusy(true);
    setError(undefined);
    try {
      await api(`/api/practices/${encodeURIComponent(practice.id)}/waivers`, { method: 'POST', json: { executionId, version: approved.version, reason: reason.trim() } });
      setWaived(true);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { executionId: next } = await api<{ executionId: string }>(`/api/executions/${encodeURIComponent(executionId)}/retry`, { method: 'POST', json: { from: 'failed' } });
      setRetried(next);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runLink = (
    <Link href={`/runs/${encodeURIComponent(executionId)}`} className="text-ac underline underline-offset-2">
      Open the run
    </Link>
  );

  return (
    <>
      <PageHeader title="Waive a practice" />
      <PageBody width="narrow">
        {phase.state === 'loading' && <p className="text-[13px] text-t3">Loading…</p>}
        {phase.state === 'missing' && <Card><EmptyState title="Nothing to waive here" hint={phase.message} /></Card>}
        {practice && (
          <div className="flex flex-col gap-4">
            <Card className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[15px] font-semibold text-t1">{approved?.title ?? practice.handle}</h2>
                <Chip tone={practice.strength === 'required' ? 'danger' : 'muted'}>{PRACTICE_STRENGTH_LABELS[practice.strength]}</Chip>
                {approved && <Chip mono>{practice.handle}@{approved.version}</Chip>}
              </div>
              {approved?.summary && <p className="mt-2 text-[13px] text-t2">{approved.summary}</p>}
              <h3 className="mt-4 text-[12px] font-semibold uppercase tracking-wide text-t3">What failed in this run</h3>
              {failures.length ? (
                <ul className="mt-1 flex flex-col gap-1.5 text-[13px] text-t1">
                  {failures.map((line) => (
                    <li key={line} className="break-words rounded-[10px] border border-hair bg-wl px-3 py-2 font-mono text-[12px]">{line}</li>
                  ))}
                </ul>
              ) : didNotFail ? (
                <p className="mt-1 text-[13px] text-t3">This practice did not fail in this run, so there is nothing to waive.</p>
              ) : (
                <p className="mt-1 text-[13px] text-t3">The run does not say what failed. {runLink} to read it.</p>
              )}
              <p className="mt-3 text-[13px]">{runLink}</p>
            </Card>

            {!waived && !alreadyWaived && !practice.canApprove && (
              <Card className="p-4">
                <p className="text-[13px] text-t1">You can’t waive this practice.</p>
                <p className="mt-1 text-[13px] text-t2">
                  {practice.level === 'org' ? 'Only owners and admins can waive an organization practice.' : 'Only admins of the project can waive its practices.'} Ask one of them to open this link, or fix the change and run the flow again.
                </p>
              </Card>
            )}
            {!waived && !alreadyWaived && practice.canApprove && practice.strength !== 'required' && (
              <Card className="p-4">
                <p className="text-[13px] text-t2">This practice is recommended, so it only warned and did not stop the run. There is nothing to waive.</p>
              </Card>
            )}
            {!waived && !alreadyWaived && !didNotFail && practice.canApprove && practice.strength === 'required' && (
              <Card className="p-4">
                <FieldLabel>Why is it fine to go on?</FieldLabel>
                <Textarea className="mt-1 min-h-24" rows={4} value={reason} maxLength={PRACTICE_LIMITS.reason + 50} onChange={(e) => setReason(e.target.value)} placeholder="For example: the key file is a fixture for a test" aria-label="Reason" />
                <div className="mt-1 flex items-start justify-between gap-3 text-[12px]">
                  <span className={problem && reason ? 'text-danger' : 'text-t3'}>{reason ? (problem ?? 'Looks good') : `At least ${PRACTICE_LIMITS.reasonMin} characters`}</span>
                  <span className="shrink-0 text-t3">{reason.trim().length}/{PRACTICE_LIMITS.reason}</span>
                </div>
                <p className="mt-3 text-[12px] text-t3">The waiver is for this run only, and your name and reason are kept with the practice. A later run of the flow is checked again.</p>
                {error && <p className="mt-2 text-[13px] text-danger" role="alert">{error}</p>}
                <Button variant="primary" className="mt-3 max-md:w-full" disabled={busy || Boolean(problem)} onClick={waive}>
                  {busy ? 'Waiving…' : 'Waive for this run'}
                </Button>
              </Card>
            )}
            {(waived || alreadyWaived) && (
              <Card className="p-4">
                <p className="text-[13px] font-medium text-t1">{waived ? 'Waived for this run.' : 'This practice is already waived for this run.'}</p>
                <p className="mt-1 text-[13px] text-t2">Retry the run: the step finds the waiver and the flow goes on from there.</p>
                {error && <p className="mt-2 text-[13px] text-danger" role="alert">{error}</p>}
                {retried ? (
                  <p className="mt-3 text-[13px]">
                    Started again. <Link href={`/runs/${encodeURIComponent(retried)}`} className="text-ac underline underline-offset-2">Open the new run</Link>
                  </p>
                ) : (
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <Button variant="primary" className="max-md:w-full" disabled={busy} onClick={retry}>{busy ? 'Starting…' : 'Retry the run'}</Button>
                    <span className="text-[13px]">{runLink}</span>
                  </div>
                )}
              </Card>
            )}
          </div>
        )}
      </PageBody>
    </>
  );
}
