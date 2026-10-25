'use client';
/** Where a polling trigger stands: interval, last poll, new items, errors, and "Poll now". */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { RadioTower, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { PollStatus as Status } from '@/lib/shared/types';
import { Button } from '../ui/button';

export function PollStatus({ workflowId, nodeId, active, dirty, interval }: { workflowId: string; nodeId: string; active: boolean; dirty: boolean; interval: number }) {
  const [status, setStatus] = useState<Status>();
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string>();
  const [, tick] = useState(0);

  useEffect(() => {
    if (!active) return;
    const load = () =>
      api<{ polls: Status[] }>(`/api/workflows/${workflowId}/polls`)
        .then((r) => setStatus(r.polls.find((p) => p.nodeId === nodeId)))
        .catch(() => {});
    void load();
    const timer = setInterval(() => {
      void load();
      tick((n) => n + 1);
    }, 5_000);
    return () => clearInterval(timer);
  }, [workflowId, nodeId, active]);

  const pollNow = async () => {
    setPolling(true);
    setError(undefined);
    try {
      setStatus((await api<{ poll: Status }>(`/api/workflows/${workflowId}/polls`, { method: 'POST', json: { nodeId } })).poll);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPolling(false);
    }
  };

  const seconds = Math.max(10, interval || 60);
  const next = status?.nextPollAt ? Math.max(0, Math.round((Date.parse(status.nextPollAt) - Date.now()) / 1000)) : undefined;
  return (
    <div className={cn('mb-5 rounded-[10px] border px-3 py-2.5 text-[12px]', status?.lastError ? 'border-rdbd bg-rddim' : 'border-hair bg-wl')}>
      <div className="flex items-center gap-2">
        <RadioTower className={cn('size-3.5 shrink-0', active ? 'text-gn' : 'text-t3', active && polling && 'animate-pulse')} />
        <span className="min-w-0 flex-1 text-t2">
          {!active ? (
            <>Checks for new items every {seconds} s once the workflow is published. Execute the node to fetch the latest ones now.</>
          ) : !status || status.baseline ? (
            <>Polling every {seconds} s · the first poll sets the baseline, later polls start a run for each batch of new items.</>
          ) : (
            <>
              Every {status.intervalSeconds} s · last poll {timeAgo(status.lastPolledAt)}
              {status.lastItems !== undefined && <> · {status.lastItems} new</>}
              {next !== undefined && <> · next in {next} s</>}
              {status.lastExecutionId && (
                <>
                  {' · '}
                  <Link href={`/workflows/${workflowId}/executions/${status.lastExecutionId}`} className="text-t1 underline-offset-2 hover:text-ac hover:underline">
                    last run
                  </Link>
                </>
              )}
            </>
          )}
        </span>
        {active && (
          <Button size="sm" variant="ghost" onClick={pollNow} loading={polling} disabled={dirty} title={dirty ? 'Save the workflow first: the poller uses the saved version' : 'Poll now instead of waiting for the interval'}>
            {!polling && <RefreshCw className="size-3" />} Poll now
          </Button>
        )}
      </div>
      {(status?.lastError || error) && <div className="mt-1.5 break-words font-mono text-[11px] text-rd">{error ?? status?.lastError}</div>}
    </div>
  );
}
