'use client';
/**
 * To decide: the waiting requests the viewer may approve, each as the Ask a Person card (the same as in Needs you) with the duration
 * select, a comment, Approve and Reject. The answer goes to the request's own decision route, so an approver who can't open the flow's
 * project still decides. The question text is the server's own (target, permission, the GitHub username marked unverified), never rebuilt in the browser, and so are the durations.
 */
import { CheckCheck } from 'lucide-react';
import { accessApi, useLoaded } from '@/lib/client/access';
import { durationText, forDuration, type AccessEntryView, type AccessRequestView } from '@/lib/shared/access';
import { Card } from '../shell/page-header';
import { ConfirmCard } from '../run-trace/confirm-card';
import { EmptyState } from '../ui/empty-state';

export function DecideList({ requests, onDecided }: { requests: AccessRequestView[]; onDecided: () => void }) {
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
          request={{ title: request.question?.title ?? `Give ${request.requester.name} ${request.entryName} ${forDuration(request.durationMinutes)}?`, text: request.question?.text ?? '', allowEdit: false, approvers: request.approverNames, choices: request.choices }}
          decide={async (body) => {
            await accessApi.decide(request.id, { approved: body.approved, ...(body.choice && { choice: body.choice }), ...(body.comment && { comment: body.comment }) });
          }}
          onDecided={onDecided}
        />
      ))}
    </div>
  );
}

export function DecideView({ onDecided, tick }: { entries?: AccessEntryView[]; onDecided: () => void; approver?: boolean; tick?: number }) {
  const { data, error, reload } = useLoaded(() => accessApi.requests('decide'), [tick]);
  if (error && !data) return <Card><EmptyState title="Requests not available" hint={error} /></Card>;
  if (!data) return <p className="text-[13px] text-t3">Loading…</p>;
  return (
    <DecideList
      requests={data.items}
      onDecided={() => {
        void reload();
        onDecided();
      }}
    />
  );
}
