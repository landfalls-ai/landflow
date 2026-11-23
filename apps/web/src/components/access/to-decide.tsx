'use client';
/**
 * To decide: the waiting requests the viewer may approve, each as the Ask a Person card (the same as in Needs you) with the duration
 * select, a comment, Approve and Reject. The answer goes to the request's own decision route, so an approver who can't open the flow's
 * project still decides. A GitHub username is shown as unverified: the requester typed it and nobody has checked it is theirs.
 */
import { CheckCheck } from 'lucide-react';
import { accessApi, choicesFor, useLoaded } from '@/lib/client/access';
import { durationText, type AccessEntryView, type AccessRequestView } from '@/lib/shared/access';
import { Card } from '../shell/page-header';
import { ConfirmCard } from '../run-trace/confirm-card';
import { EmptyState } from '../ui/empty-state';

/** What the approver reads: who, what, how long, why, and the account to grant to. */
export function requestText(request: AccessRequestView): string {
  const lines = [`${request.requester.name} asks for ${request.entryName} for ${durationText(request.durationMinutes)}.`, `Why: ${request.reason}`];
  if (request.account) lines.push(request.system.startsWith('github') ? `GitHub username: ${request.account} (unverified: they typed it)` : `Account: ${request.account}`);
  return lines.join('\n');
}

export function DecideList({ requests, entries, onDecided }: { requests: AccessRequestView[]; entries: AccessEntryView[]; onDecided: () => void }) {
  const mine = requests.filter((r) => r.canDecide);
  if (mine.length === 0) {
    return (
      <Card>
        <EmptyState icon={<CheckCheck />} title="Nothing waits for you" hint="When someone asks for something you approve, it shows here and in Needs you." />
      </Card>
    );
  }
  return (
    <div className="flex max-w-[760px] flex-col gap-3" data-testid="access-decide">
      {mine.map((request) => (
        <ConfirmCard
          key={request.id}
          executionId={request.executionId ?? ''}
          nodeName={request.entryName}
          since={request.createdAt}
          request={{ title: `Give ${request.requester.name} ${request.entryName} for ${durationText(request.durationMinutes)}?`, text: requestText(request), allowEdit: false, approvers: request.approverNames, choices: choicesFor(request, entries.find((e) => e.id === request.entryId)) }}
          decide={async (body) => {
            await accessApi.decide(request.id, { approved: body.approved, ...(body.choice && { choice: body.choice }), ...(body.comment && { comment: body.comment }) });
          }}
          onDecided={onDecided}
        />
      ))}
    </div>
  );
}

export function DecideView({ entries, onDecided }: { entries: AccessEntryView[]; onDecided: () => void; approver?: boolean }) {
  const { data, error, reload } = useLoaded(() => accessApi.requests('decide'));
  if (error && !data) return <Card><EmptyState title="Requests not available" hint={error} /></Card>;
  if (!data) return <p className="text-[13px] text-t3">Loading…</p>;
  return (
    <DecideList
      requests={data.items}
      entries={entries}
      onDecided={() => {
        void reload();
        onDecided();
      }}
    />
  );
}
