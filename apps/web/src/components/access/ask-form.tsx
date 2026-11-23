'use client';
/**
 * Ask (docs/access-requests.md#the-access-page): pick a thing from the catalog, a duration the entry allows, say why, and for GitHub give
 * the username (kept for next time). The request is made as the signed-in person; Ask is ready only when all of that is there.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { KeyRound } from 'lucide-react';
import { canAsk, requestProblem, SYSTEM_FORM, useAccessClient, type AskEntry } from '@/lib/client/access';
import { durationText, ACCESS_LIMITS } from '@/lib/shared/access';
import { cn } from '@/lib/utils';
import { Card } from '../shell/page-header';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { FieldLabel, Input, Select, Textarea } from '../ui/inputs';

/** A refused request in a sentence; a 409 links the request that is already open. */
export function AskProblem({ problem }: { problem: { message: string; existingId?: string } }) {
  const client = useAccessClient();
  return (
    <p role="alert" className="rounded-xl border border-rdbd bg-rddim px-3 py-2 text-[13px] text-rd">
      {problem.message}
      {problem.existingId && (
        <>
          {' '}
          <Link href={client.hrefFor('mine', problem.existingId)} className="font-semibold underline">See it</Link>
        </>
      )}
    </p>
  );
}

/** The form reads its client from context: the Access page's, or the public request page's (an outsider's entries carry no approvers, so that line hides). */
export function AskForm({ entries, savedGithub, email, onAsked, onAccountSaved, initialEntryId }: { entries: AskEntry[]; savedGithub?: string; email?: string; onAsked: () => void; onAccountSaved?: () => void; initialEntryId?: string }) {
  const client = useAccessClient();
  const outside = client.kind === 'outside';
  const [entryId, setEntryId] = useState(initialEntryId ?? '');
  const [duration, setDuration] = useState<number | null | undefined>();
  const [reason, setReason] = useState('');
  const [account, setAccount] = useState(savedGithub ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; existingId?: string }>();
  // The saved username arrives after the first render.
  useEffect(() => {
    setAccount((current) => current || savedGithub || '');
  }, [savedGithub]);

  const entry = entries.find((e) => e.id === entryId);
  const form = entry ? SYSTEM_FORM[entry.system] : undefined;
  const picked = entry && duration !== undefined && entry.durations.includes(duration) ? duration : entry?.durations.length === 1 ? entry.durations[0] : undefined;
  const ready = canAsk({ entry, durationMinutes: picked, reason, account });

  const pickEntry = (id: string) => {
    setEntryId(id);
    setDuration(undefined);
    setProblem(undefined);
  };

  const ask = async () => {
    if (!entry || picked === undefined) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const github = form?.account === 'github' ? account.trim() : undefined;
      await client.ask({ entryId: entry.id, durationMinutes: picked, reason: reason.trim(), ...(github && { account: github }) });
      setReason('');
      onAccountSaved?.();
      onAsked();
    } catch (e) {
      setProblem(requestProblem(e));
    } finally {
      setBusy(false);
    }
  };

  if (entries.length === 0) {
    return (
      <Card>
        <EmptyState icon={<KeyRound />} title="Nothing to ask for yet" hint={outside ? 'Nothing is open to ask for here yet. Check back later, or ask the person who sent you the link.' : 'An admin adds what can be requested in the Catalog. Check back once they have.'} />
      </Card>
    );
  }

  return (
    <Card className="max-w-[640px]">
      <form
        data-testid="access-ask"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void ask();
        }}
      >
        <div>
          <FieldLabel>What do you need?</FieldLabel>
          <Select aria-label="What do you need?" data-testid="access-entry" value={entryId} onChange={(e) => pickEntry(e.target.value)} className="max-md:h-11">
            <option value="">Choose…</option>
            {entries.map((e) => (
              <option key={e.id} value={e.id}>{e.name} · {SYSTEM_FORM[e.system].label}</option>
            ))}
          </Select>
          {entry && (
            <div className="mt-2 text-[13px] leading-snug text-t2">
              {entry.description && <p className="text-t1">{entry.description}</p>}
              <p>{entry.target.label} · {SYSTEM_FORM[entry.system].label}</p>
              {entry.approverNames && <p>Approved by {entry.approverNames.length ? entry.approverNames.join(', ') : 'an admin'}.</p>}
            </div>
          )}
        </div>
        {entry && (
          <>
            <div>
              <FieldLabel>For how long?</FieldLabel>
              <div role="radiogroup" aria-label="For how long?" className="flex flex-wrap gap-2">
                {entry.durations.map((minutes) => {
                  const on = picked === minutes;
                  return (
                    <button
                      key={String(minutes)}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      data-testid={`access-duration-${minutes === null ? 'unlimited' : minutes}`}
                      onClick={() => setDuration(minutes)}
                      className={cn('h-8 rounded-full border px-3.5 text-[13px] transition-colors max-md:h-11 max-md:px-4', on ? 'border-ac bg-acdim font-semibold text-t1' : 'border-hair text-t2 hover:border-ac hover:text-t1')}
                    >
                      {durationText(minutes)}
                    </button>
                  );
                })}
              </div>
            </div>
            {form?.account === 'github' && (
              <div>
                <FieldLabel>GitHub username</FieldLabel>
                <Input aria-label="GitHub username" data-testid="access-github" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="your-login" autoCapitalize="none" autoCorrect="off" className="max-md:h-11" />
                <p className="mt-1 text-[12px] text-t3">We keep it for next time. The approver sees it beside your name.</p>
              </div>
            )}
            {form?.account === 'google' && <p className="text-[13px] text-t2">{outside ? 'Goes to the email you signed in with' : 'Goes to your Landflow email'}{email ? `, ${email}` : ''}.</p>}
            <div>
              <FieldLabel>Why do you need it?</FieldLabel>
              <Textarea aria-label="Why do you need it?" data-testid="access-reason" rows={3} maxLength={ACCESS_LIMITS.reasonChars[1]} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="On call for the platform team this week" />
            </div>
          </>
        )}
        {problem && <AskProblem problem={problem} />}
        <div>
          <Button type="submit" variant="primary" loading={busy} disabled={!ready} data-testid="access-ask-go" className="max-md:h-11 max-md:w-full">Ask</Button>
        </div>
      </form>
    </Card>
  );
}
